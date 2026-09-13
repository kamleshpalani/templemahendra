<?php
/**
 * backend/includes/notify/reminders.php — the evening-before reminders the
 * worker creates on its own (SPEC §5.9).
 *
 * After 17:00 temple time, for tomorrow in the temple's calendar:
 *
 *   • each confirmed seva booking → booking.reminder to the devotee who booked
 *     it (or to the phone on the booking when no account made it);
 *   • each active event and pooja → one automatic, already-approved campaign
 *     to every devotee who has not muted that category. Expansion then handles
 *     scale exactly as it does for a committee campaign.
 *
 * Both are idempotent: bookings through the event's dedupe key, broadcasts
 * through the reminderKey stored in the campaign's template_vars. The worker
 * looks at most once every 15 minutes.
 */

require_once __DIR__ . '/campaigns.php';

const NOTIFY_REMINDER_HOUR = 17;

/** Run reminders unless they ran in the last 15 minutes. A test clock always runs them and leaves the marker alone. */
function notifyRemindersMaybeRun(bool $testClock = false): int
{
    $now = notifyNow();
    if (!$testClock) {
        $last = notifyKvGet('reminders_last_run');
        // A marker in the future (a clock that jumped back) does not block reminders.
        if ($last !== null && $last <= $now && strtotime($now . ' UTC') - strtotime($last . ' UTC') < 900) return 0;
        notifyKvSet('reminders_last_run', $now);
    }
    return notifyRemindersRun($now);
}

/** Create tomorrow's reminders, if it is past five in the evening at the temple. Returns how many were created. */
function notifyRemindersRun(string $nowUtc): int
{
    if (!notifyTablesExist()) return 0;
    $local = notifyFromUtc($nowUtc, notifyTempleTz());
    if ((int) substr($local, 11, 2) < NOTIFY_REMINDER_HOUR) return 0;
    $tomorrow = (new DateTimeImmutable(substr($local, 0, 10), new DateTimeZone('UTC')))->modify('+1 day')->format('Y-m-d');

    $created = 0;
    $created += notifyRemindBookings($tomorrow);
    $created += notifyRemindBroadcast('event', $tomorrow);
    $created += notifyRemindBroadcast('pooja', $tomorrow);
    return $created;
}

/** "20 செப்டம்பர் 2026" / "20 Sep 2026" */
function notifyFormatDate(string $ymd, string $lang): string
{
    if (!isValidDate($ymd)) return $ymd;
    [$y, $m, $d] = array_map('intval', explode('-', $ymd));
    if ($lang === 'ta') {
        $months = ['ஜனவரி', 'பிப்ரவரி', 'மார்ச்', 'ஏப்ரல்', 'மே', 'ஜூன்', 'ஜூலை', 'ஆகஸ்ட்', 'செப்டம்பர்', 'அக்டோபர்', 'நவம்பர்', 'டிசம்பர்'];
        return $d . ' ' . $months[$m - 1] . ' ' . $y;
    }
    return gmdate('j M Y', (int) gmmktime(12, 0, 0, $m, $d, $y));
}

/** "07:00 AM" as stored on a pooja → "காலை 7:00" / "7:00 am". Unrecognised text is returned as it is. */
function notifyFormatClock(?string $text, string $lang): string
{
    $s = trim((string) $text);
    if (!preg_match('/^(\d{1,2})[:.](\d{2})\s*([AaPp][Mm])?$/', $s, $m)) return $s;
    $h = (int) $m[1];
    $min = $m[2];
    if (isset($m[3]) && $m[3] !== '') {
        $pm = strtolower($m[3]) === 'pm';
        if ($h === 12) $h = $pm ? 12 : 0;
        elseif ($pm) $h += 12;
    }
    if ($h > 23) return $s;
    $h12 = $h % 12 === 0 ? 12 : $h % 12;
    if ($lang === 'ta') {
        $part = $h < 12 ? 'காலை' : ($h < 16 ? 'மதியம்' : ($h < 19 ? 'மாலை' : 'இரவு'));
        return $part . ' ' . $h12 . ':' . $min;
    }
    return $h12 . ':' . $min . ' ' . ($h < 12 ? 'am' : 'pm');
}

