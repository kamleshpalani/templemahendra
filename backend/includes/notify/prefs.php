<?php
/**
 * backend/includes/notify/prefs.php — what each devotee has said they want.
 *
 * An absent row means every default applies: all channels on, Tamil, the
 * country's time zone, no promotional messages. A row is written the first time
 * the devotee saves, so the defaults in force at that moment become their
 * explicit choices — a category the committee adds later as "off by default"
 * is not silently switched off for someone who already chose.
 *
 * Consent is kept as a timestamp, not a flag: promotional_opt_in_at records
 * WHEN the devotee agreed, which is what a consent record needs to prove.
 */

require_once __DIR__ . '/categories.php';

/** A boolean from JSON or a form: true/false, 1/0, "1"/"0", "true"/"false", "on"/"off". Null when it is none of them. */
function notifyBool(mixed $v): ?bool
{
    if (is_bool($v)) return $v;
    if ($v === 1 || $v === 0) return (bool) $v;
    if (is_string($v)) {
        $s = strtolower(trim($v));
        if (in_array($s, ['1', 'true', 'on', 'yes'], true)) return true;
        if (in_array($s, ['0', 'false', 'off', 'no'], true)) return false;
    }
    return null;
}

/** The stored row, or null when the devotee has never saved preferences. */
function notifyPrefsRow(int $devoteeId): ?array
{
    if ($devoteeId < 1 || !notifyTablesExist()) return null;
    $stmt = getDB()->prepare('SELECT * FROM devotee_notification_prefs WHERE devotee_id = :d');
    $stmt->execute([':d' => $devoteeId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

/**
 * The notifyPrefs() shape from a stored row (or null) and the devotee's country.
 * Shared with campaign expansion, which loads rows for 500 devotees at a time.
 */
function notifyPrefsFromRow(?array $row, ?string $country): array
{
    $cats = notifyCategories(false);

    if ($row === null) {
        // Informational categories the committee marked "off by default" start
        // muted. Promotional ones are governed by consent instead, so muting them
        // too would make opting in do nothing.
        $muted = [];
        foreach ($cats as $key => $c) {
            if ($c['kind'] === 'informational' && $c['default_on'] === 0) $muted[] = (string) $key;
        }
        return [
            'lang'              => 'ta',
            'timezone'          => null,
            'effectiveTimezone' => notifyTimezoneFor(null, $country),
            'channels'          => array_fill_keys(NOTIFY_CHANNELS, true),
            'muted'             => $muted,
            'promotional'       => false,
            'unsubscribed'      => false,
            'updatedAt'         => null,
        ];
    }

    $muted = [];
    foreach (explode(',', (string) $row['muted_categories']) as $key) {
        $key = trim($key);
        if ($key !== '' && isset($cats[$key]) && $cats[$key]['mutable']) $muted[] = $key;
    }
    $channels = [];
    foreach (NOTIFY_CHANNELS as $c) $channels[$c] = (int) ($row[$c . '_on'] ?? 1) === 1;
    $tz = notifyIsTimezone($row['timezone'] ?? null) ? (string) $row['timezone'] : null;

    return [
        'lang'              => (string) ($row['lang'] ?: 'ta'),
        'timezone'          => $tz,
        'effectiveTimezone' => notifyTimezoneFor(['timezone' => $tz], $country),
        'channels'          => $channels,
        'muted'             => array_values(array_unique($muted)),
        'promotional'       => !empty($row['promotional_opt_in_at']),
        'unsubscribed'      => !empty($row['unsubscribed_at']),
        'updatedAt'         => notifyIso($row['updated_at'] ?? null),
    ];
}

/**
 * ['lang','timezone','effectiveTimezone','channels' => [channel => bool],
 *  'muted' => [category keys],'promotional' => bool,'unsubscribed' => bool,'updatedAt' => ?iso]
 */
function notifyPrefs(int $devoteeId): array
{
    if (!notifyTablesExist()) return notifyPrefsFromRow(null, null);
    $stmt = getDB()->prepare(
        'SELECT d.country, p.*
           FROM devotees d
           LEFT JOIN devotee_notification_prefs p ON p.devotee_id = d.id
          WHERE d.id = :d'
    );
    $stmt->execute([':d' => $devoteeId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return notifyPrefsFromRow(null, null);
    return notifyPrefsFromRow($row['devotee_id'] === null ? null : $row, $row['country']);
}

/**
 * Save a devotee's preferences. Partial input keeps everything not mentioned.
 *
 *   lang         must be one of notifyLanguages()
 *   timezone     an IANA name, or null/'' for "use my country's"
 *   channels     [channel => bool]; unknown channels and non-boolean values are ignored
 *   muted        category keys; transactional, security, critical and unknown keys
 *                are dropped without complaint (they cannot be muted, and a stale
 *                page must not fail a save over it)
 *   promotional  true records consent (keeping the FIRST consent time), false withdraws it
 *   unsubscribed false resumes optional emails after a one-click unsubscribe; true records one
 *
 * Turning email on — sending channels.email = true while unsubscribed or with
 * email off — also clears the unsubscribe, because the devotee has just said
 * they want email.
 *
 * @throws InvalidArgumentException with a sentence for the devotee on an invalid lang or timezone
 * @throws RuntimeException when the notification tables are missing
 */
function notifySavePrefs(int $devoteeId, array $input): array
{
    if (!notifyTablesExist()) throw new RuntimeException('Notification settings are not available on this site yet.');

    $stmt = getDB()->prepare('SELECT id, country FROM devotees WHERE id = :d');
    $stmt->execute([':d' => $devoteeId]);
    if (!$stmt->fetch(PDO::FETCH_ASSOC)) throw new InvalidArgumentException('That account no longer exists.');

    $row     = notifyPrefsRow($devoteeId);
    $current = notifyPrefs($devoteeId);

    $lang = $current['lang'];
    if (array_key_exists('lang', $input)) {
        $l = is_string($input['lang']) ? strtolower(trim($input['lang'])) : '';
        if (!isset(notifyLanguages()[$l])) throw new InvalidArgumentException('Choose one of the languages offered.');
        $lang = $l;
    }

    $tz = $current['timezone'];
    if (array_key_exists('timezone', $input)) {
        $t = $input['timezone'];
        if ($t === null || (is_string($t) && trim($t) === '')) {
            $tz = null;
        } elseif (is_string($t) && notifyIsTimezone(trim($t))) {
            $tz = trim($t);
        } else {
            throw new InvalidArgumentException('Choose a time zone from the list.');
        }
    }

    $channels    = $current['channels'];
    $emailWasOff = !$current['channels']['email'] || $current['unsubscribed'];
    $emailOn     = false;
    if (isset($input['channels']) && is_array($input['channels'])) {
        foreach (NOTIFY_CHANNELS as $c) {
            if (!array_key_exists($c, $input['channels'])) continue;
            $on = notifyBool($input['channels'][$c]);
            if ($on === null) continue;
            $channels[$c] = $on;
            if ($c === 'email' && $on) $emailOn = true;
        }
    }

    $muted = $current['muted'];
    if (array_key_exists('muted', $input)) {
        $cats  = notifyCategories(false);
        $muted = [];
        foreach (is_array($input['muted']) ? $input['muted'] : [] as $key) {
            if (is_string($key) && isset($cats[$key]) && $cats[$key]['mutable']) $muted[] = $key;
        }
        $muted = array_values(array_unique($muted));
    }

    $promoAt = $row['promotional_opt_in_at'] ?? null;
    if (array_key_exists('promotional', $input)) {
        $p = notifyBool($input['promotional']);
        if ($p === true) {
            $promoAt = $promoAt ?: notifyNow();
            // Opting in to promotional messages while a promotional category sits in
            // the muted list would make the consent do nothing; the devotee means both.
            if (!array_key_exists('muted', $input)) {
                $muted = array_values(array_filter($muted, static fn(string $k): bool => notifyCategoryKind($k) !== 'promotional'));
            }
        } elseif ($p === false) {
            $promoAt = null;
        }
    }

    $unsubAt = $row['unsubscribed_at'] ?? null;
    if (array_key_exists('unsubscribed', $input)) {
        $u = notifyBool($input['unsubscribed']);
        if ($u === true)  $unsubAt = $unsubAt ?: notifyNow();
        if ($u === false) $unsubAt = null;
    }
    if ($emailOn && $emailWasOff) $unsubAt = null;

    getDB()->prepare(
        'INSERT INTO devotee_notification_prefs
            (devotee_id, lang, timezone, email_on, whatsapp_on, push_on, sms_on, inapp_on,
             muted_categories, promotional_opt_in_at, unsubscribed_at, updated_at)
         VALUES (:d, :lang, :tz, :email, :whatsapp, :push, :sms, :inapp, :muted, :promo, :unsub, :now)
         ON DUPLICATE KEY UPDATE
            lang = VALUES(lang), timezone = VALUES(timezone),
            email_on = VALUES(email_on), whatsapp_on = VALUES(whatsapp_on), push_on = VALUES(push_on),
            sms_on = VALUES(sms_on), inapp_on = VALUES(inapp_on),
            muted_categories = VALUES(muted_categories),
            promotional_opt_in_at = VALUES(promotional_opt_in_at),
            unsubscribed_at = VALUES(unsubscribed_at), updated_at = VALUES(updated_at)'
    )->execute([
        ':d'        => $devoteeId,
        ':lang'     => $lang,
        ':tz'       => $tz,
        ':email'    => (int) $channels['email'],
        ':whatsapp' => (int) $channels['whatsapp'],
        ':push'     => (int) $channels['push'],
        ':sms'      => (int) $channels['sms'],
        ':inapp'    => (int) $channels['inapp'],
        ':muted'    => mb_substr(implode(',', $muted), 0, 500),
        ':promo'    => $promoAt,
        ':unsub'    => $unsubAt,
        ':now'      => notifyNow(),
    ]);

    return notifyPrefs($devoteeId);
}
