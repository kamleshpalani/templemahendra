<?php
/**
 * backend/includes/live/validate.php — one validator for the admin page and
 * the admin JSON API (docs/live/SPEC-PHASE1.md §4.2).
 *
 * liveValidate() takes the submitted fields under their input names
 * (title_ta, provider_reference, scheduled_date, start_time, …) and returns the
 * column values a store call can write, plus a field => message map. Nothing
 * here throws for bad input: a non-string, an oversized text, "9999-99-99", a
 * javascript: link or an illegal status jump is a message against its field,
 * and the caller re-renders with what was typed.
 *
 * Missing keys mean "unchanged" on an update and "the default" on a create, so
 * the JSON API can PUT a partial body while the page always sends every field.
 */

/** The input keys liveValidate() reads (the page inputs and the JSON body). */
const LIVE_INPUT_KEYS = [
    'title_ta', 'title_en', 'description_ta', 'description_en', 'slug', 'temple_id', 'deity_id',
    'event_type', 'provider', 'provider_reference', 'playback_url', 'thumbnail_url', 'banner_url',
    'scheduled_date', 'start_time', 'end_time', 'end_date', 'timezone', 'status',
    'is_featured', 'show_on_homepage', 'donations_enabled', 'notifications_enabled', 'sharing_enabled', 'archive_enabled',
];

/** The six checkbox flags and their defaults on a new stream. */
const LIVE_FLAG_DEFAULTS = [
    'is_featured'           => 0,
    'show_on_homepage'      => 0,
    'donations_enabled'     => 1,
    'notifications_enabled' => 1,
    'sharing_enabled'       => 1,
    'archive_enabled'       => 1,
];

/** A checkbox value: true, 1, "1", "true" or "on" mean yes; anything else (arrays included) no. */
function liveFlag(mixed $value): bool
{
    return $value === true || $value === 1 || $value === '1' || $value === 'true' || $value === 'on';
}

/**
 * A stored row as the form would submit it, so an update can merge a partial
 * body over it and the page can re-fill its inputs.
 */
function liveRowToInput(array $row): array
{
    $tz    = (string) ($row['timezone'] ?? liveTempleTz());
    $start = liveLocalParts($row['scheduled_start_at'] ?? null, $tz);
    $end   = liveLocalParts($row['scheduled_end_at'] ?? null, $tz);
    $in = [
        'title_ta'           => (string) ($row['title_ta'] ?? ''),
        'title_en'           => (string) ($row['title_en'] ?? ''),
        'description_ta'     => (string) ($row['description_ta'] ?? ''),
        'description_en'     => (string) ($row['description_en'] ?? ''),
        'slug'               => (string) ($row['slug'] ?? ''),
        'temple_id'          => (string) (int) ($row['temple_id'] ?? 0),
        'deity_id'           => isset($row['deity_id']) && (int) $row['deity_id'] > 0 ? (string) (int) $row['deity_id'] : '',
        'event_type'         => (string) ($row['event_type'] ?? 'live_darshan'),
        'provider'           => (string) ($row['provider'] ?? 'youtube'),
        'provider_reference' => (string) ($row['provider_broadcast_id'] ?? ''),
        'playback_url'       => (string) ($row['playback_url'] ?? ''),
        'thumbnail_url'      => (string) ($row['thumbnail_url'] ?? ''),
        'banner_url'         => (string) ($row['banner_url'] ?? ''),
        'scheduled_date'     => (string) ($start['date'] ?? ''),
        'start_time'         => (string) ($start['time'] ?? ''),
        'end_time'           => (string) ($end['time'] ?? ''),
        'end_date'           => $end['date'] !== null && $end['date'] !== $start['date'] ? (string) $end['date'] : '',
        'timezone'           => $tz,
        'status'             => (string) ($row['status'] ?? 'DRAFT'),
    ];
    foreach (LIVE_FLAG_DEFAULTS as $flag => $default) {
        $in[$flag] = !empty($row[$flag]) ? '1' : '0';
    }
    return $in;
}

/**
 * Validate a submission. $existing is the stored row (liveLoad) on an update,
 * null on a create.
 *
 * @return array{values: array, errors: array<string, string>}
 */