/** The booking number devotees see: SB-<id>. Shared so reminders and confirmations agree. */
function notifyBookingNumber(int $bookingId): string
{
    return 'SB-' . $bookingId;
}

/** booking.reminder for every confirmed booking on $date. */
function notifyRemindBookings(string $date): int
{
    $stmt = getDB()->prepare(
        "SELECT b.id, b.devotee_id, b.devotee_name, b.phone, b.phone_country, b.seva_name, b.preferred_date,
                s.name_ta, s.name_en, p.lang AS pref_lang
           FROM seva_bookings b
           LEFT JOIN sevas s ON s.id = b.seva_id
           LEFT JOIN devotee_notification_prefs p ON p.devotee_id = b.devotee_id
          WHERE b.status = 'confirmed' AND b.preferred_date = :d
          ORDER BY b.id LIMIT 5000"
    );
    $stmt->execute([':d' => $date]);

    $created = 0;
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $b) {
        $lang = $b['devotee_id'] !== null ? (string) ($b['pref_lang'] ?: 'ta') : 'ta';
        $l    = $lang === 'ta' ? 'ta' : 'en';
        $seva = $l === 'ta' ? ($b['name_ta'] ?: $b['seva_name']) : ($b['name_en'] ?: $b['seva_name']);
        $ctx  = [
            'entity_id'  => (int) $b['id'],
            'vars'       => [
                'bookingNumber' => notifyBookingNumber((int) $b['id']),
                'sevaName'      => (string) $seva,
                'bookingDate'   => notifyFormatDate((string) $b['preferred_date'], $l),
                'devoteeName'   => (string) $b['devotee_name'],
            ],
            // The catalogue's key with the ISO date, so a devotee who changes
            // language between two worker runs is still reminded once.
            'dedupe_key' => 'booking:' . (int) $b['id'] . ':reminder:' . $b['preferred_date'],
        ];
        if ($b['devotee_id'] !== null) {
            $ctx['devotee_id'] = (int) $b['devotee_id'];
        } else {
            $digits = preg_replace('/\D+/', '', (string) $b['phone']) ?? '';
            // Bookings from before international numbers were stored as ten Indian digits.
            if (strlen($digits) === 10 && in_array($b['phone_country'], [null, '', 'IN'], true)) $digits = '91' . $digits;
            if (strlen($digits) < 7) continue;
            $ctx['to_phone'] = $digits;
            $ctx['name']     = (string) $b['devotee_name'];
            $ctx['lang']     = 'ta';
        }
        $r = notifyEvent('booking.reminder', $ctx);
        if ($r['id'] !== null && !$r['deduped']) $created++;
    }
    return $created;
}

