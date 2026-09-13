<?php
/**
 * tests/notify-unit.php — the Notification Service's rules, checked one at a
 * time against the real code and the real database.
 *
 *   PHP_BIN=/path/to/php.sh; $PHP_BIN tests/notify-unit.php
 *
 * What it proves:
 *   • the channel policy matrix — every rule of SPEC §5.4, in order, for
 *     devotees and guests, including provider fallbacks;
 *   • signed tokens: round trip, tampering, a token of the wrong kind;
 *   • which call-to-action links are allowed;
 *   • time zone conversion across a London daylight-saving change and in IST;
 *   • recurrence, including 31 January monthly;
 *   • retry backoff stays within its ±10% jitter;
 *   • audience rules: human error messages, and counts against devotees this
 *     file creates and deletes;
 *   • preference saves: unmutable categories dropped, first consent time kept.
 *
 * Needs the database from docs/notifications/SPEC.md §1. Creates devotees as
 * e2e-coreunit-<run>-*@example.test and bookings/donations named
 * E2E-COREUNIT-<run>, and deletes them before exiting.
 */

if (PHP_SAPI !== 'cli') exit(1);

// Deterministic drivers: every provider is the test fake unless a check swaps one out.
putenv('NOTIFY_ALLOW_TEST_DRIVER=1');
foreach (['EMAIL', 'WHATSAPP', 'SMS', 'PUSH'] as $c) putenv("NOTIFY_{$c}_DRIVER=test");
putenv('SITE_URL=https://temple.example.test');
putenv('NOTIFY_RATE_SMS_PER_MIN');

require_once __DIR__ . '/../backend/includes/notify.php';

$passed   = 0;
$failures = [];

function ok(bool $condition, string $label, string $detail = ''): void
{
    global $passed, $failures;
    if ($condition) {
        $passed++;
        echo "  ok   {$label}\n";
    } else {
        $failures[] = $label;
        echo "  FAIL {$label}" . ($detail !== '' ? " — {$detail}" : '') . "\n";
    }
}

function eq(mixed $actual, mixed $expected, string $label): void
{
    ok($actual === $expected, $label, 'expected ' . json_encode($expected, JSON_UNESCAPED_UNICODE) . ', got ' . json_encode($actual, JSON_UNESCAPED_UNICODE));
}

function section(string $title): void
{
    echo "\n── {$title}\n";
}

/** The InvalidArgumentException message, or null when nothing was thrown. */
function invalid(callable $fn): ?string
{
    try {
        $fn();
    } catch (InvalidArgumentException $e) {
        return $e->getMessage();
    }
    return null;
}

if (!notifyTablesExist()) {
    echo "The notification tables are missing; apply database/migrations/007_notifications.sql first.\n";
    exit(1);
}

$run    = base_convert((string) time(), 10, 36) . bin2hex(random_bytes(2));
$prefix = "e2e-coreunit-{$run}-";
$db     = getDB();