function liveValidate(array $in, ?array $existing, PDO $db): array
{
    $errors = [];
    $values = [];
    $isCreate = $existing === null;
    $base = $isCreate ? [] : liveRowToInput($existing);

    // A key that is present but not text (an array, an object) is a field
    // error, never a fatal: the message says what was expected.
    $text = static function (string $key) use ($in, $base, &$errors): ?string {
        if (!array_key_exists($key, $in)) return array_key_exists($key, $base) ? (string) $base[$key] : null;
        $v = $in[$key];
        if ($v === null) return '';
        if (is_bool($v)) return $v ? '1' : '';
        if (is_int($v) || is_float($v)) return (string) $v;
        if (is_string($v)) return trim($v);
        $errors[$key] = 'Enter text here.';
        return null;
    };

    // ── Titles and descriptions ───────────────────────────────────────────
    foreach (['title_ta' => 'Tamil title', 'title_en' => 'English title'] as $key => $label) {
        $raw = $text($key);
        if ($raw === null) { if (!isset($errors[$key])) $errors[$key] = 'Enter the ' . $label . '.'; $values[$key] = ''; continue; }
        $clean = sanitizeText($raw, 400);
        $len   = mb_strlen($clean);
        if ($len < 2)        $errors[$key] = 'Enter the ' . $label . ' (2 to 300 characters).';
        elseif ($len > 300)  $errors[$key] = 'Keep the ' . $label . ' under 300 characters.';
        $values[$key] = mb_substr($clean, 0, 300);
    }
    foreach (['description_ta' => 'Tamil description', 'description_en' => 'English description'] as $key => $label) {
        $raw = $text($key);
        if ($raw === null) { $values[$key] = null; continue; }
        $clean = sanitizeText($raw, 6000);
        if (mb_strlen($clean) > 5000) $errors[$key] = 'Keep the ' . $label . ' under 5000 characters.';
        $values[$key] = $clean === '' ? null : mb_substr($clean, 0, 5000);
    }

    // ── Temple and deity ──────────────────────────────────────────────────
    $templeRaw = $text('temple_id');
    $templeId  = $templeRaw !== null && preg_match('/^\d{1,10}$/', $templeRaw) ? (int) $templeRaw : 0;
    $temple    = null;
    if ($templeId > 0) {
        $stmt = $db->prepare('SELECT id, timezone FROM temples WHERE id = :id AND is_active = 1');
        $stmt->execute([':id' => $templeId]);
        $temple = $stmt->fetch() ?: null;
    }
    if ($temple === null && !isset($errors['temple_id'])) $errors['temple_id'] = 'Choose a temple.';
    $values['temple_id'] = $temple !== null ? (int) $temple['id'] : 0;

    $deityRaw = $text('deity_id');
    $deityId  = $deityRaw !== null && preg_match('/^\d{1,10}$/', $deityRaw) ? (int) $deityRaw : 0;
    $values['deity_id'] = null;
    if ($deityRaw !== null && $deityRaw !== '' && $deityRaw !== '0' && $deityId === 0 && !isset($errors['deity_id'])) {
        $errors['deity_id'] = 'Choose a deity of this temple.';
    } elseif ($deityId > 0) {
        $stmt = $db->prepare('SELECT id FROM deities WHERE id = :id AND is_active = 1 AND temple_id = :t');
        $stmt->execute([':id' => $deityId, ':t' => $values['temple_id']]);
        if ($stmt->fetchColumn() === false) $errors['deity_id'] = 'Choose a deity of this temple.';
        else $values['deity_id'] = $deityId;
    }

    // ── Programme type, provider, reference ───────────────────────────────
    $eventType = $text('event_type');
    if ($eventType === null || $eventType === '') $eventType = $isCreate ? 'live_darshan' : (string) ($base['event_type'] ?? 'live_darshan');
    if (!isset(LIVE_EVENT_TYPES[$eventType])) { if (!isset($errors['event_type'])) $errors['event_type'] = 'Choose a programme type.'; $eventType = 'live_darshan'; }
    $values['event_type'] = $eventType;

    $provider = $text('provider');
    if ($provider === null || $provider === '') $provider = $isCreate ? 'youtube' : (string) ($base['provider'] ?? 'youtube');
    $provider = strtolower($provider);
    if (!isset(LIVE_PROVIDERS[$provider])) {
        if (!isset($errors['provider'])) $errors['provider'] = 'Choose a provider.';
        $provider = 'youtube';
    } elseif (!in_array($provider, LIVE_SAVABLE_PROVIDERS, true)) {
        $errors['provider'] = 'This provider is not available yet.';
    }
    $values['provider'] = $provider;

    // ── Status (needed before the reference and schedule rules) ───────────
    $status = $text('status');
    if ($status === null || $status === '') $status = $isCreate ? 'DRAFT' : (string) ($base['status'] ?? 'DRAFT');
    $status = strtoupper($status);
    if (!liveIsStatus($status)) {
        if (!isset($errors['status'])) $errors['status'] = 'Choose a status.';
        $status = $isCreate ? 'DRAFT' : (string) ($base['status'] ?? 'DRAFT');
    } elseif ($isCreate && !in_array($status, LIVE_CREATE_STATUSES, true)) {
        $errors['status'] = 'A new stream starts as Draft or Scheduled.';
    } elseif (!$isCreate && $status !== (string) $existing['status'] && !liveTransitionAllowed((string) $existing['status'], $status)) {
        $errors['status'] = 'That status change is not allowed.';
    }
    $values['status'] = $status;
    $isDraft = $status === 'DRAFT';

    $reference = $text('provider_reference');
    $values['provider_broadcast_id'] = null;
    if ($reference !== null) {
        if ($reference !== '') {
            $parsed = liveProviderFor($provider)->parseReference($reference);
            if ($parsed === null) {
                $errors['provider_reference'] = $provider === 'youtube'
                    ? 'That is not a YouTube video ID or link.'
                    : 'That reference is too long or not text.';
            } else {
                $values['provider_broadcast_id'] = mb_substr($parsed, 0, 100);
            }
        }
    }
    if ($provider === 'youtube' && !$isDraft && $values['provider_broadcast_id'] === null && !isset($errors['provider_reference'])) {
        $errors['provider_reference'] = 'Enter the YouTube video ID or link before publishing.';
    }

    // ── Links ─────────────────────────────────────────────────────────────
    foreach (['playback_url', 'thumbnail_url', 'banner_url'] as $key) {
        $raw = $text($key);
        $values[$key] = null;
        if ($raw === null || $raw === '') continue;
        $safe = liveSafeUrl($raw);
        if ($safe === null) $errors[$key] = 'Enter a site path (/uploads/…) or an https:// address.';
        else $values[$key] = $safe;
    }
    if ($provider === 'custom' && !$isDraft && $values['playback_url'] === null && !isset($errors['playback_url'])) {
        $errors['playback_url'] = 'Enter the playback URL before publishing.';
    }

    // ── Schedule ──────────────────────────────────────────────────────────
    $tz = $text('timezone');
    if ($tz === null || $tz === '') $tz = $isCreate ? (string) ($temple['timezone'] ?? liveTempleTz()) : (string) ($base['timezone'] ?? liveTempleTz());
    if (!liveIsTimezone($tz)) {
        if (!isset($errors['timezone'])) $errors['timezone'] = 'Choose a time zone from the list.';
        $tz = liveTempleTz();
    }
    $values['timezone'] = $tz;

    $date  = $text('scheduled_date') ?? '';
    $start = $text('start_time') ?? '';
    $endT  = $text('end_time') ?? '';
    $endD  = $text('end_date') ?? '';
    $timeRe = '/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/';
    $values['scheduled_start_at'] = null;
    $values['scheduled_end_at']   = null;

    if ($date !== '' && !isValidDate($date)) $errors['scheduled_date'] = 'Enter a valid date (YYYY-MM-DD).';
    if ($start !== '' && !preg_match($timeRe, $start)) $errors['start_time'] = 'Enter a valid time (HH:MM).';
    if ($endT !== '' && !preg_match($timeRe, $endT)) $errors['end_time'] = 'Enter a valid time (HH:MM).';
    if ($endD !== '' && !isValidDate($endD)) $errors['end_date'] = 'Enter a valid date (YYYY-MM-DD).';

    if ($date === '' && $start === '') {
        if (!$isDraft) $errors['scheduled_date'] = 'Enter the date and start time before publishing.';
    } elseif ($date === '' && !isset($errors['scheduled_date'])) {
        $errors['scheduled_date'] = 'Enter the date.';
    } elseif ($start === '' && !isset($errors['start_time'])) {
        $errors['start_time'] = 'Enter the start time.';
    }
    if ($date !== '' && $start !== '' && !isset($errors['scheduled_date']) && !isset($errors['start_time']) && !isset($errors['timezone'])) {
        $utc = liveToUtc($date . ' ' . $start, $tz);
        if ($utc === null) $errors['scheduled_date'] = 'Enter a valid date and time.';
        else $values['scheduled_start_at'] = $utc;
    }
    if ($endT !== '' && !isset($errors['end_time']) && !isset($errors['end_date'])) {
        if ($values['scheduled_start_at'] === null) {
            if (!isset($errors['start_time']) && !isset($errors['scheduled_date'])) $errors['start_time'] = 'Enter the start time before an end time.';
        } else {
            $endUtc = liveToUtc(($endD !== '' ? $endD : $date) . ' ' . $endT, $tz);
            if ($endUtc === null) $errors['end_time'] = 'Enter a valid end date and time.';
            elseif ($endUtc <= $values['scheduled_start_at']) $errors['end_time'] = 'The end must be after the start.';
            else $values['scheduled_end_at'] = $endUtc;
        }
    } elseif ($endT === '' && $endD !== '' && !isset($errors['end_date'])) {
        $errors['end_time'] = 'Enter the end time as well, or clear the end date.';
    }

    // ── Flags ─────────────────────────────────────────────────────────────
    foreach (LIVE_FLAG_DEFAULTS as $flag => $default) {
        if (array_key_exists($flag, $in)) $values[$flag] = liveFlag($in[$flag]) ? 1 : 0;
        elseif (!$isCreate)               $values[$flag] = !empty($existing[$flag]) ? 1 : 0;
        else                              $values[$flag] = $default;
    }

    // ── Slug (last: it may be made from the English title) ────────────────
    $slugRaw = $text('slug');
    $exceptId = $isCreate ? null : (int) $existing['id'];
    if ($slugRaw === null) {
        $values['slug'] = $isCreate ? '' : (string) $existing['slug'];
    } elseif ($slugRaw === '') {
        $values['slug'] = $isCreate ? '' : (string) $existing['slug'];
    } else {
        $slug = strtolower($slugRaw);
        if (!$isCreate && (string) $existing['status'] !== 'DRAFT' && $slug !== strtolower((string) $existing['slug'])) {
            // Share links must keep working: once a stream has been published
            // (anything but DRAFT) its address is fixed, on the page and in the API.
            $errors['slug'] = 'The address is locked after publishing.';
            $slug = strtolower((string) $existing['slug']);
        } elseif (!preg_match(LIVE_SLUG_RE, $slug)) {
            $errors['slug'] = 'Use lowercase letters, numbers and hyphens (2 to 120 characters, not digits only).';
        } elseif (in_array($slug, LIVE_RESERVED_SLUGS, true)) {
            $errors['slug'] = 'That address is reserved.';
        } elseif (!liveSlugFree($db, $slug, $exceptId)) {
            $errors['slug'] = 'That address is already used by another stream.';
        }
        $values['slug'] = $slug;
    }
    if ($values['slug'] === '' && !isset($errors['slug'])) {
        $values['slug'] = liveUniqueSlug($db, liveSlugify((string) $values['title_en']), $exceptId);
    }

    return ['values' => $values, 'errors' => $errors];
}