/** One automatic campaign per active event or pooja on $date. */
function notifyRemindBroadcast(string $kind, string $date): int
{
    $db = getDB();
    if (notifyCategory($kind) === null) {
        error_log("[notify] no \"{$kind}\" category; {$kind} reminders skipped");
        return 0;
    }
    $rows = $kind === 'event'
        ? $db->prepare('SELECT id, title_ta, title_en, description, event_date AS day FROM events WHERE is_active = 1 AND event_date = :d ORDER BY id LIMIT 50')
        : $db->prepare('SELECT id, name_ta AS title_ta, name_en AS title_en, description_ta, description_en, pooja_date AS day, pooja_time FROM poojas WHERE is_active = 1 AND pooja_date = :d ORDER BY id LIMIT 50');
    $rows->execute([':d' => $date]);

    $facts = [];
    foreach (['ta', 'en'] as $l) $facts[$l] = notifyFactVars($l);

    $created = 0;
    foreach ($rows->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $key = $kind . ':' . (int) $row['id'] . ':' . $date;
        $exists = $db->prepare(
            "SELECT id FROM notification_campaigns WHERE JSON_UNQUOTE(JSON_EXTRACT(template_vars, '$.reminderKey')) = :k LIMIT 1"
        );
        $exists->execute([':k' => $key]);
        if ($exists->fetchColumn() !== false) continue;

        $titleTa = trim((string) ($row['title_ta'] ?: $row['title_en']));
        $titleEn = trim((string) ($row['title_en'] ?: $row['title_ta']));
        $dateTa  = notifyFormatDate($date, 'ta');
        $dateEn  = notifyFormatDate($date, 'en');
        $place   = [
            'ta' => (string) ($facts['ta']['templeShortName'] ?? $facts['ta']['templeName'] ?? ''),
            'en' => (string) ($facts['en']['templeShortName'] ?? $facts['en']['templeName'] ?? ''),
        ];

        if ($kind === 'event') {
            $vars = ['reminderKey' => $key, 'eventName' => ['ta' => $titleTa, 'en' => $titleEn],
                     'eventDate' => ['ta' => $dateTa, 'en' => $dateEn], 'eventLocation' => $place];
            $translations = [
                'ta' => ['title' => $titleTa, 'body' => "நாளை ({$dateTa}) {$titleTa} நடைபெறுகிறது. குடும்பத்துடன் வருக."],
                'en' => ['title' => $titleEn, 'body' => "{$titleEn} is tomorrow, {$dateEn}. Do join us with your family."],
            ];
            $template = 'event_reminder';
            $cta = '/events';
        } else {
            $timeTa = notifyFormatClock($row['pooja_time'] ?? null, 'ta');
            $timeEn = notifyFormatClock($row['pooja_time'] ?? null, 'en');
            $vars = ['reminderKey' => $key, 'poojaName' => ['ta' => $titleTa, 'en' => $titleEn],
                     'poojaDate' => ['ta' => $dateTa, 'en' => $dateEn], 'poojaTime' => ['ta' => $timeTa, 'en' => $timeEn]];
            $translations = [
                'ta' => ['title' => $titleTa, 'body' => trim("நாளை ({$dateTa}) {$timeTa} {$titleTa} நடைபெறுகிறது.")],
                'en' => ['title' => $titleEn, 'body' => trim("{$titleEn} is tomorrow, {$dateEn}" . ($timeEn !== '' ? " at {$timeEn}" : '') . '.')],
            ];
            $template = 'pooja_reminder';
            $cta = '/events';
        }
        $audience = ['mode' => 'rules', 'match' => 'all', 'rules' => [['field' => 'category_not_muted', 'op' => 'is', 'value' => $kind]]];
        $now = notifyNow();

        $db->beginTransaction();
        try {
            $db->prepare(
                "INSERT INTO notification_campaigns
                    (name, category, priority, channels, cta_url, template_key, template_vars, audience, estimated_count,
                     status, requires_approval, schedule_tz, scheduled_at, next_run_at, recurrence,
                     created_by, updated_by, submitted_by, submitted_at, approved_by, approved_at, created_at, updated_at)
                 VALUES (:name, :category, 'normal', 'inapp,push', :cta, :tkey, :tvars, :audience, :estimate,
                     'approved', 0, 'temple', :now1, :now2, 'none',
                     'system', 'system', 'system', :now3, 'system', :now4, :now5, :now6)"
            )->execute([
                ':name' => mb_substr('Reminder: ' . $titleEn . ' (automatic)', 0, 160), ':category' => $kind, ':cta' => $cta,
                ':tkey' => $template, ':tvars' => json_encode($vars, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                ':audience' => json_encode($audience), ':estimate' => notifyAudienceCount($audience),
                ':now1' => $now, ':now2' => $now, ':now3' => $now, ':now4' => $now, ':now5' => $now, ':now6' => $now,
            ]);
            $campaignId = (int) $db->lastInsertId();
            $ins = $db->prepare('INSERT INTO notification_campaign_translations (campaign_id, lang, title, body, cta_label) VALUES (:c, :l, :t, :b, NULL)');
            foreach ($translations as $l => $t) {
                $ins->execute([':c' => $campaignId, ':l' => $l, ':t' => mb_substr($t['title'], 0, 200), ':b' => $t['body']]);
            }
            $db->commit();
        } catch (Throwable $e) {
            if ($db->inTransaction()) $db->rollBack();
            error_log("[notify] creating the {$kind} reminder for {$key} failed: " . $e->getMessage());
            continue;
        }
        notifyAudit($campaignId, 'created', notifySystemActor(), ['automatic' => 'reminder', 'reminderKey' => $key]);
        $created++;
    }
    return $created;
}