try {
    /* ── Channel policy ─────────────────────────────────────────────────── */
    section('Channel policy (SPEC §5.4)');

    $prefs = static fn(array $over = []): array => array_replace_recursive(notifyPrefsFromRow(null, 'IN'), $over);
    $devotee = static fn(array $over = []): array => array_replace([
        'devotee_id' => 1001, 'name' => 'Kavitha', 'email' => 'kavitha@example.test', 'email_verified' => true,
        'phone' => '919800001234', 'phone_verified' => true, 'country' => 'IN', 'lang' => 'ta',
        'timezone' => 'Asia/Kolkata', 'prefs' => $prefs(), 'active' => true, 'devices' => 1,
    ], $over);
    $guest = [
        'devotee_id' => null, 'name' => '', 'email' => 'guest@example.test', 'email_verified' => false,
        'phone' => '919800005678', 'phone_verified' => false, 'country' => null, 'lang' => 'ta',
        'timezone' => 'Asia/Kolkata', 'prefs' => null, 'active' => true, 'devices' => 0,
    ];
    $decide = static function (string $channel, string $category, string $priority, array $recipient, bool $campaign = false): array {
        return notifyAllowedChannels([$channel], $category, $priority, $recipient, $campaign)[$channel];
    };
    $is = static function (array $decision, string $status, ?string $reason, string $label): void {
        ok($decision['status'] === $status && $decision['reason'] === $reason, $label,
            'got ' . $decision['status'] . ($decision['reason'] !== null ? ' (' . $decision['reason'] . ')' : ''));
    };

    // 1. In-app
    $is($decide('inapp', 'general', 'normal', $guest), 'skipped', 'no account', '1 in-app: a guest has no account');
    $inappOff = $devotee(['prefs' => $prefs(['channels' => ['inapp' => false]])]);
    $is($decide('inapp', 'general', 'normal', $inappOff), 'skipped', 'turned off', '1 in-app off: mutable category at normal priority is skipped');
    $is($decide('inapp', 'general', 'important', $inappOff), 'skipped', 'turned off', '1 in-app off: important is still below urgent');
    $is($decide('inapp', 'general', 'urgent', $inappOff), 'sent', null, '1 in-app off: urgent breaks through');
    $is($decide('inapp', 'booking', 'normal', $inappOff), 'sent', null, '1 in-app off: a transactional category cannot be switched off');
    $is($decide('inapp', 'general', 'normal', $devotee(['deliver_after' => notifyNowPlus(3600)])), 'queued', null, '1 in-app: held until deliver_after is queued');
    $is($decide('inapp', 'general', 'normal', $devotee(['deliver_after' => notifyNowPlus(-60)])), 'sent', null, '1 in-app: a past deliver_after is visible at once');
    $is($decide('inapp', 'general', 'normal', $devotee(['email' => null, 'phone' => null, 'devices' => 0])), 'sent', null, '1 in-app needs no contact details');

    // 2. Contact
    $is($decide('email', 'booking', 'important', $devotee(['email' => 'not-an-email'])), 'skipped', 'no email', '2 email needs a valid address');
    $is($decide('sms', 'booking', 'important', $devotee(['phone' => null])), 'skipped', 'no phone', '2 SMS needs a phone');
    $is($decide('whatsapp', 'booking', 'important', $devotee(['phone' => '12345'])), 'skipped', 'no phone', '2 WhatsApp needs a dialable phone');
    $is($decide('push', 'booking', 'important', $devotee(['devices' => 0])), 'skipped', 'no device', '2 push needs an active device');
    $is($decide('push', 'booking', 'important', $guest), 'skipped', 'no device', '2 a guest has no push device');
    $is($decide('email', 'general', 'normal', $devotee(['email' => null, 'prefs' => $prefs(['channels' => ['email' => false]])])), 'skipped', 'no email', '2 contact is checked before the channel switch');

    // 3. Provider, and fallbacks
    putenv('NOTIFY_WHATSAPP_DRIVER=nonexistent');
    notifyProviderFor('whatsapp', true);
    $is($decide('whatsapp', 'booking', 'important', $devotee()), 'skipped', 'not configured', '3 an unconfigured provider is skipped, not failed');
    $withFallback = notifyAllowedChannels(['inapp', 'whatsapp'], 'booking', 'important', $devotee(), false, ['whatsapp' => 'sms']);
    ok(isset($withFallback['sms']) && $withFallback['sms']['status'] === 'queued' && ($withFallback['sms']['fallbackFor'] ?? null) === 'whatsapp',
        '3 fallback whatsapp → sms is added and queued', json_encode($withFallback));
    $fallbackRules = notifyAllowedChannels(['whatsapp'], 'general', 'normal', $devotee(), false, ['whatsapp' => 'sms']);
    ok(($fallbackRules['sms']['reason'] ?? null) === 'sms reserved for important messages', '3 a fallback channel still goes through every rule', json_encode($fallbackRules));
    $both = notifyAllowedChannels(['whatsapp', 'sms'], 'booking', 'important', $devotee(['prefs' => $prefs(['channels' => ['sms' => false]])]), false, ['whatsapp' => 'sms']);
    ok(($both['sms']['reason'] ?? null) === 'turned off' && !isset($both['sms']['fallbackFor']), '3 a channel requested in its own right keeps its own decision', json_encode($both));
    $noFallbackWhenConfigured = notifyAllowedChannels(['sms'], 'booking', 'important', $devotee(), false, ['sms' => 'whatsapp']);
    ok(!isset($noFallbackWhenConfigured['whatsapp']), '3 no fallback when the first channel is configured');
    putenv('NOTIFY_WHATSAPP_DRIVER=test');
    notifyProviderFor('whatsapp', true);
    $is($decide('whatsapp', 'booking', 'important', $devotee()), 'queued', null, '3 restoring the driver makes the channel available again');

    // 4. Consent for the kind
    $is($decide('email', 'promotional', 'normal', $devotee()), 'skipped', 'no promotional consent', '4 promotional needs opt-in');
    $promo = $devotee(['prefs' => $prefs(['promotional' => true])]);
    $is($decide('email', 'promotional', 'normal', $promo), 'queued', null, '4 promotional email with opt-in and a verified address is queued');
    $is($decide('email', 'promotional', 'normal', array_replace($promo, ['email_verified' => false])), 'skipped', 'email not verified', '4 promotional email needs a verified address');
    $is($decide('whatsapp', 'promotional', 'important', array_replace($promo, ['phone_verified' => false])), 'skipped', 'phone not verified', '4 promotional WhatsApp needs a verified phone');
    $is($decide('sms', 'promotional', 'important', array_replace($promo, ['phone_verified' => false])), 'skipped', 'phone not verified', '4 promotional SMS needs a verified phone');
    $is($decide('email', 'promotional', 'urgent', $guest), 'skipped', 'no promotional consent', '4 a guest is never sent promotional messages');
    $is($decide('email', 'promotional', 'normal', array_replace($guest, ['test' => true])), 'queued', null, '4 an admin test send to their own address counts as consent');
    $unverified = $devotee(['email_verified' => false]);
    $is($decide('email', 'announcement', 'normal', $unverified, true), 'skipped', 'email not verified', '4 informational campaign email needs a verified address');
    $is($decide('email', 'announcement', 'normal', $unverified, false), 'queued', null, '4 …but an automated informational email does not');
    $is($decide('email', 'booking', 'normal', $unverified, true), 'queued', null, '4 …and neither does a transactional campaign');
    $unsub = $devotee(['prefs' => $prefs(['unsubscribed' => true])]);
    $is($decide('email', 'festival', 'normal', $unsub), 'skipped', 'unsubscribed', '4 unsubscribed stops informational email');
    $is($decide('email', 'promotional', 'normal', $devotee(['prefs' => $prefs(['unsubscribed' => true, 'promotional' => true])])), 'skipped', 'unsubscribed', '4 unsubscribed stops promotional email');
    $is($decide('email', 'booking', 'normal', $unsub), 'queued', null, '4 unsubscribed does not stop a booking email');
    $is($decide('push', 'festival', 'normal', $unsub), 'queued', null, '4 unsubscribe is about email only');

    // 5. Channel switches
    $emailOff = $devotee(['prefs' => $prefs(['channels' => ['email' => false, 'sms' => false, 'push' => false, 'whatsapp' => false]])]);
    $is($decide('email', 'general', 'normal', $emailOff), 'skipped', 'turned off', '5 email switched off');
    $is($decide('push', 'booking', 'important', $emailOff), 'skipped', 'turned off', '5 switches apply to transactional messages too');
    $is($decide('email', 'security', 'urgent', $emailOff), 'queued', null, '5 security email ignores the email switch');
    $is($decide('sms', 'security', 'urgent', $emailOff), 'skipped', 'turned off', '5 …but security SMS respects the SMS switch');
    $is($decide('email', 'emergency', 'emergency', $emailOff), 'queued', null, '5 an emergency ignores the email switch');
    $is($decide('sms', 'emergency', 'emergency', $emailOff), 'queued', null, '5 an emergency ignores the SMS switch');
    $is($decide('push', 'emergency', 'emergency', $emailOff), 'queued', null, '5 an emergency ignores the push switch');
    $is($decide('whatsapp', 'emergency', 'emergency', $emailOff), 'skipped', 'turned off', '5 an emergency respects the WhatsApp opt-in (Meta policy)');

    // 6. Muted categories
    $muted = $devotee(['prefs' => $prefs(['muted' => ['festival', 'booking']])]);
    $is($decide('email', 'festival', 'normal', $muted), 'skipped', 'muted', '6 a muted category is skipped');
    $is($decide('push', 'festival', 'important', $muted), 'skipped', 'muted', '6 important does not break a mute');
    $is($decide('push', 'festival', 'urgent', $muted), 'queued', null, '6 urgent breaks a mute');
    $is($decide('push', 'festival', 'emergency', $muted), 'queued', null, '6 emergency breaks a mute');
    $is($decide('email', 'booking', 'normal', $muted), 'queued', null, '6 a transactional category cannot be muted even if listed');

    // 7. SMS restraint
    $is($decide('sms', 'general', 'normal', $devotee()), 'skipped', 'sms reserved for important messages', '7 routine informational SMS is not sent');
    $is($decide('sms', 'promotional', 'normal', $promo), 'skipped', 'sms reserved for important messages', '7 routine promotional SMS is not sent');
    $is($decide('sms', 'general', 'important', $devotee()), 'queued', null, '7 important informational SMS is sent');
    $is($decide('sms', 'booking', 'normal', $devotee()), 'queued', null, '7 transactional SMS at normal priority is sent');

    // 8. Otherwise queued; guests have every switch on
    $is($decide('whatsapp', 'general', 'normal', $devotee()), 'queued', null, '8 WhatsApp with nothing against it is queued');
    $is($decide('email', 'festival', 'normal', $guest), 'queued', null, '8 guest: every switch counts as on and nothing is muted');
    $is($decide('sms', 'booking', 'important', $guest), 'queued', null, '8 guest SMS for a booking is queued');
    eq(array_keys(notifyAllowedChannels(['email', 'nonsense', 'email', 'inapp'], 'general', 'normal', $devotee(), false)), ['email', 'inapp'], 'unknown and repeated channels are dropped');

    /* ── Tokens ─────────────────────────────────────────────────────────── */
    section('Signed tokens (SPEC §5.10)');
    foreach (['c' => 42, 'o' => 9999999999, 'u' => 7] as $kind => $id) {
        $token = notifyToken($kind, $id);
        ok((bool) preg_match('/^[cou][0-9]{1,10}\.[A-Za-z0-9_-]{16}$/', $token), "token {$kind}{$id} has the documented shape", $token);
        eq(notifyTokenVerify($token), ['kind' => $kind, 'id' => $id], "token {$kind}{$id} verifies");
    }
    $token = notifyToken('c', 123);
    [$head, $sig] = explode('.', $token);
    $flipped = $sig[0] === 'A' ? 'B' . substr($sig, 1) : 'A' . substr($sig, 1);
    eq(notifyTokenVerify($head . '.' . $flipped), null, 'a tampered signature is refused');
    eq(notifyTokenVerify('o123.' . $sig), null, 'a click token cannot be used as an open token');
    eq(notifyTokenVerify('c124.' . $sig), null, 'a signature for one delivery does not verify another');
    eq(notifyTokenVerify('c0123.' . $sig), null, 'a non-canonical id with a leading zero is refused');
    eq(notifyTokenVerify('x123.' . $sig), null, 'an unknown kind is refused');
    eq(notifyTokenVerify($token . 'A'), null, 'a longer signature is refused');
    eq(notifyTokenVerify(''), null, 'an empty token is refused');
    ok(invalid(static fn() => notifyToken('z', 1)) !== null, 'issuing a token of an unknown kind throws');
    ok(invalid(static fn() => notifyToken('c', 0)) !== null, 'issuing a token for id 0 throws');
    ok((bool) preg_match('#^https://temple\.example\.test/api/n/c/c55\.[A-Za-z0-9_-]{16}$#', (string) notifyTrackedUrl(55, '/sevas')), 'tracked URL is siteUrl(/api/n/c/<token>)');
    eq(notifyTrackedUrl(55, null), null, 'no target, no tracked URL');
    eq(notifyTrackedUrl(55, '  '), null, 'a blank target, no tracked URL');
    ok(str_starts_with(notifyOpenPixelUrl(55), 'https://temple.example.test/api/n/o/o55.'), 'open pixel URL');
    ok(str_starts_with(notifyUnsubscribeUrl(7), 'https://temple.example.test/api/n/u/u7.'), 'unsubscribe URL');
    eq(notifyPreferencesUrl(), 'https://temple.example.test/account?tab=notifications', 'preferences URL');

    /* ── CTA safety ─────────────────────────────────────────────────────── */
    section('notifySafeCtaUrl');
    $cta = [
        ['/sevas', '/sevas'], ['/account?tab=bookings', '/account?tab=bookings'], ['  /events  ', '/events'],
        ['https://maps.google.com/maps?q=Pudupatti', 'https://maps.google.com/maps?q=Pudupatti'],
        ['HTTPS://Example.org/x', 'HTTPS://Example.org/x'], ['/search?q=அம்மன்', '/search?q=அம்மன்'],
        ['//evil.example/phish', null], ['http://example.org/', null], ['javascript:alert(1)', null],
        ['JavaScript:alert(1)', null], ['data:text/html,<script>alert(1)</script>', null], ['https://temple.org@evil.example/', null],
        ['/a b', null], ["/sevas\n", '/sevas'], ["/se\nvas", null], ['/\\evil.example', null], ['https:///nohost', null],
        ['sevas', null], ['', null], [null, null], ['/' . str_repeat('a', 500), null], ['ftp://example.org', null],
    ];
    foreach ($cta as [$in, $expected]) {
        eq(notifySafeCtaUrl($in), $expected, 'CTA ' . json_encode($in, JSON_UNESCAPED_UNICODE) . ' → ' . json_encode($expected, JSON_UNESCAPED_UNICODE));
    }
    eq(notifyAbsoluteUrl('/sevas'), 'https://temple.example.test/sevas', 'a site path becomes absolute for email and push');

    /* ── Time ───────────────────────────────────────────────────────────── */
    section('Time zones');
    eq(notifyToUtc('2026-03-28 09:00', 'Europe/London'), '2026-03-28 09:00:00', 'London before the spring change is GMT');
    eq(notifyToUtc('2026-03-30 09:00', 'Europe/London'), '2026-03-30 08:00:00', 'London after the spring change is BST (UTC+1)');
    eq(notifyToUtc('2026-03-29 01:30', 'Europe/London'), '2026-03-29 01:30:00', 'a wall-clock time inside the spring gap moves forward (02:30 BST)');
    eq(notifyToUtc('2026-10-24 09:00', 'Europe/London'), '2026-10-24 08:00:00', 'London before the autumn change is BST');
    eq(notifyToUtc('2026-10-26 09:00', 'Europe/London'), '2026-10-26 09:00:00', 'London after the autumn change is GMT');
    eq(notifyFromUtc('2026-03-30 08:00:00', 'Europe/London'), '2026-03-30 09:00:00', 'UTC back to London wall clock in summer time');
    eq(notifyToUtc('2026-09-13 18:00', 'Asia/Kolkata'), '2026-09-13 12:30:00', 'IST is UTC+5:30');
    eq(notifyToUtc('2026-09-13T06:15', 'Asia/Kolkata'), '2026-09-13 00:45:00', 'the datetime-local "T" form is accepted');
    eq(notifyFromUtc('2026-09-13 20:00:00', 'Asia/Kolkata'), '2026-09-14 01:30:00', 'UTC to IST crosses midnight');
    eq(notifyFromUtc('2026-09-13 12:30:00', 'Asia/Kolkata', 'g:i a'), '6:00 pm', 'notifyFromUtc formats');
    eq(notifyToUtc('2026-09-13 18:00', 'Not/AZone'), '2026-09-13 12:30:00', 'an unknown zone means the temple zone');
    ok(invalid(static fn() => notifyToUtc('2026-02-30 10:00', 'Asia/Kolkata')) !== null, 'an impossible date throws');
    ok(invalid(static fn() => notifyToUtc('tomorrow', 'Asia/Kolkata')) !== null, 'free text throws');
    eq(notifyIso('2026-09-13 04:05:06'), '2026-09-13T04:05:06Z', 'notifyIso adds the Z');
    eq(notifyIso(null), null, 'notifyIso(null) is null');
    eq(notifyIso('0000-00-00 00:00:00'), null, 'a zero date is null');
    eq(notifyTempleTz(), 'Asia/Kolkata', 'the temple zone defaults to Asia/Kolkata');
    eq(notifyTimezoneFor(null, 'GB'), 'Europe/London', 'GB devotees default to London');
    eq(notifyTimezoneFor(['timezone' => 'Asia/Tokyo'], 'GB'), 'Asia/Tokyo', 'a chosen zone beats the country');
    eq(notifyTimezoneFor(['timezone' => 'Mars/Olympus'], 'US'), 'America/New_York', 'an invalid chosen zone falls back to the country');
    eq(notifyTimezoneFor(null, 'ZZ'), 'Asia/Kolkata', 'an unknown country falls back to the temple');
    eq(notifyTimezoneFor(null, null), 'Asia/Kolkata', 'no country falls back to the temple');
    $required = ['IN', 'LK', 'SG', 'MY', 'AE', 'SA', 'QA', 'KW', 'OM', 'BH', 'GB', 'IE', 'DE', 'FR', 'NL', 'CH', 'US', 'CA', 'AU', 'NZ', 'ZA', 'MU', 'FJ', 'JP', 'HK'];
    $map = notifyCountryTimezones();
    $missing = array_filter($required, static fn($c) => !isset($map[$c]) || !notifyIsTimezone($map[$c]));
    ok(!$missing, 'the country map covers every required country with a real zone', implode(',', $missing));
    eq([$map['US'], $map['CA'], $map['AU']], ['America/New_York', 'America/Toronto', 'Australia/Sydney'], 'multi-zone countries use the documented zones');
    notifyClockOffset('2031-01-01 00:00:00');
    ok(str_starts_with(notifyNow(), '2031-01-01 00:00'), 'the test clock moves notifyNow()', notifyNow());
    notifyClockOffset(null, true);
    ok(abs(strtotime(notifyNow() . ' UTC') - time()) <= 2, 'clearing the test clock returns to real time');

    /* ── Recurrence ─────────────────────────────────────────────────────── */
    section('Recurrence');
    eq(notifyNextOccurrence('2027-01-31 09:00:00', 'monthly', 31), '2027-02-28 09:00:00', 'monthly from 31 January clamps to 28 February');
    eq(notifyNextOccurrence('2027-02-28 09:00:00', 'monthly', 31), '2027-03-31 09:00:00', '…and returns to the 31st in March');
    eq(notifyNextOccurrence('2027-03-31 09:00:00', 'monthly', 31), '2027-04-30 09:00:00', '…and clamps to 30 April');
    eq(notifyNextOccurrence('2028-01-31 07:30:00', 'monthly', 31), '2028-02-29 07:30:00', 'a leap year clamps to 29 February');
    eq(notifyNextOccurrence('2026-12-15 18:00:00', 'monthly'), '2027-01-15 18:00:00', 'monthly crosses the year');
    eq(notifyNextOccurrence('2026-12-31 23:30:00', 'daily'), '2027-01-01 23:30:00', 'daily crosses the year');
    eq(notifyNextOccurrence('2026-09-13 06:00:00', 'weekly'), '2026-09-20 06:00:00', 'weekly adds seven days');
    eq(notifyNextOccurrence('2026-09-13 06:00:00', 'none'), null, 'no recurrence, no next time');
    $next = notifyNextOccurrence('2026-03-28 09:00:00', 'daily');
    eq([$next, notifyToUtc($next, 'Europe/London')], ['2026-03-29 09:00:00', '2026-03-29 08:00:00'], 'daily keeps 9:00 on the wall clock across a DST change (the UTC instant moves)');

    /* ── Backoff ────────────────────────────────────────────────────────── */
    section('Retry backoff');
    foreach ([1 => 60, 2 => 300, 3 => 1800, 4 => 7200, 5 => 21600, 9 => 21600] as $attempts => $base) {
        $min = PHP_INT_MAX;
        $max = 0;
        for ($i = 0; $i < 300; $i++) {
            $s = notifyBackoffSeconds($attempts);
            $min = min($min, $s);
            $max = max($max, $s);
        }
        ok($min >= (int) floor($base * 0.9) && $max <= (int) ceil($base * 1.1), "after {$attempts} attempt(s) the wait is {$base}s ±10%", "saw {$min}..{$max}");
        ok($max > $min, "after {$attempts} attempt(s) the wait is jittered", "saw {$min}..{$max}");
    }
    eq(notifyBackoffSeconds(1, 100000), 100000, "a provider's longer Retry-After wins");
    ok(notifyBackoffSeconds(3, 5) >= 1620, 'a shorter Retry-After does not shorten the backoff');
    eq(notifyRatePerMinute('sms'), 30, 'SMS throttle defaults to 30 per minute');
    putenv('NOTIFY_RATE_SMS_PER_MIN=2');
    eq(notifyRatePerMinute('sms'), 2, 'NOTIFY_RATE_SMS_PER_MIN overrides it');
    putenv('NOTIFY_RATE_SMS_PER_MIN=zero');
    eq(notifyRatePerMinute('sms'), 30, 'a nonsense rate falls back to the default');
    putenv('NOTIFY_RATE_SMS_PER_MIN');
    eq(array_map('notifyRatePerMinute', ['email', 'whatsapp', 'push']), [60, 80, 600], 'email, WhatsApp and push throttles default to 60, 80, 600');

    /* ── Audience ───────────────────────────────────────────────────────── */
    section('Audience rules: validation');
    $errors = [
        'no mode'             => [[], 'Choose who should receive this'],
        'bad mode'            => [['mode' => 'everyone'], 'Choose who should receive this'],
        'empty selection'     => [['mode' => 'selected', 'devotee_ids' => []], 'Choose at least one devotee'],
        'too many selected'   => [['mode' => 'selected', 'devotee_ids' => range(1, 5001)], 'at most 5000'],
        'no rules'            => [['mode' => 'rules', 'match' => 'all', 'rules' => []], 'Add at least one rule'],
        'bad match'           => [['mode' => 'rules', 'match' => 'some', 'rules' => [['field' => 'has_booking', 'op' => 'is', 'value' => true]]], 'all rules or any rule'],
        'unknown field'       => [['mode' => 'rules', 'rules' => [['field' => 'd.id; DROP TABLE devotees', 'op' => 'is', 'value' => 1]]], 'Rule 1 uses a field'],
        'wrong op'            => [['mode' => 'rules', 'rules' => [['field' => 'country', 'op' => 'contains', 'value' => 'IN']]], 'Rule 1 (Country) cannot use that comparison'],
        'bad country'         => [['mode' => 'rules', 'rules' => [['field' => 'country', 'op' => 'in', 'value' => ['IND']]]], 'two-letter country codes'],
        'empty list'          => [['mode' => 'rules', 'rules' => [['field' => 'state', 'op' => 'in', 'value' => []]]], 'choose at least one value'],
        'city blank'          => [['mode' => 'rules', 'rules' => [['field' => 'city', 'op' => 'contains', 'value' => '  ']]], 'type a city'],
        'bool maybe'          => [['mode' => 'rules', 'rules' => [['field' => 'has_booking', 'op' => 'is', 'value' => 'maybe']]], 'choose yes or no'],
        'negative days'       => [['mode' => 'rules', 'rules' => [['field' => 'registered_days', 'op' => 'lte', 'value' => -1]]], 'between 0 and 36500'],
        'fractional days'     => [['mode' => 'rules', 'rules' => [['field' => 'registered_days', 'op' => 'lte', 'value' => '2.5']]], 'whole number of days'],
        'too many days'       => [['mode' => 'rules', 'rules' => [['field' => 'booking_days', 'op' => 'lte', 'value' => 99999]]], 'between 0 and 36500'],
        'bad amount'          => [['mode' => 'rules', 'rules' => [['field' => 'donated_total', 'op' => 'gte', 'value' => 'lots']]], 'enter an amount'],
        'bad language'        => [['mode' => 'rules', 'rules' => [['field' => 'lang', 'op' => 'in', 'value' => ['xx']]]], 'languages offered'],
        'bad status'          => [['mode' => 'rules', 'rules' => [['field' => 'booking_status', 'op' => 'in', 'value' => ['lost']]]], 'pending, confirmed'],
        'bad tag'             => [['mode' => 'rules', 'rules' => [['field' => 'tag', 'op' => 'in', 'value' => ['no spaces!']]]], 'tags use lowercase'],
        'bad channel'         => [['mode' => 'rules', 'rules' => [['field' => 'channel_enabled', 'op' => 'in', 'value' => ['fax']]]], 'in-app, email'],
        'bad category'        => [['mode' => 'rules', 'rules' => [['field' => 'category_not_muted', 'op' => 'is', 'value' => 'nope']]], 'choose a category'],
        'bad seva id'         => [['mode' => 'rules', 'rules' => [['field' => 'booked_seva', 'op' => 'in', 'value' => ['abc']]]], 'choose sevas'],
        'second rule counted' => [['mode' => 'rules', 'rules' => [['field' => 'has_booking', 'op' => 'is', 'value' => true], ['field' => 'tag', 'op' => 'in']]], 'Rule 2 (Tag)'],
        'unreadable json'     => ['{"mode":', 'could not be read'],
    ];
    foreach ($errors as $label => [$rules, $needle]) {
        $message = invalid(static fn() => notifyAudienceNormalize($rules));
        ok($message !== null && stripos($message, $needle) !== false, "rejects {$label} with a human message", (string) $message);
    }
    $normal = notifyAudienceNormalize('{"mode":"rules","rules":[{"field":"country","op":"in","value":"in, sg"},{"field":"tag","op":"in","value":["Volunteer"]},{"field":"has_booking","op":"is","value":"true"}]}');
    eq($normal['rules'][0]['value'], ['IN', 'SG'], 'country codes are upper-cased and split from text');
    eq($normal['rules'][1]['value'], ['volunteer'], 'tags are lower-cased');
    eq($normal['rules'][2]['value'], true, '"true" becomes a boolean');
    eq($normal['match'], 'all', 'match defaults to all');
    eq(notifyAudienceNormalize(['mode' => 'selected', 'devotee_ids' => [5, '3', 5, -1, 'x']])['devotee_ids'], [3, 5], 'selected ids are de-duplicated, sorted and cleaned');
    $q = notifyAudienceQuery(['mode' => 'rules', 'rules' => [['field' => 'city', 'op' => 'contains', 'value' => "50%_off' OR 1=1 --"]]]);
    ok(str_starts_with($q['sql'], 'SELECT d.id FROM devotees d') && str_ends_with($q['sql'], 'ORDER BY d.id'), 'the query selects d.id and orders by it');
    ok(!str_contains($q['sql'], '1=1') && in_array('%50\\%\\_off\' OR 1=1 --%', $q['params'], true), 'values are bound, with LIKE wildcards escaped', json_encode($q));
    ok(str_contains($q['sql'], 'd.is_active = 1'), 'every audience excludes closed accounts');

    section('Audience rules: counts against fixture devotees');
    $hash = password_hash('Kolam99Deep', PASSWORD_BCRYPT, ['cost' => 4]);
    $now  = gmdate('Y-m-d H:i:s');
    $old  = gmdate('Y-m-d H:i:s', time() - 400 * 86400);
    $make = static function (string $key, array $cols) use ($db, $prefix, $hash, $now): int {
        $row = $cols + ['name' => 'E2E-COREUNIT ' . $key, 'email' => $prefix . $key . '@example.test', 'pass_hash' => $hash,
                        'country' => 'IN', 'state' => 'TN', 'city' => 'Pudupatti', 'created_at' => $now];
        $names = array_keys($row);
        $db->prepare('INSERT INTO devotees (' . implode(',', $names) . ') VALUES (:' . implode(',:', $names) . ')')
           ->execute(array_combine(array_map(static fn($n) => ':' . $n, $names), array_values($row)));
        return (int) $db->lastInsertId();
    };
    $ids = [
        'a' => $make('a', ['email_verified_at' => $now, 'phone' => '919800000011', 'phone_verified_at' => $now, 'last_login_at' => $now]),
        'b' => $make('b', ['country' => 'GB', 'state' => 'ENG', 'city' => 'Leicester', 'email_verified_at' => $now, 'created_at' => $old]),
        'c' => $make('c', ['country' => 'SG', 'state' => null, 'city' => 'Singapore', 'last_login_at' => $old]),
        'd' => $make('d', ['city' => 'Tenkasi']),
        'e' => $make('e', ['country' => null, 'state' => null, 'city' => 'Pudupatti North']),
        'x' => $make('x', ['is_active' => 0, 'email_verified_at' => $now]), // closed: never counted
    ];
    $tag = 'e2e-coreunit-' . $run;
    $tagIns = $db->prepare("INSERT INTO devotee_tags (devotee_id, tag, created_by) VALUES (:d, :t, 'e2e')");
    foreach ($ids as $id) $tagIns->execute([':d' => $id, ':t' => $tag]);
    $tagIns->execute([':d' => $ids['a'], ':t' => $tag . '-volunteer']);
    $tagIns->execute([':d' => $ids['c'], ':t' => $tag . '-volunteer']);
    $db->prepare("INSERT INTO devotee_notification_prefs (devotee_id, lang, email_on, sms_on, muted_categories, updated_at) VALUES (:d, 'en', 0, 1, 'festival,pooja', :now)")
       ->execute([':d' => $ids['b'], ':now' => $now]);
    $db->prepare("INSERT INTO devotee_notification_prefs (devotee_id, lang, email_on, sms_on, muted_categories, updated_at) VALUES (:d, 'hi', 1, 0, '', :now)")
       ->execute([':d' => $ids['c'], ':now' => $now]);
    $seva = $db->query('SELECT id FROM sevas ORDER BY id LIMIT 1')->fetchColumn();
    $bookingIns = $db->prepare('INSERT INTO seva_bookings (devotee_id, devotee_name, phone, seva_id, seva_name, preferred_date, status, created_at) VALUES (:d, :n, :p, :s, :sn, NULL, :st, :c)');
    $bookingIns->execute([':d' => $ids['a'], ':n' => 'E2E-COREUNIT-' . $run, ':p' => '919800000011', ':s' => $seva ?: null, ':sn' => 'Abhishekam', ':st' => 'confirmed', ':c' => $now]);
    $bookingIns->execute([':d' => $ids['b'], ':n' => 'E2E-COREUNIT-' . $run, ':p' => '447700900123', ':s' => null, ':sn' => 'Archana', ':st' => 'cancelled', ':c' => $old]);
    $donationIns = $db->prepare('INSERT INTO donations (devotee_id, name, phone, amount, purpose, created_at) VALUES (:d, :n, :p, :a, :pu, :c)');
    $donationIns->execute([':d' => $ids['a'], ':n' => 'E2E-COREUNIT-' . $run, ':p' => '919800000011', ':a' => 600, ':pu' => 'Annadanam', ':c' => $now]);
    $donationIns->execute([':d' => $ids['a'], ':n' => 'E2E-COREUNIT-' . $run, ':p' => '919800000011', ':a' => 501, ':pu' => 'General', ':c' => $old]);
    $donationIns->execute([':d' => $ids['c'], ':n' => 'E2E-COREUNIT-' . $run, ':p' => '6591234567', ':a' => 250, ':pu' => 'General', ':c' => $old]);
    $db->prepare('UPDATE devotees SET is_active = 0 WHERE id = :id')->execute([':id' => $ids['x']]);
    $db->prepare("INSERT INTO seva_bookings (devotee_id, devotee_name, phone, seva_name, status, created_at) VALUES (:d, :n, '919800000099', 'Archana', 'confirmed', :c)")
       ->execute([':d' => $ids['x'], ':n' => 'E2E-COREUNIT-' . $run, ':c' => $now]);

    // Every count is confined to this run's devotees by the run tag, so other
    // data in a shared database cannot change the expected numbers.
    $count = static function (array $rules) use ($tag): int {
        return notifyAudienceCount(['mode' => 'rules', 'match' => 'all', 'rules' => [
            ['field' => 'tag', 'op' => 'in', 'value' => [$tag]],
            ...$rules,
        ]]);
    };
    $expect = [
        'tag in (the run tag), closed account excluded'      => [[], 5],
        'country in IN'                                      => [[['field' => 'country', 'op' => 'in', 'value' => ['IN']]], 2],
        'country not in IN (NULL country counts as not IN)'  => [[['field' => 'country', 'op' => 'not_in', 'value' => ['IN']]], 3],
        'state in TN'                                        => [[['field' => 'state', 'op' => 'in', 'value' => ['TN']]], 2],
        'state not in TN'                                    => [[['field' => 'state', 'op' => 'not_in', 'value' => ['TN']]], 3],
        'city contains pudupatti (case-insensitive)'         => [[['field' => 'city', 'op' => 'contains', 'value' => 'PUDUPATTI']], 2],
        'city equals Pudupatti'                              => [[['field' => 'city', 'op' => 'equals', 'value' => 'pudupatti']], 1],
        'lang in ta (no prefs row counts as ta)'             => [[['field' => 'lang', 'op' => 'in', 'value' => ['ta']]], 3],
        'lang in en, hi'                                     => [[['field' => 'lang', 'op' => 'in', 'value' => ['en', 'hi']]], 2],
        'email verified'                                     => [[['field' => 'email_verified', 'op' => 'is', 'value' => true]], 2],
        'email not verified'                                 => [[['field' => 'email_verified', 'op' => 'is', 'value' => false]], 3],
        'phone verified'                                     => [[['field' => 'phone_verified', 'op' => 'is', 'value' => true]], 1],
        'registered within 30 days'                          => [[['field' => 'registered_days', 'op' => 'lte', 'value' => 30]], 4],
        'registered at least 300 days ago'                   => [[['field' => 'registered_days', 'op' => 'gte', 'value' => 300]], 1],
        'signed in within 7 days'                            => [[['field' => 'last_login_days', 'op' => 'lte', 'value' => 7]], 1],
        'not signed in for 300 days (never counts)'          => [[['field' => 'last_login_days', 'op' => 'gte', 'value' => 300]], 4],
        'has a booking'                                      => [[['field' => 'has_booking', 'op' => 'is', 'value' => true]], 2],
        'has no booking'                                     => [[['field' => 'has_booking', 'op' => 'is', 'value' => false]], 3],
        'booking status confirmed'                           => [[['field' => 'booking_status', 'op' => 'in', 'value' => ['confirmed']]], 1],
        'booking within 30 days'                             => [[['field' => 'booking_days', 'op' => 'lte', 'value' => 30]], 1],
        'has donated'                                        => [[['field' => 'has_donated', 'op' => 'is', 'value' => true]], 2],
        'donated at least 1000 in total'                     => [[['field' => 'donated_total', 'op' => 'gte', 'value' => 1000]], 1],
        'donated at most 300 in total (none counts as 0)'    => [[['field' => 'donated_total', 'op' => 'lte', 'value' => 300]], 4],
        'donated within 30 days'                             => [[['field' => 'donated_days', 'op' => 'lte', 'value' => 30]], 1],
        'tag in volunteer'                                   => [[['field' => 'tag', 'op' => 'in', 'value' => [$tag . '-volunteer']]], 2],
        'tag not in volunteer'                               => [[['field' => 'tag', 'op' => 'not_in', 'value' => [$tag . '-volunteer']]], 3],
        'email channel enabled (no row = on)'                => [[['field' => 'channel_enabled', 'op' => 'in', 'value' => ['email']]], 4],
        'sms or email enabled'                               => [[['field' => 'channel_enabled', 'op' => 'in', 'value' => ['sms', 'email']]], 5],
        'festival not muted'                                 => [[['field' => 'category_not_muted', 'op' => 'is', 'value' => 'festival']], 4],
        'booking "not muted" for everyone (cannot be muted)' => [[['field' => 'category_not_muted', 'op' => 'is', 'value' => 'booking']], 5],
        'all of: IN and has donated'                         => [[['field' => 'country', 'op' => 'in', 'value' => ['IN']], ['field' => 'has_donated', 'op' => 'is', 'value' => true]], 1],
    ];
    foreach ($expect as $label => [$rules, $n]) {
        eq($count($rules), $n, "count: {$label}");
    }
    $any = notifyAudienceCount(['mode' => 'rules', 'match' => 'any', 'rules' => [
        ['field' => 'city', 'op' => 'equals', 'value' => 'Leicester'],
        ['field' => 'city', 'op' => 'equals', 'value' => 'Tenkasi'],
    ]]);
    ok($any >= 2, 'match any combines rules with OR', (string) $any);
    eq(notifyAudienceCount(['mode' => 'selected', 'devotee_ids' => array_values($ids)]), 5, 'selected devotees exclude the closed account');
    $query = notifyAudienceQuery(['mode' => 'selected', 'devotee_ids' => array_values($ids)]);
    $stmt = $db->prepare($query['sql']);
    $stmt->execute($query['params']);
    $got = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    $active = array_values(array_diff($ids, [$ids['x']]));
    sort($active);
    eq($got, $active, 'notifyAudienceQuery runs as returned and orders by id');
    eq(notifyAudienceBatch(['mode' => 'selected', 'devotee_ids' => array_values($ids)], $active[1], 2), [$active[2], $active[3]], 'notifyAudienceBatch pages after a cursor');
    ok(notifyAudienceCount(['mode' => 'all_devotees']) >= 5, 'all devotees includes the fixtures');
    $fields = notifyAudienceFields();
    eq(array_keys($fields), array_keys(notifyAudienceFieldOps()), 'notifyAudienceFields lists every field');
    ok(is_array($fields['lang']['options']) && is_array($fields['booking_status']['options']) && is_array($fields['tag']['options'])
        && is_array($fields['booked_seva']['options']) && is_array($fields['channel_enabled']['options']) && is_array($fields['category_not_muted']['options'])
        && $fields['country']['options'] === null, 'options are filled exactly for the list-backed fields');
    ok(in_array($tag . '-volunteer', array_column($fields['tag']['options'], 'value'), true), 'tag options include tags in use');

    /* ── Preferences ────────────────────────────────────────────────────── */
    section('Preferences');
    $d = $ids['d'];
    $p = notifyPrefs($d);
    eq([$p['lang'], $p['timezone'], $p['effectiveTimezone'], $p['promotional'], $p['unsubscribed'], $p['updatedAt']], ['ta', null, 'Asia/Kolkata', false, false, null], 'no row: Tamil, country zone, no consent');
    eq($p['channels'], ['inapp' => true, 'email' => true, 'whatsapp' => true, 'sms' => true, 'push' => true], 'no row: every channel on');
    $saved = notifySavePrefs($d, ['muted' => ['festival', 'booking', 'security', 'emergency', 'nope', 'festival', 42]]);
    eq($saved['muted'], ['festival'], 'unmutable, unknown, repeated and non-string categories are dropped from muted');
    ok($saved['updatedAt'] !== null, 'a save records updatedAt');
    $saved = notifySavePrefs($d, ['channels' => ['email' => false, 'fax' => true, 'sms' => 'maybe']]);
    eq([$saved['channels']['email'], $saved['channels']['sms'], $saved['muted']], [false, true, ['festival']], 'a partial save keeps everything not mentioned; nonsense values are ignored');
    $saved = notifySavePrefs($d, ['muted' => ['promotional', 'festival'], 'promotional' => true]);
    ok($saved['promotional'] === true, 'promotional true records consent');
    $first = $db->prepare('SELECT promotional_opt_in_at FROM devotee_notification_prefs WHERE devotee_id = :d');
    $first->execute([':d' => $d]);
    ok($first->fetchColumn() !== null, 'the consent time is stored');
    $db->prepare("UPDATE devotee_notification_prefs SET promotional_opt_in_at = '2024-01-02 03:04:05' WHERE devotee_id = :d")->execute([':d' => $d]);
    notifySavePrefs($d, ['promotional' => true, 'lang' => 'en']);
    $first->execute([':d' => $d]);
    eq($first->fetchColumn(), '2024-01-02 03:04:05', 'consenting again keeps the FIRST consent time');
    $saved = notifySavePrefs($d, ['promotional' => false]);
    $first->execute([':d' => $d]);
    ok($saved['promotional'] === false && $first->fetchColumn() === null, 'promotional false withdraws consent');
    $saved = notifySavePrefs($d, ['promotional' => true]);
    ok(in_array('promotional', $saved['muted'], true) === false, 'opting in to promotional removes a promotional mute when muted is not sent');
    eq($saved['lang'], 'en', 'language saved');
    ok(invalid(static fn() => notifySavePrefs($d, ['lang' => 'xx'])) === 'Choose one of the languages offered.', 'an unknown language throws a sentence for the devotee');
    ok(invalid(static fn() => notifySavePrefs($d, ['timezone' => 'Mars/Olympus'])) === 'Choose a time zone from the list.', 'an unknown time zone throws a sentence for the devotee');
    eq(notifySavePrefs($d, ['timezone' => 'Europe/London'])['effectiveTimezone'], 'Europe/London', 'a chosen time zone becomes effective');
    eq(notifySavePrefs($d, ['timezone' => ''])['timezone'], null, 'an empty time zone means "use my country"');
    $db->prepare('UPDATE devotee_notification_prefs SET unsubscribed_at = :now WHERE devotee_id = :d')->execute([':now' => $now, ':d' => $d]);
    ok(notifyPrefs($d)['unsubscribed'] === true, 'a one-click unsubscribe shows in prefs');
    eq(notifySavePrefs($d, ['channels' => ['sms' => false]])['unsubscribed'], true, 'saving another channel keeps the unsubscribe');
    eq(notifySavePrefs($d, ['channels' => ['email' => true]])['unsubscribed'], false, 'turning email back on clears the unsubscribe');
    ok(invalid(static fn() => notifySavePrefs(999999999, ['lang' => 'ta'])) !== null, 'saving for an account that does not exist throws');

    /* ── Push keys ──────────────────────────────────────────────────────── */
    section('VAPID keys (SPEC §5.12)');
    $pair = notifyGenerateP256KeyPair();
    $pub  = notifyB64uDecode($pair['public']);
    $priv = notifyB64uDecode($pair['private']);
    eq([strlen($pair['public']), strlen($pub), strlen($pair['private']), strlen($priv)], [87, 65, 43, 32], 'a generated pair is base64url of a raw 65-byte public point and a 32-byte private scalar');
    ok($pub[0] === "\x04", 'the public key is an uncompressed point (0x04 ‖ X ‖ Y)');
    ok(NotifyEcKeys::publicKey($pub) !== null, 'OpenSSL accepts the public point as a P-256 key (a point off the curve is refused)');
    ok(NotifyEcKeys::publicFromPrivate($priv) === $pub, 'the private scalar derives exactly that public point (the halves belong together)');
    ok(notifyGenerateP256KeyPair()['private'] !== $pair['private'], 'every generated pair is different');

    foreach (['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'] as $k) putenv($k);
    eq([notifyVapidPublicKey(), notifyVapidKeys()], [null, null], 'with the test push driver and no VAPID variables there is no key');
    putenv('VAPID_PUBLIC_KEY=' . $pair['public']);
    eq([notifyVapidPublicKey(), notifyVapidKeys()], [$pair['public'], null], 'a public key alone is advertised, but half a pair cannot sign');
    putenv('VAPID_PRIVATE_KEY=' . $pair['private']);
    eq(notifyVapidKeys(), ['public' => $pair['public'], 'private' => $pair['private'], 'source' => 'env'], 'both variables make the environment pair win');
    foreach (['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'] as $k) putenv($k);
    putenv('NOTIFY_PUSH_DRIVER=log');
    $dev = notifyVapidKeys();
    ok(is_array($dev) && $dev['source'] === 'generated' && notifyVapidPublicKey() === $dev['public']
        && NotifyEcKeys::publicFromPrivate(notifyB64uDecode($dev['private'])) === notifyB64uDecode($dev['public']),
        'with the log driver a development pair lives in notification_kv and is a matching pair');
    ok(notifyVapidKeys() === $dev, 'the development pair is generated once and then reused');
    putenv('NOTIFY_PUSH_DRIVER=test');

    /* ── Smaller pieces ─────────────────────────────────────────────────── */
    section('Events, approval rules, formatting');
    eq(notifyEventDedupeKey('booking:{entity_id}:confirmed', ['entity_id' => 91]), 'booking:91:confirmed', 'dedupe pattern with entity_id');
    eq(notifyEventDedupeKey('booking:{entity_id}:confirmed', []), null, 'a dedupe pattern with a missing value is null (not sent)');
    eq(notifyEventDedupeKey('event:{entity_id}:registered:{recipient}', ['entity_id' => 4, 'devotee_id' => 12]), 'event:4:registered:d12', '{recipient} for a devotee');
    eq(notifyEventDedupeKey('event:{entity_id}:registered:{recipient}', ['entity_id' => 4, 'to_phone' => '+91 98000 01234']), 'event:4:registered:p' . substr(sha1('919800001234'), 0, 12), '{recipient} for a guest phone');
    eq(notifyEventDedupeKey('donation:{entity_id}:receipt:{ctx.sequence}', ['entity_id' => 8, 'sequence' => 2]), 'donation:8:receipt:2', '{ctx.sequence}');
    eq(notifyEventDedupeKey('devotee:{id}:phone:{phoneHash8}', ['devotee_id' => 3, 'to_phone' => '919800001234']), 'devotee:3:phone:' . substr(sha1('919800001234'), 0, 8), '{phoneHash8}');
    eq(count(notifyEventCatalogue()), 22, 'the catalogue has every SPEC event');
    $missingTemplates = array_filter(notifyEventCatalogue(), static fn($e) => notifyTemplate($e['template'], 'en', 'any') === null);
    ok(!$missingTemplates, 'every catalogue event has a template', implode(',', array_keys($missingTemplates)));
    eq(notifyEvent('no.such.event', [])['skipped'], 'unknown event', 'an unknown event is skipped, never thrown');
    eq(notifyEvent('booking.confirmed', ['devotee_id' => $ids['a']])['skipped'], 'missing dedupe context', 'an event without its dedupe context is not sent');
    eq(notify(['devotee_id' => $ids['a']])['skipped'], 'nothing to send', 'notify() with neither template nor text is skipped');
    eq(notify(['template' => 'no_such_template', 'devotee_id' => $ids['a']])['skipped'], 'unknown template', 'notify() with an unknown template is skipped');
    eq(notify(['title' => 'x', 'body' => 'y', 'devotee_id' => $ids['x']])['skipped'], 'account closed', 'a closed account receives nothing');
    eq(notify(['title' => 'x', 'body' => 'y'])['skipped'], 'no recipient', 'a guest with no address is skipped');
    $c = ['priority' => 'normal', 'channels' => 'inapp,push', 'category' => 'announcement'];
    eq(notifyCampaignNeedsApproval($c, 50), null, 'approval: 50 devotees on free channels needs none');
    eq(notifyCampaignNeedsApproval($c, 51), 'Reaches 51 devotees', 'approval: over the threshold');
    eq(notifyCampaignNeedsApproval(['priority' => 'urgent'] + $c, 2), 'Urgent/emergency priority', 'approval: urgent');
    eq(notifyCampaignNeedsApproval(['channels' => 'inapp,sms'] + $c, 11), 'Paid channels to 11 devotees', 'approval: paid channels over ten');
    eq(notifyCampaignNeedsApproval(['channelsList' => ['whatsapp']] + $c, 10), null, 'approval: paid channels to ten need none');
    eq(notifyCampaignNeedsApproval(['category' => 'promotional'] + $c, 1), 'Promotional message', 'approval: promotional');
    putenv('NOTIFY_APPROVAL_THRESHOLD=5');
    eq(notifyCampaignNeedsApproval($c, 6), 'Reaches 6 devotees', 'NOTIFY_APPROVAL_THRESHOLD changes the threshold');
    putenv('NOTIFY_APPROVAL_THRESHOLD');
    eq([notifyFormatClock('07:00 AM', 'en'), notifyFormatClock('07:00 AM', 'ta'), notifyFormatClock('6:30 pm', 'ta'), notifyFormatClock('12:15 AM', 'en'), notifyFormatClock('Evening', 'en')],
        ['7:00 am', 'காலை 7:00', 'மாலை 6:30', '12:15 am', 'Evening'], 'pooja times are formatted per language');
    eq([notifyFormatDate('2026-09-20', 'en'), notifyFormatDate('2026-09-20', 'ta')], ['20 Sep 2026', '20 செப்டம்பர் 2026'], 'dates are formatted per language');
    eq(notifyParseLocal('2026-10-02T18:00'), '2026-10-02 18:00:00', 'a datetime-local value is parsed');
    eq(notifyParseLocal('2026-02-30 18:00'), null, 'an impossible schedule time is refused');
    eq(notifyPickLang(['en' => 'Hello', 'ta' => 'வணக்கம்'], 'hi'), 'வணக்கம்', 'a language map falls back to Tamil before English');
    eq(notifyPickLang(['fr' => 'Bonjour'], 'hi'), 'Bonjour', '…and to any language after that');
    $langs = notifyLanguages();
    ok(isset($langs['ta'], $langs['en']) && $langs['ta'] === 'தமிழ்', 'languages include Tamil and English with native labels');
    putenv('NOTIFY_LANGUAGES=hi,te');
    eq(array_keys(notifyLanguages()), ['ta', 'en', 'hi', 'te'], 'Tamil and English are always offered');
    putenv('NOTIFY_LANGUAGES');
    ok(strlen(notifySecret()) >= 32, 'a secret of at least 32 characters exists');
    $cats = notifyCategories();
    ok(isset($cats['booking'], $cats['promotional']) && $cats['booking']['mutable'] === false && $cats['promotional']['mutable'] === true, 'categories carry the mutable flag by kind');
} finally {
    // Remove everything this run created, whatever failed above.
    $like = addcslashes($prefix, '%_\\') . '%';
    $db->prepare('DELETE FROM seva_bookings WHERE devotee_name = :n')->execute([':n' => 'E2E-COREUNIT-' . $run]);
    $db->prepare('DELETE FROM donations WHERE name = :n')->execute([':n' => 'E2E-COREUNIT-' . $run]);
    $db->prepare('DELETE FROM devotees WHERE email LIKE :p')->execute([':p' => $like]);
}

$left = $db->prepare('SELECT COUNT(*) FROM devotees WHERE email LIKE :p');
$left->execute([':p' => addcslashes($prefix, '%_\\') . '%']);
ok((int) $left->fetchColumn() === 0, 'cleanup removed every fixture devotee');

echo "\n" . $passed . ' passed, ' . count($failures) . " failed\n";
if ($failures) {
    echo "Failures:\n  - " . implode("\n  - ", $failures) . "\n";
    exit(1);
}
exit(0);