/**
 * A slug from an English title: lowercase ASCII letters, digits and single
 * hyphens, at most 120 characters. Anything that leaves nothing behind (a
 * title typed in Tamil) becomes "stream"; a title that is only digits
 * ("2027") gets "-darshan" appended, since a run of digits in the URL is an
 * id; the caller makes it unique.
 */
function liveSlugify(string $title): string
{
    $s = strtolower(trim($title));
    $s = preg_replace('/[^a-z0-9]+/', '-', $s) ?? '';
    $s = trim($s, '-');
    $s = preg_replace('/-{2,}/', '-', $s) ?? '';
    if ($s !== '' && preg_match('/^[0-9]+$/', $s)) $s .= '-darshan';
    if (strlen($s) > 120) $s = rtrim(substr($s, 0, 120), '-');
    if (strlen($s) < 2 || !preg_match(LIVE_SLUG_RE, $s)) $s = 'stream';
    return $s;
}

/**
 * True when a stored row has what a public status needs: a start time and,
 * for YouTube, a video id (for a custom provider, a playback URL). The row
 * menu offers Publish / Starting soon / Go live only then, and
 * liveSetStatus() refuses those targets otherwise (§2).
 */
function liveReadyToPublish(array $row): bool
{
    if (empty($row['scheduled_start_at'])) return false;
    $provider = (string) ($row['provider'] ?? 'youtube');
    if ($provider === 'custom') return !empty($row['playback_url']);
    return !empty($row['provider_broadcast_id']);
}

/** True when no other stream (deleted ones included) uses this slug, case-folded. */
function liveSlugFree(PDO $db, string $slug, ?int $exceptId): bool
{
    $stmt = $db->prepare('SELECT id FROM live_streams WHERE LOWER(slug) = LOWER(:s)' . ($exceptId !== null ? ' AND id <> :id' : '') . ' LIMIT 1');
    $params = [':s' => $slug];
    if ($exceptId !== null) $params[':id'] = $exceptId;
    $stmt->execute($params);
    return $stmt->fetchColumn() === false;
}

/**
 * $slug, or $slug-2, $slug-3 … until one is free and not reserved. Never
 * longer than 120 characters.
 */
function liveUniqueSlug(PDO $db, string $slug, ?int $exceptId): string
{
    $base = strtolower(trim($slug));
    if ($base === '' || !preg_match(LIVE_SLUG_RE, $base)) $base = liveSlugify($base);
    $candidate = $base;
    for ($n = 2; $n < 10000; $n++) {
        if (!in_array($candidate, LIVE_RESERVED_SLUGS, true) && liveSlugFree($db, $candidate, $exceptId)) return $candidate;
        $suffix = '-' . $n;
        $stem = strlen($base) + strlen($suffix) > 120 ? rtrim(substr($base, 0, 120 - strlen($suffix)), '-') : $base;
        $candidate = $stem . $suffix;
    }
    return $base . '-' . bin2hex(random_bytes(4));
}
