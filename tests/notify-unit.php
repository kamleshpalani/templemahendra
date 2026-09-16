<?php
/**
 * tests/notify-unit.php — the Notification Service's rules, checked one at a
 * time against the real code and the real database.
 *
 *   PHP_BIN=/path/to/php.sh; $PHP_BIN tests/notify-unit.php
 *
 * What it proves (docs/registration/SPEC.md §6, docs/notifications/SPEC.md §5):
 *   • the channel policy matrix, in order, for registered families (with and
 *     without consent, unsubscribed) and guests, including provider fallbacks;
 *   • the recipient shape read from a registration, consent and unsubscribe;
 *   • signed tokens, which call-to-action links are allowed, time zones,
 *     recurrence and retry backoff;
 *   • audience rules: human error messages, retired fields, counts against
 *     registrations this file creates, and the automatic consent filter that
 *     keeps an update's estimate honest;
 *   • the event catalogue and the registration_received template, and that no
 *     message points at an account;
 *   • the online-payment events and templates (docs/payments/SPEC.md §6):
 *     catalogue rows and dedupe keys, variables, titles, SMS lengths (also with
 *     a real tracked link), wording rules, and a guest donor's messages;
 *   • end to end with the test drivers: informational messages stop on every
 *     channel when a family unsubscribes (also after queueing) while a booking
 *     confirmation still goes, guests and families without consent get no
 *     update, and every update carries its unsubscribe link on every channel.
 *
 * Needs the database from docs/notifications/SPEC.md §1. Creates registrations
 * as e2e-notify-unit-<run>-*@example.test / "E2E-NOTIFY-UNIT <run> …" and
 * bookings/donations named E2E-NOTIFY-UNIT-<run>, and deletes them before exiting.
 */

if (PHP_SAPI !== 'cli') exit(1);

// Deterministic drivers: every provider is the test fake unless a check swaps one out.
putenv('NOTIFY_ALLOW_TEST_DRIVER=1');
foreach (['EMAIL', 'WHATSAPP', 'SMS'] as $c) putenv("NOTIFY_{$c}_DRIVER=test");
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

/** Lines of backend/logs/notify-test.log for these delivery ids, as arrays keyed by delivery id (the last attempt wins). */
function testLog(array $deliveryIds): array
{
    $file = __DIR__ . '/../backend/logs/notify-test.log';
    $want = array_flip(array_map('intval', $deliveryIds));
    $out  = [];
    foreach (is_file($file) ? file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) : [] as $line) {
        $row = json_decode($line, true);
        if (is_array($row) && isset($want[(int) ($row['deliveryId'] ?? 0)])) $out[(int) $row['deliveryId']] = $row;
    }
    return $out;
}

if (!notifyTablesExist()) {
    echo "The notification tables are missing; apply migrations 007 and 009 first.\n";
    exit(1);
}

$run    = base_convert((string) time(), 10, 36) . bin2hex(random_bytes(2));
$prefix = "e2e-notify-unit-{$run}-";
$names  = "E2E-NOTIFY-UNIT {$run} ";
$dedupe = "e2e:notify-unit:{$run}:";
$db     = getDB();

try {
    /* ── Channel policy ─────────────────────────────────────────────────── */
    section('Channel policy (registration SPEC §6)');

    $family = static fn(array $over = []): array => array_replace([
        'devotee_id' => 1001, 'name' => 'Kavitha', 'email' => 'kavitha@example.test', 'phone' => '919800001234',
        'country' => 'IN', 'lang' => 'ta', 'timezone' => 'Asia/Kolkata', 'active' => true, 'consent' => true, 'unsubscribed' => false,
    ], $over);
    $noConsent    = $family(['consent' => false]);
    $unsubscribed = $family(['consent' => false, 'unsubscribed' => true]);
    $guest        = notifyGuestRecipient('guest@example.test', '919800005678');
    $decide = static function (string $channel, string $category, string $priority, array $recipient, bool $campaign = false): array {
        return notifyAllowedChannels([$channel], $category, $priority, $recipient, $campaign)[$channel];
    };
    $is = static function (array $decision, string $status, ?string $reason, string $label): void {
        ok($decision['status'] === $status && $decision['reason'] === $reason, $label,
            'got ' . $decision['status'] . ($decision['reason'] !== null ? ' (' . $decision['reason'] . ')' : ''));
    };

    // 1. Only email, WhatsApp and SMS.
    eq(array_keys(notifyAllowedChannels(['email', 'inapp', 'push', 'nonsense', 'email', 'sms'], 'booking', 'important', $family(), false)), ['email', 'sms'],
        '1 retired (in-app, push), unknown and repeated channels are dropped before policy');
    eq(NOTIFY_CHANNELS, ['email', 'whatsapp', 'sms'], '1 the live channels are email, WhatsApp and SMS');
    eq(NOTIFY_RETIRED_CHANNELS, ['inapp', 'push'], '1 in-app and push are kept only as retired labels');
    eq([notifyChannelLabel('push'), notifyChannelLabel('inapp'), notifyChannelLabel('sms')], ['Push (retired)', 'In-app (retired)', 'SMS'], '1 retired channels are labelled for historic rows');
    $is(notifyChannelDecision('push', 'booking', 'important', $family(), false), 'skipped', 'unknown channel', '1 a retired channel asked directly is never queued');
    eq(notifyAllowedChannels(['inapp', 'push'], 'general', 'urgent', $family(), false), [], '1 a request for retired channels only decides nothing');

    // 2. Contact.
    $is($decide('email', 'booking', 'important', $family(['email' => 'not-an-email'])), 'skipped', 'no email', '2 email needs a valid address');
    $is($decide('email', 'booking', 'important', $family(['email' => null])), 'skipped', 'no email', '2 a registration without an email has no email channel');
    $is($decide('sms', 'booking', 'important', $family(['phone' => null])), 'skipped', 'no phone', '2 SMS needs a phone');
    $is($decide('whatsapp', 'booking', 'important', $family(['phone' => '12345'])), 'skipped', 'no phone', '2 WhatsApp needs a dialable phone');
    $is($decide('email', 'general', 'normal', $family(['email' => null, 'consent' => false])), 'skipped', 'no email', '2 contact is checked before consent');

    // 3. Provider, and fallbacks.
    putenv('NOTIFY_WHATSAPP_DRIVER=nonexistent');
    notifyProviderFor('whatsapp', true);
    $is($decide('whatsapp', 'booking', 'important', $family()), 'skipped', 'not configured', '3 an unconfigured provider is skipped, not failed');
    $is($decide('whatsapp', 'general', 'normal', $noConsent), 'skipped', 'not configured', '3 the provider is checked before consent');
    $withFallback = notifyAllowedChannels(['email', 'whatsapp'], 'booking', 'important', $family(), false, ['whatsapp' => 'sms']);
    ok(isset($withFallback['sms']) && $withFallback['sms']['status'] === 'queued' && ($withFallback['sms']['fallbackFor'] ?? null) === 'whatsapp',
        '3 fallback whatsapp → sms is added and queued', json_encode($withFallback));
    $fallbackRules = notifyAllowedChannels(['whatsapp'], 'general', 'normal', $family(), false, ['whatsapp' => 'sms']);
    ok(($fallbackRules['sms']['reason'] ?? null) === 'sms reserved for important messages', '3 a fallback channel still goes through every rule', json_encode($fallbackRules));
    $fallbackConsent = notifyAllowedChannels(['whatsapp'], 'general', 'important', $noConsent, false, ['whatsapp' => 'sms']);
    ok(($fallbackConsent['sms']['reason'] ?? null) === 'no consent', '3 a fallback cannot bypass consent', json_encode($fallbackConsent));
    $both = notifyAllowedChannels(['whatsapp', 'sms'], 'general', 'normal', $family(), false, ['whatsapp' => 'sms']);
    ok(($both['sms']['reason'] ?? null) === 'sms reserved for important messages' && !isset($both['sms']['fallbackFor']), '3 a channel requested in its own right keeps its own decision', json_encode($both));
    $noFallbackWhenConfigured = notifyAllowedChannels(['sms'], 'booking', 'important', $family(), false, ['sms' => 'whatsapp']);
    ok(!isset($noFallbackWhenConfigured['whatsapp']), '3 no fallback when the first channel is configured');
    putenv('NOTIFY_WHATSAPP_DRIVER=test');
    notifyProviderFor('whatsapp', true);
    $is($decide('whatsapp', 'booking', 'important', $family()), 'queued', null, '3 restoring the driver makes the channel available again');

    // 4. Consent by kind.
    foreach (['booking', 'donation', 'payment', 'membership'] as $cat) {
        $is($decide('email', $cat, 'normal', $noConsent), 'queued', null, "4 transactional ({$cat}) needs no consent");
    }
    $is($decide('whatsapp', 'booking', 'important', $unsubscribed), 'queued', null, '4 an unsubscribe does not stop a booking WhatsApp');
    $is($decide('sms', 'donation', 'important', $unsubscribed), 'queued', null, '4 …or a donation SMS');
    $is($decide('email', 'booking', 'normal', $guest), 'queued', null, '4 a guest booking email needs no consent');
    foreach (['general', 'announcement', 'festival', 'pooja', 'event', 'volunteer'] as $cat) {
        $is($decide('email', $cat, 'normal', $noConsent), 'skipped', 'no consent', "4 informational ({$cat}) needs consent");
    }
    $is($decide('email', 'festival', 'normal', $family()), 'queued', null, '4 informational email to a consenting family is queued');
    $is($decide('whatsapp', 'festival', 'normal', $family()), 'queued', null, '4 informational WhatsApp to a consenting family is queued');
    $is($decide('email', 'festival', 'normal', $unsubscribed), 'skipped', 'unsubscribed', '4 unsubscribed stops informational email');
    $is($decide('whatsapp', 'festival', 'normal', $unsubscribed), 'skipped', 'unsubscribed', '4 unsubscribed stops informational WhatsApp');
    $is($decide('sms', 'festival', 'important', $unsubscribed), 'skipped', 'unsubscribed', '4 unsubscribed stops informational SMS');
    $is($decide('email', 'festival', 'normal', $family(['unsubscribed' => true])), 'skipped', 'unsubscribed', '4 unsubscribed wins over a consent flag');
    $is($decide('email', 'emergency', 'emergency', $noConsent), 'skipped', 'no consent', '4 critical (emergency) needs consent');
    $is($decide('sms', 'emergency', 'emergency', $unsubscribed), 'skipped', 'unsubscribed', '4 critical stops on unsubscribe');
    $is($decide('sms', 'emergency', 'emergency', $family()), 'queued', null, '4 critical SMS to a consenting family is queued');
    $is($decide('email', 'festival', 'urgent', $guest), 'skipped', 'no consent', '4 a guest gets no informational message');
    $is($decide('whatsapp', 'emergency', 'emergency', $guest), 'skipped', 'no consent', '4 …and no critical message');
    $is($decide('email', 'festival', 'normal', array_replace($guest, ['test' => true])), 'queued', null, '4 an admin test send to a typed address bypasses consent');
    $is($decide('email', 'promotional', 'normal', $noConsent), 'skipped', 'no consent', '4 promotional (inactive) is treated as informational');
    $is($decide('email', 'promotional', 'normal', $family()), 'queued', null, '4 …and goes to a consenting family');
    $is($decide('email', 'security', 'urgent', $noConsent), 'queued', null, '4 security (inactive) is treated as transactional');
    $is($decide('email', 'no_such_category', 'normal', $noConsent), 'skipped', 'no consent', '4 an unknown category needs consent (a mistake can only send less)');
    $is($decide('email', 'announcement', 'normal', $family(), true), 'queued', null, '4 an informational campaign to a consenting family is queued');
    $is($decide('email', 'booking', 'normal', $noConsent, true), 'queued', null, '4 a transactional campaign needs no consent');
    eq(NOTIFY_CONSENT_REASONS, ['no consent', 'unsubscribed'], '4 the reasons re-checked at dispatch are exactly the consent reasons');

    // 5. SMS restraint.
    $is($decide('sms', 'general', 'normal', $family()), 'skipped', 'sms reserved for important messages', '5 routine informational SMS is not sent');
    $is($decide('sms', 'promotional', 'normal', $family()), 'skipped', 'sms reserved for important messages', '5 routine promotional SMS is not sent');
    $is($decide('sms', 'general', 'important', $family()), 'queued', null, '5 important informational SMS is sent');
    $is($decide('sms', 'booking', 'normal', $noConsent), 'queued', null, '5 transactional SMS at normal priority is sent');
    $is($decide('sms', 'emergency', 'normal', $family()), 'queued', null, '5 critical SMS is not restrained');

    // 6. Otherwise queued.
    $is($decide('whatsapp', 'general', 'normal', $family()), 'queued', null, '6 WhatsApp with nothing against it is queued');
    $is($decide('sms', 'booking', 'important', $guest), 'queued', null, '6 guest SMS for a booking is queued');

    /* ── Recipients, consent and unsubscribe ────────────────────────────── */
    section('Recipients from registrations, consent and unsubscribe');

    $now = gmdate('Y-m-d H:i:s');
    $old = gmdate('Y-m-d H:i:s', time() - 400 * 86400);
    $make = static function (string $key, array $cols, int $members = 0) use ($db, $prefix, $names, $now): int {
        $row = $cols + ['name' => $names . $key, 'email' => $prefix . $key . '@example.test', 'phone' => null, 'phone_country' => 'IN',
                        'country' => 'IN', 'state' => 'TN', 'city' => 'Pudupatti', 'address1' => '12 Middle Street', 'lang' => 'ta',
                        'updates_consent_at' => null, 'unsubscribed_at' => null, 'is_active' => 1, 'created_at' => $now];
        $cols = array_keys($row);
        $db->prepare('INSERT INTO devotees (' . implode(',', $cols) . ') VALUES (:' . implode(',:', $cols) . ')')
           ->execute(array_combine(array_map(static fn($n) => ':' . $n, $cols), array_values($row)));
        $id = (int) $db->lastInsertId();
        $ins = $db->prepare("INSERT INTO devotee_family_members (devotee_id, name, relationship, age, sort_order) VALUES (:d, :n, 'son', NULL, :o)");
        for ($i = 0; $i < $members; $i++) $ins->execute([':d' => $id, ':n' => 'Member ' . ($i + 1), ':o' => $i]);
        return $id;
    };

    $ids = [
        'a' => $make('a', ['phone' => '919800000011', 'updates_consent_at' => $now], 3),
        'b' => $make('b', ['country' => 'GB', 'state' => 'ENG', 'city' => 'Leicester', 'lang' => 'en', 'phone_country' => 'GB',
                           'updates_consent_at' => $old, 'unsubscribed_at' => $now, 'created_at' => $old]),
        'c' => $make('c', ['email' => null, 'country' => 'SG', 'state' => null, 'city' => 'Singapore', 'lang' => 'en', 'phone' => '6591234567', 'phone_country' => 'SG'], 1),
        'd' => $make('d', ['city' => 'Tenkasi', 'phone' => '919800000044']),
        'e' => $make('e', ['email' => null, 'country' => null, 'state' => null, 'city' => 'Pudupatti North', 'updates_consent_at' => $now], 5),
        'x' => $make('x', ['is_active' => 0, 'updates_consent_at' => $now, 'phone' => '919800000099']),
    ];

    $r = notifyRecipientFromDevotee($ids['a']);
    eq(array_keys($r), ['devotee_id', 'name', 'email', 'phone', 'country', 'lang', 'timezone', 'active', 'consent', 'unsubscribed'], 'the recipient shape is exactly the SPEC §6 keys');
    eq([$r['devotee_id'], $r['lang'], $r['timezone'], $r['active'], $r['consent'], $r['unsubscribed']], [$ids['a'], 'ta', 'Asia/Kolkata', true, true, false], 'a consenting Tamil registration in India');
    $r = notifyRecipientFromDevotee($ids['b']);
    eq([$r['lang'], $r['timezone'], $r['consent'], $r['unsubscribed'], $r['phone']], ['en', 'Europe/London', false, true, null], 'an unsubscribed English registration in Britain has no consent and no phone');
    $r = notifyRecipientFromDevotee($ids['c']);
    eq([$r['email'], $r['phone'], $r['consent'], $r['timezone']], [null, '6591234567', false, 'Asia/Singapore'], 'a registration without email or consent');
    eq(notifyRecipientFromDevotee($ids['x'])['active'], false, 'an archived registration is inactive');
    eq(notifyRecipientFromDevotee(999999999)['devotee_id'], null, 'a registration that does not exist has no devotee_id');
    $guestShape = notifyGuestRecipient(null, '919800001234', 'en');
    eq([$guestShape['devotee_id'], $guestShape['consent'], $guestShape['unsubscribed'], $guestShape['lang']], [null, false, false, 'en'], 'a guest has no consent');

    $state = notifyConsentState($ids['a']);
    eq([$state['consent'], $state['unsubscribed'], $state['active'], $state['unsubscribedAt']], [true, false, true, null], 'notifyConsentState: consenting');
    eq(notifyConsentState($ids['b'])['consent'], false, 'notifyConsentState: unsubscribed has no consent');
    eq(notifyConsentState(999999999), null, 'notifyConsentState: no such registration');

    $d = $ids['d'];
    ok(notifyUnsubscribe($d) === true, 'notifyUnsubscribe succeeds for a registration');
    $db->prepare("UPDATE devotees SET unsubscribed_at = '2025-01-02 03:04:05' WHERE id = :id")->execute([':id' => $d]);
    ok(notifyUnsubscribe($d) === true, 'unsubscribing again succeeds');
    $first = $db->prepare('SELECT unsubscribed_at FROM devotees WHERE id = :id');
    $first->execute([':id' => $d]);
    eq($first->fetchColumn(), '2025-01-02 03:04:05', 'unsubscribing again keeps the FIRST unsubscribe time');
    ok(notifyUnsubscribe(999999999) === false, 'unsubscribing a registration that does not exist returns false');
    $db->prepare('UPDATE devotees SET unsubscribed_at = NULL WHERE id = :id')->execute([':id' => $d]);
    eq([notifyMaskPhone('919876543210'), notifyMaskPhone('+44 7700 900123'), notifyMaskPhone('123')], ['+91 ••••••3210', '+••••••••0123', ''], 'phones are masked to their last four digits');
    ok(!function_exists('notifyPreferencesUrl') && !function_exists('notifyPrefs') && !function_exists('notifySavePrefs'), 'the preferences functions are gone');
    ok(!function_exists('notifyOtpIssue') && !function_exists('notifyRegisterDevice') && !function_exists('notifyVapidKeys'), 'the OTP, device and VAPID functions are gone');
    foreach (['prefs.php', 'otp.php', 'devices.php', 'providers/NotifyWebPushProvider.php', 'providers/NotifyFcmProvider.php', 'providers/NotifyEcKeys.php'] as $gone) {
        ok(!is_file(__DIR__ . '/../backend/includes/notify/' . $gone), "notify/{$gone} is deleted");
    }
    eq(array_keys(notifyProviderRegistry()), ['email', 'whatsapp', 'sms'], 'the provider registry has only email, WhatsApp and SMS');
    $cats = notifyCategories(false);
    ok($cats['booking']['consent'] === false && $cats['announcement']['consent'] === true && $cats['emergency']['consent'] === true
        && $cats['security']['consent'] === false && $cats['promotional']['consent'] === true, 'categories carry the consent flag by kind', json_encode(array_map(fn($c) => $c['consent'], $cats)));
    ok($cats['security']['is_active'] === 0 && $cats['promotional']['is_active'] === 0, 'security and promotional categories are inactive');

    /* ── Tokens ─────────────────────────────────────────────────────────── */
    section('Signed tokens');
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
    eq(notifyTokenVerify('u0.previewonlylink0'), null, 'the preview unsubscribe link verifies for nobody');
    ok(invalid(static fn() => notifyToken('z', 1)) !== null, 'issuing a token of an unknown kind throws');
    ok(invalid(static fn() => notifyToken('c', 0)) !== null, 'issuing a token for id 0 throws');
    ok((bool) preg_match('#^https://temple\.example\.test/api/n/c/c55\.[A-Za-z0-9_-]{16}$#', (string) notifyTrackedUrl(55, '/sevas')), 'tracked URL is siteUrl(/api/n/c/<token>)');
    eq(notifyTrackedUrl(55, null), null, 'no target, no tracked URL');
    eq(notifyTrackedUrl(55, '  '), null, 'a blank target, no tracked URL');
    ok(str_starts_with(notifyOpenPixelUrl(55), 'https://temple.example.test/api/n/o/o55.'), 'open pixel URL');
    ok(str_starts_with(notifyUnsubscribeUrl(7), 'https://temple.example.test/api/n/u/u7.'), 'unsubscribe URL');

    /* ── CTA safety ─────────────────────────────────────────────────────── */
    section('notifySafeCtaUrl');
    $cta = [
        ['/sevas', '/sevas'], ['/contact', '/contact'], ['  /events  ', '/events'],
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
    eq(notifyAbsoluteUrl('/sevas'), 'https://temple.example.test/sevas', 'a site path becomes absolute for email and WhatsApp');

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
    eq(notifyTimezoneFor(null, 'GB'), 'Europe/London', 'GB families default to London');
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
    $timeSource = (string) file_get_contents(__DIR__ . '/../backend/includes/notify/time.php');
    ok(str_contains($timeSource, 'SELECT lang, updates_consent_at, unsubscribed_at FROM devotees') && !str_contains($timeSource, 'phone_verified_at'),
        'notifyTablesExist() probes the migration 009 columns, not phone_verified_at');
    eq([notifyBool('yes'), notifyBool(0), notifyBool('maybe')], [true, false, null], 'notifyBool lives in time.php and reads form values');

    /* ── Recurrence and backoff ─────────────────────────────────────────── */
    section('Recurrence and retry backoff');
    eq(notifyNextOccurrence('2027-01-31 09:00:00', 'monthly', 31), '2027-02-28 09:00:00', 'monthly from 31 January clamps to 28 February');
    eq(notifyNextOccurrence('2027-02-28 09:00:00', 'monthly', 31), '2027-03-31 09:00:00', '…and returns to the 31st in March');
    eq(notifyNextOccurrence('2028-01-31 07:30:00', 'monthly', 31), '2028-02-29 07:30:00', 'a leap year clamps to 29 February');
    eq(notifyNextOccurrence('2026-12-31 23:30:00', 'daily'), '2027-01-01 23:30:00', 'daily crosses the year');
    eq(notifyNextOccurrence('2026-09-13 06:00:00', 'weekly'), '2026-09-20 06:00:00', 'weekly adds seven days');
    eq(notifyNextOccurrence('2026-09-13 06:00:00', 'none'), null, 'no recurrence, no next time');
    foreach ([1 => 60, 2 => 300, 3 => 1800, 4 => 7200, 5 => 21600, 9 => 21600] as $attempts => $base) {
        $min = PHP_INT_MAX;
        $max = 0;
        for ($i = 0; $i < 300; $i++) {
            $s = notifyBackoffSeconds($attempts);
            $min = min($min, $s);
            $max = max($max, $s);
        }
        ok($min >= (int) floor($base * 0.9) && $max <= (int) ceil($base * 1.1) && $max > $min, "after {$attempts} attempt(s) the wait is {$base}s ±10%, jittered", "saw {$min}..{$max}");
    }
    eq(notifyBackoffSeconds(1, 100000), 100000, "a provider's longer Retry-After wins");
    eq(notifyRatePerMinute('sms'), 30, 'SMS throttle defaults to 30 per minute');
    putenv('NOTIFY_RATE_SMS_PER_MIN=2');
    eq(notifyRatePerMinute('sms'), 2, 'NOTIFY_RATE_SMS_PER_MIN overrides it');
    putenv('NOTIFY_RATE_SMS_PER_MIN=zero');
    eq(notifyRatePerMinute('sms'), 30, 'a nonsense rate falls back to the default');
    putenv('NOTIFY_RATE_SMS_PER_MIN');
    eq(array_map('notifyRatePerMinute', ['email', 'whatsapp', 'sms']), [60, 80, 30], 'email, WhatsApp and SMS throttles default to 60, 80, 30');
    eq(array_keys(NOTIFY_MAX_ATTEMPTS), ['email', 'whatsapp', 'sms'], 'attempt limits exist only for the live channels');

    /* ── Audience ───────────────────────────────────────────────────────── */
    section('Audience rules: validation');
    $errors = [
        'no mode'             => [[], 'Choose who should receive this'],
        'bad mode'            => [['mode' => 'everyone'], 'Choose who should receive this'],
        'empty selection'     => [['mode' => 'selected', 'devotee_ids' => []], 'Choose at least one family'],
        'too many selected'   => [['mode' => 'selected', 'devotee_ids' => range(1, 5001)], 'at most 5000'],
        'no rules'            => [['mode' => 'rules', 'match' => 'all', 'rules' => []], 'Add at least one rule'],
        'bad match'           => [['mode' => 'rules', 'match' => 'some', 'rules' => [['field' => 'has_booking', 'op' => 'is', 'value' => true]]], 'all rules or any rule'],
        'unknown field'       => [['mode' => 'rules', 'rules' => [['field' => 'd.id; DROP TABLE devotees', 'op' => 'is', 'value' => 1]]], 'Rule 1 uses a field'],
        'wrong op'            => [['mode' => 'rules', 'rules' => [['field' => 'country', 'op' => 'contains', 'value' => 'IN']]], 'Rule 1 (Country) cannot use that comparison'],
        'bad country'         => [['mode' => 'rules', 'rules' => [['field' => 'country', 'op' => 'in', 'value' => ['IND']]]], 'two-letter country codes'],
        'empty list'          => [['mode' => 'rules', 'rules' => [['field' => 'state', 'op' => 'in', 'value' => []]]], 'choose at least one value'],
        'city blank'          => [['mode' => 'rules', 'rules' => [['field' => 'city', 'op' => 'contains', 'value' => '  ']]], 'type a city'],
        'bool maybe'          => [['mode' => 'rules', 'rules' => [['field' => 'consent', 'op' => 'is', 'value' => 'maybe']]], 'choose yes or no'],
        'has_email maybe'     => [['mode' => 'rules', 'rules' => [['field' => 'has_email', 'op' => 'is', 'value' => []]]], 'choose yes or no'],
        'family size zero'    => [['mode' => 'rules', 'rules' => [['field' => 'family_size', 'op' => 'gte', 'value' => 0]]], 'between 1 and 100'],
        'family size words'   => [['mode' => 'rules', 'rules' => [['field' => 'family_size', 'op' => 'lte', 'value' => 'four']]], 'whole number of people'],
        'family size op'      => [['mode' => 'rules', 'rules' => [['field' => 'family_size', 'op' => 'in', 'value' => 2]]], 'Rule 1 (Family size) cannot use that comparison'],
        'negative days'       => [['mode' => 'rules', 'rules' => [['field' => 'registered_days', 'op' => 'lte', 'value' => -1]]], 'between 0 and 36500'],
        'fractional days'     => [['mode' => 'rules', 'rules' => [['field' => 'registered_days', 'op' => 'lte', 'value' => '2.5']]], 'whole number of days'],
        'bad amount'          => [['mode' => 'rules', 'rules' => [['field' => 'donated_total', 'op' => 'gte', 'value' => 'lots']]], 'enter an amount'],
        'language not ta/en'  => [['mode' => 'rules', 'rules' => [['field' => 'lang', 'op' => 'in', 'value' => ['hi']]]], 'choose Tamil or English'],
        'bad status'          => [['mode' => 'rules', 'rules' => [['field' => 'booking_status', 'op' => 'in', 'value' => ['lost']]]], 'pending, confirmed'],
        'bad tag'             => [['mode' => 'rules', 'rules' => [['field' => 'tag', 'op' => 'in', 'value' => ['no spaces!']]]], 'tags use lowercase'],
        'bad seva id'         => [['mode' => 'rules', 'rules' => [['field' => 'booked_seva', 'op' => 'in', 'value' => ['abc']]]], 'choose sevas'],
        'second rule counted' => [['mode' => 'rules', 'rules' => [['field' => 'has_booking', 'op' => 'is', 'value' => true], ['field' => 'tag', 'op' => 'in']]], 'Rule 2 (Tag)'],
        'unreadable json'     => ['{"mode":', 'could not be read'],
    ];
    foreach (NOTIFY_AUDIENCE_RETIRED_FIELDS as $field => $label) {
        $errors["retired field {$field}"] = [['mode' => 'rules', 'rules' => [['field' => 'country', 'op' => 'in', 'value' => ['IN']], ['field' => $field, 'op' => 'is', 'value' => true]]],
                                            "Rule 2 uses \"{$label}\", which no longer exists"];
    }
    foreach ($errors as $label => [$rules, $needle]) {
        $message = invalid(static fn() => notifyAudienceNormalize($rules));
        ok($message !== null && stripos($message, $needle) !== false, "rejects {$label} with a human message", (string) $message);
    }
    eq(array_keys(NOTIFY_AUDIENCE_RETIRED_FIELDS), ['email_verified', 'phone_verified', 'last_login_days', 'channel_enabled', 'category_not_muted'], 'the five sign-in fields are retired');
    $stored = '{"mode":"rules","match":"any","rules":[{"field":"email_verified","op":"is","value":true},{"field":"city","op":"contains","value":"x"},{"field":"category_not_muted","op":"is","value":"festival"}]}';
    eq(notifyAudienceRetiredFieldsIn($stored), ['email_verified' => 'Email confirmed', 'category_not_muted' => 'Has not muted the category'], 'a stored audience using retired fields is listed, not crashed on');
    eq([notifyAudienceRetiredFieldsIn('not json'), notifyAudienceRetiredFieldsIn(['mode' => 'all_devotees']), notifyAudienceRetiredFieldsIn(null)], [[], [], []], 'flagging never throws on other input');
    $normal = notifyAudienceNormalize('{"mode":"rules","rules":[{"field":"country","op":"in","value":"in, sg"},{"field":"tag","op":"in","value":["Volunteer"]},{"field":"consent","op":"is","value":"true"},{"field":"family_size","op":"gte","value":"3"},{"field":"lang","op":"in","value":["EN"]}]}');
    eq($normal['rules'][0]['value'], ['IN', 'SG'], 'country codes are upper-cased and split from text');
    eq($normal['rules'][1]['value'], ['volunteer'], 'tags are lower-cased');
    eq($normal['rules'][2]['value'], true, '"true" becomes a boolean');
    eq($normal['rules'][3]['value'], 3, 'a family size becomes a number');
    eq($normal['rules'][4]['value'], ['en'], 'a language is lower-cased');
    eq($normal['match'], 'all', 'match defaults to all');
    eq(notifyAudienceNormalize(['mode' => 'selected', 'devotee_ids' => [5, '3', 5, -1, 'x']])['devotee_ids'], [3, 5], 'selected ids are de-duplicated, sorted and cleaned');
    $q = notifyAudienceQuery(['mode' => 'rules', 'rules' => [['field' => 'city', 'op' => 'contains', 'value' => "50%_off' OR 1=1 --"]]]);
    ok(str_starts_with($q['sql'], 'SELECT d.id FROM devotees d') && str_ends_with($q['sql'], 'ORDER BY d.id'), 'the query selects d.id and orders by it');
    ok(!str_contains($q['sql'], '1=1') && in_array('%50\\%\\_off\' OR 1=1 --%', $q['params'], true), 'values are bound, with LIKE wildcards escaped', json_encode($q));
    ok(str_contains($q['sql'], 'd.is_active = 1') && !str_contains($q['sql'], 'devotee_notification_prefs'), 'every audience excludes archived registrations and no longer reads preferences');
    ok(!str_contains($q['sql'], 'updates_consent_at'), 'an audience with no category is not limited to consent');
    ok(str_contains(notifyAudienceQuery(['mode' => 'all_devotees'], 'festival')['sql'], NOTIFY_AUDIENCE_CONSENT_SQL), 'an informational category adds the consent filter to the query');
    ok(!str_contains(notifyAudienceQuery(['mode' => 'all_devotees'], 'booking')['sql'], 'updates_consent_at'), 'a transactional category does not');

    section('Audience rules: counts against fixture registrations');
    $tag = 'e2e-notify-unit-' . $run;
    $tagIns = $db->prepare("INSERT INTO devotee_tags (devotee_id, tag, created_by) VALUES (:d, :t, 'e2e')");
    foreach ($ids as $id) $tagIns->execute([':d' => $id, ':t' => $tag]);
    $tagIns->execute([':d' => $ids['a'], ':t' => $tag . '-volunteer']);
    $tagIns->execute([':d' => $ids['c'], ':t' => $tag . '-volunteer']);
    $seva = $db->query('SELECT id FROM sevas ORDER BY id LIMIT 1')->fetchColumn();
    $bookingIns = $db->prepare('INSERT INTO seva_bookings (devotee_id, devotee_name, phone, seva_id, seva_name, preferred_date, status, created_at) VALUES (:d, :n, :p, :s, :sn, NULL, :st, :c)');
    $bookingIns->execute([':d' => $ids['a'], ':n' => 'E2E-NOTIFY-UNIT-' . $run, ':p' => '919800000011', ':s' => $seva ?: null, ':sn' => 'Abhishekam', ':st' => 'confirmed', ':c' => $now]);
    $bookingIns->execute([':d' => $ids['b'], ':n' => 'E2E-NOTIFY-UNIT-' . $run, ':p' => '447700900123', ':s' => null, ':sn' => 'Archana', ':st' => 'cancelled', ':c' => $old]);
    $bookingIns->execute([':d' => $ids['x'], ':n' => 'E2E-NOTIFY-UNIT-' . $run, ':p' => '919800000099', ':s' => null, ':sn' => 'Archana', ':st' => 'confirmed', ':c' => $now]);
    $donationIns = $db->prepare('INSERT INTO donations (devotee_id, name, phone, amount, purpose, created_at) VALUES (:d, :n, :p, :a, :pu, :c)');
    $donationIns->execute([':d' => $ids['a'], ':n' => 'E2E-NOTIFY-UNIT-' . $run, ':p' => '919800000011', ':a' => 600, ':pu' => 'annadanam', ':c' => $now]);
    $donationIns->execute([':d' => $ids['a'], ':n' => 'E2E-NOTIFY-UNIT-' . $run, ':p' => '919800000011', ':a' => 501, ':pu' => '', ':c' => $old]);
    $donationIns->execute([':d' => $ids['c'], ':n' => 'E2E-NOTIFY-UNIT-' . $run, ':p' => '6591234567', ':a' => 250, ':pu' => '', ':c' => $old]);

    // Every count is confined to this run's registrations by the run tag, so other
    // data in a shared database cannot change the expected numbers.
    $scoped = static fn(array $rules): array => ['mode' => 'rules', 'match' => 'all', 'rules' => [['field' => 'tag', 'op' => 'in', 'value' => [$tag]], ...$rules]];
    $expect = [
        'tag in (the run tag), archived registration excluded' => [[], 5],
        'country in IN'                                      => [[['field' => 'country', 'op' => 'in', 'value' => ['IN']]], 2],
        'country not in IN (NULL country counts as not IN)'  => [[['field' => 'country', 'op' => 'not_in', 'value' => ['IN']]], 3],
        'state in TN'                                        => [[['field' => 'state', 'op' => 'in', 'value' => ['TN']]], 2],
        'city contains pudupatti (case-insensitive)'         => [[['field' => 'city', 'op' => 'contains', 'value' => 'PUDUPATTI']], 2],
        'city equals Pudupatti'                              => [[['field' => 'city', 'op' => 'equals', 'value' => 'pudupatti']], 1],
        'lang in ta (devotees.lang)'                         => [[['field' => 'lang', 'op' => 'in', 'value' => ['ta']]], 3],
        'lang in en'                                         => [[['field' => 'lang', 'op' => 'in', 'value' => ['en']]], 2],
        'agreed to updates (an unsubscribe does not count)'  => [[['field' => 'consent', 'op' => 'is', 'value' => true]], 2],
        'has not agreed to updates'                          => [[['field' => 'consent', 'op' => 'is', 'value' => false]], 3],
        'has an email'                                       => [[['field' => 'has_email', 'op' => 'is', 'value' => true]], 3],
        'has no email'                                       => [[['field' => 'has_email', 'op' => 'is', 'value' => false]], 2],
        'has a phone'                                        => [[['field' => 'has_phone', 'op' => 'is', 'value' => true]], 3],
        'has no phone'                                       => [[['field' => 'has_phone', 'op' => 'is', 'value' => false]], 2],
        'family of at least 2 (registrant + members)'        => [[['field' => 'family_size', 'op' => 'gte', 'value' => 2]], 3],
        'family of 1 (no members added)'                     => [[['field' => 'family_size', 'op' => 'lte', 'value' => 1]], 2],
        'family of 4 or 5'                                   => [[['field' => 'family_size', 'op' => 'gte', 'value' => 4], ['field' => 'family_size', 'op' => 'lte', 'value' => 5]], 1],
        'registered within 30 days'                          => [[['field' => 'registered_days', 'op' => 'lte', 'value' => 30]], 4],
        'registered at least 300 days ago'                   => [[['field' => 'registered_days', 'op' => 'gte', 'value' => 300]], 1],
        'has a (legacy linked) booking'                      => [[['field' => 'has_booking', 'op' => 'is', 'value' => true]], 2],
        'booking status confirmed'                           => [[['field' => 'booking_status', 'op' => 'in', 'value' => ['confirmed']]], 1],
        'has donated'                                        => [[['field' => 'has_donated', 'op' => 'is', 'value' => true]], 2],
        'donated at least 1000 in total'                     => [[['field' => 'donated_total', 'op' => 'gte', 'value' => 1000]], 1],
        'donated at most 300 in total (none counts as 0)'    => [[['field' => 'donated_total', 'op' => 'lte', 'value' => 300]], 4],
        'tag not in volunteer'                               => [[['field' => 'tag', 'op' => 'not_in', 'value' => [$tag . '-volunteer']]], 3],
        'all of: IN and has donated'                         => [[['field' => 'country', 'op' => 'in', 'value' => ['IN']], ['field' => 'has_donated', 'op' => 'is', 'value' => true]], 1],
    ];
    foreach ($expect as $label => [$rules, $n]) {
        eq(notifyAudienceCount($scoped($rules)), $n, "count: {$label}");
    }
    eq(notifyAudienceCount(['mode' => 'rules', 'match' => 'any', 'rules' => [
        ['field' => 'tag', 'op' => 'in', 'value' => [$tag . '-volunteer']],
        ['field' => 'family_size', 'op' => 'gte', 'value' => 6],
    ]], null) >= 3, true, 'match any combines rules with OR');

    section('Audience: the consent filter keeps estimates honest');
    $all = $scoped([]);
    eq(notifyAudienceCount($all, 'announcement'), 2, 'an informational campaign counts only consenting, not-unsubscribed registrations');
    eq(notifyAudienceCount($all, 'emergency'), 2, 'so does a critical one');
    eq(notifyAudienceCount($all, 'promotional'), 2, 'and a promotional one');
    eq(notifyAudienceCount($all, 'booking'), 5, 'a transactional campaign counts every active registration');
    eq(notifyAudienceCount($all, 'security'), 5, 'security is treated as transactional');
    eq(notifyAudienceCount($all), 5, 'no category (a saved segment) counts every active registration');
    eq(notifyAudienceBreakdown($all), ['all' => 5, 'consenting' => 2], 'the breakdown shows all and consenting together');
    eq(notifyAudienceCount(['mode' => 'selected', 'devotee_ids' => array_values($ids)], 'festival'), 2, 'selected families are limited to consent too');
    eq(notifyAudienceCount(['mode' => 'selected', 'devotee_ids' => array_values($ids)]), 5, 'selected families exclude the archived registration');
    $consenting = [$ids['a'], $ids['e']];
    sort($consenting);
    eq(notifyAudienceBatch($all, 0, 10, 'festival'), $consenting, 'campaign expansion batches contain only consenting registrations');
    $query = notifyAudienceQuery(['mode' => 'selected', 'devotee_ids' => array_values($ids)]);
    $stmt = $db->prepare($query['sql']);
    $stmt->execute($query['params']);
    $got = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    $active = array_values(array_diff($ids, [$ids['x']]));
    sort($active);
    eq($got, $active, 'notifyAudienceQuery runs as returned and orders by id');
    eq(notifyAudienceBatch(['mode' => 'selected', 'devotee_ids' => array_values($ids)], $active[1], 2), [$active[2], $active[3]], 'notifyAudienceBatch pages after a cursor');
    $fields = notifyAudienceFields();
    eq(array_keys($fields), array_keys(notifyAudienceFieldOps()), 'notifyAudienceFields lists every field');
    ok(!array_intersect(array_keys($fields), array_keys(NOTIFY_AUDIENCE_RETIRED_FIELDS)), 'no retired field is offered');
    ok(isset($fields['consent'], $fields['has_email'], $fields['has_phone'], $fields['family_size']), 'consent, has_email, has_phone and family_size are offered');
    eq(array_column($fields['lang']['options'], 'value'), ['ta', 'en'], 'language options are Tamil and English');
    ok(is_array($fields['booking_status']['options']) && is_array($fields['tag']['options']) && is_array($fields['booked_seva']['options'])
        && $fields['country']['options'] === null && $fields['consent']['options'] === null, 'options are filled exactly for the list-backed fields');
    ok(in_array($tag . '-volunteer', array_column($fields['tag']['options'], 'value'), true), 'tag options include tags in use');

    /* ── Catalogue and templates ────────────────────────────────────────── */
    section('Event catalogue and templates');
    $catalogue = notifyEventCatalogue();
    eq(count($catalogue), 17, 'the catalogue has 17 events (15 plus donation.paid and payment.refunded)');
    foreach (['account.registered', 'account.email_verification', 'account.email_verified', 'account.profile_updated', 'security.password_reset',
              'security.password_changed', 'phone.otp', 'phone.verified', 'account.already_registered'] as $gone) {
        ok(!isset($catalogue[$gone]), "{$gone} is not in the catalogue");
    }
    $reg = $catalogue['registration.received'] ?? [];
    eq([$reg['template'] ?? null, $reg['channels'] ?? null, $reg['fallbacks'] ?? null, $reg['dedupe'] ?? null, $reg['sync'] ?? null, $reg['entity_type'] ?? null],
        ['registration_received', ['email', 'whatsapp'], ['whatsapp' => 'sms'], 'devotee:{id}:registered', false, 'devotee'], 'registration.received is catalogued per SPEC §6');
    eq(notifyTemplateDefaults()['registration_received']['category'] ?? null, 'general', 'registration_received is in category general');
    eq(notifyTemplateDefaults()['registration_received']['cta_path'] ?? null, '/', 'registration_received links to /');
    eq($catalogue['booking.completed']['channels'], ['email', 'whatsapp'], 'booking.completed is email and WhatsApp');
    $retiredUse = array_filter($catalogue, static fn($e) => array_intersect($e['channels'], NOTIFY_RETIRED_CHANNELS) || array_intersect(array_keys($e['fallbacks']), NOTIFY_RETIRED_CHANNELS));
    ok(!$retiredUse, 'no event uses in-app or push', implode(',', array_keys($retiredUse)));
    $missingTemplates = array_filter($catalogue, static fn($e) => notifyTemplate($e['template'], 'en', 'any') === null);
    ok(!$missingTemplates, 'every catalogue event has a template', implode(',', array_keys($missingTemplates)));
    foreach (['welcome', 'email_verification', 'email_verified', 'password_reset', 'password_changed', 'profile_updated', 'phone_otp', 'phone_verified'] as $gone) {
        ok(!isset(notifyTemplateDefaults()[$gone]), "the {$gone} template is gone");
    }
    $accountMentions = [];
    foreach (notifyTemplateDefaults() as $key => $def) {
        if (str_contains((string) ($def['cta_path'] ?? ''), 'account')) $accountMentions[] = "{$key} cta_path";
        foreach ($def['langs'] as $lang => $variants) {
            foreach ($variants as $channel => $v) {
                $text = implode("\n", [(string) ($v['title'] ?? ''), (string) ($v['body'] ?? ''), (string) ($v['cta_label'] ?? '')]);
                if (stripos($text, 'account') !== false || str_contains($text, 'கணக்கு') || str_contains($text, '/account')) $accountMentions[] = "{$key} {$lang} {$channel}";
                if (in_array($channel, NOTIFY_RETIRED_CHANNELS, true)) $accountMentions[] = "{$key} has a retired {$channel} variant";
            }
        }
    }
    ok(!$accountMentions, 'no template cta_path, title, body or label mentions an account', implode('; ', $accountMentions));
    foreach (['ta', 'en'] as $lang) {
        foreach (['any', 'email', 'whatsapp', 'sms'] as $channel) {
            foreach ([1, 4] as $count) {
                $r = notifyRender('registration_received', $lang, $channel, ['devoteeName' => $lang === 'ta' ? 'கவிதா' : 'Kavitha', 'familyCount' => $count, 'ctaUrl' => 'https://temple.example.test/']);
                $text = $r['title'] . "\n" . $r['body'];
                $plural = $lang === 'en' && preg_match('/\b1 (people|members|persons)\b|\b4 (person|member)\b/', $text);
                ok($r['lang'] === $lang && $r['missing'] === [] && !str_contains($text, '{{') && !$plural
                    && ($channel === 'sms' || str_contains($r['body'], (string) $count)),
                    "registration_received reads correctly in {$lang}/{$channel} for a family of {$count}", $text);
            }
        }
    }
    $sms = notifyRender('registration_received', 'en', 'sms', notifyTemplateSample('registration_received', 'en'));
    ok(notifySmsInfo($sms['body'])['encoding'] === 'GSM-7' && notifySmsInfo($sms['body'])['segments'] === 1, 'the English registration SMS is one GSM-7 segment', json_encode(notifySmsInfo($sms['body'])));
    eq(notifyTemplateSample('registration_received', 'en')['ctaUrl'], 'https://temple.example.test/', 'the template preview links to the home page');

    /* ── Online payments (docs/payments/SPEC.md §6) ─────────────────────── */
    section('Payment events and templates (payments SPEC §6)');
    $payEvents = [
        'donation.paid'     => ['donation_paid', 'important', ['email', 'whatsapp', 'sms'], 'donation:{vars.paymentReference}:paid', 'donation'],
        'payment.succeeded' => ['payment_success', 'important', ['email', 'whatsapp', 'sms'], 'payment:{vars.paymentReference}:success', 'payment'],
        'payment.failed'    => ['payment_failed', 'important', ['email'], 'payment:{vars.paymentReference}:failed', 'payment'],
        'payment.refunded'  => ['payment_refund', 'important', ['email', 'whatsapp', 'sms'], 'refund:{entity_id}:processed', 'payment_refund'],
    ];
    foreach ($payEvents as $payEvent => $want) {
        $got = $catalogue[$payEvent] ?? [];
        eq([$got['template'] ?? null, $got['priority'] ?? null, $got['channels'] ?? null, $got['dedupe'] ?? null, $got['entity_type'] ?? null, $got['fallbacks'] ?? null, $got['sync'] ?? null],
            [...$want, [], false], "{$payEvent} is catalogued per payments SPEC §6.1 (template, priority, channels, dedupe, entity, no fallback, queued)");
    }
    eq(notifyEventDedupeKey($payEvents['donation.paid'][3], ['vars' => ['paymentReference' => 'DON-20260914-00001234']]), 'donation:DON-20260914-00001234:paid', 'donation.paid dedupes on the Donation ID');
    eq(notifyEventDedupeKey($payEvents['payment.succeeded'][3], ['vars' => ['paymentReference' => 'SEV-20260914-00000042']]), 'payment:SEV-20260914-00000042:success', 'payment.succeeded dedupes on the Booking ID');
    eq(notifyEventDedupeKey($payEvents['payment.refunded'][3], ['entity_id' => 7]), 'refund:7:processed', 'payment.refunded dedupes on the refund id');
    eq(notifyEvent('donation.paid', ['to_phone' => '919800000088', 'vars' => ['paymentAmount' => 'Rs. 1,001']])['skipped'], 'missing dedupe context', 'donation.paid without its Donation ID is not sent');

    // key => [category, the SPEC §6.2 variables in order, the variables every email and WhatsApp body must show]
    $payTemplates = [
        'donation_paid'   => ['donation', ['devoteeName', 'receiptNumber', 'paymentReference', 'paymentAmount', 'paymentFor', 'paymentDate', 'paymentMode', 'trustName', 'taxNote', 'ctaUrl'],
                              ['receiptNumber', 'paymentReference', 'paymentAmount']],
        'payment_success' => ['payment', ['devoteeName', 'receiptNumber', 'paymentReference', 'paymentAmount', 'paymentFor', 'bookingDate', 'paymentDate', 'paymentMode', 'ctaUrl'],
                              ['receiptNumber', 'paymentReference', 'paymentAmount', 'paymentFor', 'bookingDate']],
        'payment_failed'  => ['payment', ['devoteeName', 'paymentReference', 'paymentAmount', 'paymentFor', 'reason', 'ctaUrl'],
                              ['paymentReference', 'paymentAmount', 'reason']],
        'payment_refund'  => ['payment', ['devoteeName', 'refundAmount', 'paymentReference', 'receiptNumber', 'refundReference', 'paymentFor', 'ctaUrl'],
                              ['refundAmount', 'refundReference', 'paymentReference', 'receiptNumber']],
    ];
    $payDefaults = notifyTemplateDefaults();
    // What {{ctaUrl}} really is in a sent SMS: the tracked redirect, here for a seven-digit delivery id.
    $payLink = (string) notifyTrackedUrl(1234567, '/payment/receipt?ref=DON-20260914-00001234&t=abcdefghijklmnopqrstuv');
    foreach ($payTemplates as $key => [$category, $variables, $keyVars]) {
        $def = $payDefaults[$key] ?? null;
        if (!is_array($def)) {
            ok(false, "{$key} is a built-in template");
            continue;
        }
        eq([$def['category'] ?? null, $def['variables'] ?? null], [$category, $variables], "{$key}: category {$category} and exactly the SPEC §6.2 variables");
        ok(!str_contains((string) ($def['description'] ?? ''), 'No payment gateway'), "{$key}: the description no longer says there is no payment gateway");
        foreach (['ta', 'en'] as $lang) {
            $sample = notifyTemplateSample($key, $lang);
            $placeholders = array_keys(array_filter($sample, static fn($v) => is_string($v) && str_starts_with($v, '[')));
            ok(!$placeholders, "{$key} {$lang}: every variable has a realistic sample value", implode(',', $placeholders));
            $raw = '';
            foreach (['any', 'sms', 'whatsapp'] as $channel) {
                $v = $def['langs'][$lang][$channel] ?? [];
                $raw .= "\n" . ($v['title'] ?? '') . "\n" . ($v['body'] ?? '') . "\n" . ($v['cta_label'] ?? '');
                $r = notifyRender($key, $lang, $channel, $sample);
                ok($r['lang'] === $lang && $r['channel'] === $channel && $r['missing'] === [] && trim($r['body']) !== '' && !str_contains($r['title'] . $r['body'] . $r['cta_label'], '{{'),
                    "{$key} {$lang}/{$channel}: its own wording renders completely with sample values", json_encode(['lang' => $r['lang'], 'channel' => $r['channel'], 'missing' => $r['missing']]));
                if ($channel === 'any') {
                    ok($r['title'] !== '' && mb_strlen($r['title']) <= 60 && $r['cta_label'] !== '', "{$key} {$lang}: the title fits 60 characters and the button has a label", mb_strlen($r['title']) . ': ' . $r['title']);
                }
                if ($channel !== 'sms') {
                    $absent = array_values(array_filter($keyVars, static fn($name) => !str_contains($r['body'], (string) $sample[$name])));
                    ok(!$absent, "{$key} {$lang}/{$channel}: the body shows " . implode(', ', $keyVars), implode(',', $absent));
                    continue;
                }
                $links = ['the sample link' => (string) $sample['ctaUrl']];
                if (str_contains((string) ($v['body'] ?? ''), '{{ctaUrl}}')) $links['a real tracked link'] = $payLink;
                foreach ($links as $what => $link) {
                    $smsBody = notifyRender($key, $lang, 'sms', ['ctaUrl' => $link] + $sample)['body'];
                    $info = notifySmsInfo($smsBody);
                    if ($lang === 'en') {
                        ok($info['encoding'] === 'GSM-7' && $info['chars'] <= 160, "{$key} en SMS is one GSM-7 segment with {$what}", "{$info['encoding']} {$info['chars']}: {$smsBody}");
                    } else {
                        ok($info['segments'] <= 2, "{$key} ta SMS fits two UCS-2 segments with {$what}", "{$info['segments']} segments, {$info['chars']} units: {$smsBody}");
                    }
                }
            }
            $unused = array_values(array_filter($variables, static fn($name) => $name !== 'ctaUrl' && !str_contains($raw, '{{' . $name . '}}')));
            ok(!$unused, "{$key} {$lang}: every declared variable is used in its wording", implode(',', $unused));
            ok(stripos($raw, 'account') === false && !str_contains($raw, 'கணக்கு'), "{$key} {$lang}: no \"account\" or \"கணக்கு\" wording");
        }
    }
    eq($payDefaults['donation_paid']['langs']['en']['sms']['body'] ?? null, 'Thank you for your contribution of {{paymentAmount}}. Your Donation ID is {{paymentReference}}. Receipt: {{ctaUrl}}',
        'the English donation SMS is the wording in payments SPEC §6.2');
    eq([$payDefaults['donation_paid']['langs']['en']['any']['title'] ?? null, $payDefaults['donation_paid']['langs']['en']['any']['cta_label'] ?? null], ['Thank you for your donation', 'View receipt'],
        'the English donation title and button follow payments SPEC §6.2');
    ok(str_contains((string) ($payDefaults['payment_success']['langs']['en']['any']['body'] ?? ''), 'temple office will call you'), 'payment_success says the temple office will call to confirm the date');
    $failedBody = (string) ($payDefaults['payment_failed']['langs']['en']['any']['body'] ?? '');
    ok(str_contains($failedBody, 'No money was taken') && str_contains($failedBody, 'bank shows a debit'), 'payment_failed reassures: no money was taken, and a debit the bank shows comes back');
    $refundBody = (string) ($payDefaults['payment_refund']['langs']['en']['any']['body'] ?? '');
    ok(str_contains($refundBody, 'CCAvenue') && str_contains($refundBody, '5 to 7 working days'), 'payment_refund says the refund went to CCAvenue and usually arrives in 5 to 7 working days');
    $paySample = notifyTemplateSample('payment_refund', 'en') + notifyTemplateSample('donation_paid', 'en');
    eq([$paySample['receiptNumber'], $paySample['paymentReference'], $paySample['paymentMode'], $paySample['refundReference']], ['TMR-2026-000042', 'DON-20260914-00001234', 'UPI', 'RF12T1789300000'],
        'payment previews use the SPEC §6.2 sample values');
    eq(notifyTemplateSample('donation_paid', 'en')['ctaUrl'], 'https://temple.example.test/payment/receipt', 'a payment template preview links to the receipt page');

    // A guest donor gets the messages: payment and donation are transactional, so no consent is needed.
    $payGuest = ['to_phone' => '919800000088', 'to_email' => $prefix . 'donor@example.test', 'name' => $names . 'donor', 'lang' => 'en'];
    $receiptPath = '/payment/receipt?ref=DON-20260914-00001234&t=abcdefghijklmnopqrstuv';
    $paid = notifyEvent('donation.paid', $payGuest + ['entity_id' => 1, 'dedupe_key' => $dedupe . 'donation-paid', 'cta_url' => $receiptPath,
        'vars' => ['receiptNumber' => 'TMR-2026-000042', 'paymentReference' => 'DON-20260914-00001234', 'paymentAmount' => 'Rs. 1,001',
                   'paymentFor' => 'Annadanam', 'paymentDate' => '14 Sep 2026', 'paymentMode' => 'UPI']]);
    eq(array_map(static fn($d) => $d['status'], $paid['deliveries'] ?? []), ['email' => 'queued', 'whatsapp' => 'queued', 'sms' => 'queued'], 'donation.paid to a guest donor queues email, WhatsApp and SMS');
    $payRow = $db->prepare('SELECT category, priority, template_key, entity_type, cta_url FROM notifications WHERE id = :id');
    $payRow->execute([':id' => (int) ($paid['id'] ?? 0)]);
    eq($payRow->fetch(PDO::FETCH_ASSOC), ['category' => 'donation', 'priority' => 'important', 'template_key' => 'donation_paid', 'entity_type' => 'donation', 'cta_url' => $receiptPath],
        'the stored donation.paid is an important donation message linking to the receipt');
    $paidSmsId = (int) ($paid['deliveries']['sms']['id'] ?? 0);
    $paidSms = $paidSmsId > 0 ? notifyDispatchDelivery($paidSmsId) : ['status' => null];
    $paidSmsBody = (string) (testLog([$paidSmsId])[$paidSmsId]['body'] ?? '');
    eq([$paidSms['status'], $paidSmsBody], ['sent', 'Thank you for your contribution of Rs. 1,001. Your Donation ID is DON-20260914-00001234. Receipt: ' . notifyTrackedUrl($paidSmsId, $receiptPath)],
        'the donation SMS as sent carries the tracked receipt link once, in its own sentence');
    $paidInfo = notifySmsInfo($paidSmsBody);
    ok($paidInfo['encoding'] === 'GSM-7' && $paidInfo['segments'] === 1, 'the donation SMS as sent is one GSM-7 segment', json_encode($paidInfo));
    $failedPay = notifyEvent('payment.failed', $payGuest + ['entity_id' => 1, 'dedupe_key' => $dedupe . 'payment-failed',
        'vars' => ['paymentReference' => 'DON-20260914-00001234-R2', 'paymentAmount' => 'Rs. 1,001', 'paymentFor' => 'Annadanam', 'reason' => 'The bank declined the payment']]);
    eq(array_map(static fn($d) => $d['status'], $failedPay['deliveries'] ?? []), ['email' => 'queued'], 'payment.failed goes by email only');
    $refundedPay = notifyEvent('payment.refunded', $payGuest + ['entity_id' => 7, 'dedupe_key' => $dedupe . 'payment-refunded',
        'vars' => ['refundAmount' => 'Rs. 1,001', 'paymentReference' => 'DON-20260914-00001234', 'receiptNumber' => 'TMR-2026-000042', 'refundReference' => 'RF12T1789300000', 'paymentFor' => 'Annadanam']]);
    $payRow->execute([':id' => (int) ($refundedPay['id'] ?? 0)]);
    $refundRow = $payRow->fetch(PDO::FETCH_ASSOC) ?: [];
    eq([$refundRow['category'] ?? null, $refundRow['template_key'] ?? null, $refundRow['entity_type'] ?? null, array_keys($refundedPay['deliveries'] ?? [])],
        ['payment', 'payment_refund', 'payment_refund', ['email', 'whatsapp', 'sms']], 'payment.refunded is stored as a payment message about the refund, on email, WhatsApp and SMS');

    section('Events, approval rules, formatting');
    eq(notifyEventDedupeKey('booking:{entity_id}:confirmed', ['entity_id' => 91]), 'booking:91:confirmed', 'dedupe pattern with entity_id');
    eq(notifyEventDedupeKey('booking:{entity_id}:confirmed', []), null, 'a dedupe pattern with a missing value is null (not sent)');
    eq(notifyEventDedupeKey('devotee:{id}:registered', ['devotee_id' => 12]), 'devotee:12:registered', 'the registration dedupe key');
    eq(notifyEventDedupeKey('event:{entity_id}:registered:{recipient}', ['entity_id' => 4, 'devotee_id' => 12]), 'event:4:registered:d12', '{recipient} for a registration');
    eq(notifyEventDedupeKey('event:{entity_id}:registered:{recipient}', ['entity_id' => 4, 'to_phone' => '+91 98000 01234']), 'event:4:registered:p' . substr(sha1('919800001234'), 0, 12), '{recipient} for a guest phone');
    eq(notifyEventDedupeKey('donation:{entity_id}:receipt:{ctx.sequence}', ['entity_id' => 8, 'sequence' => 2]), 'donation:8:receipt:2', '{ctx.sequence}');
    eq(notifyEvent('no.such.event', [])['skipped'], 'unknown event', 'an unknown event is skipped, never thrown');
    eq(notifyEvent('booking.confirmed', ['devotee_id' => $ids['a']])['skipped'], 'missing dedupe context', 'an event without its dedupe context is not sent');
    eq(notify(['devotee_id' => $ids['a']])['skipped'], 'nothing to send', 'notify() with neither template nor text is skipped');
    eq(notify(['template' => 'no_such_template', 'devotee_id' => $ids['a']])['skipped'], 'unknown template', 'notify() with an unknown template is skipped');
    eq(notify(['title' => 'x', 'body' => 'y'])['skipped'], 'no recipient', 'a guest with no address is skipped');
    eq(notify(['title' => 'x', 'body' => 'y', 'devotee_id' => $ids['a'], 'channels' => ['inapp', 'push']])['skipped'], 'no channels', 'a message on retired channels only is not created');
    $c = ['priority' => 'normal', 'channels' => 'email', 'category' => 'announcement'];
    eq(notifyCampaignNeedsApproval($c, 50), null, 'approval: 50 families by email needs none');
    eq(notifyCampaignNeedsApproval($c, 51), 'Reaches 51 families', 'approval: over the threshold');
    eq(notifyCampaignNeedsApproval(['priority' => 'urgent'] + $c, 2), 'Urgent/emergency priority', 'approval: urgent');
    eq(notifyCampaignNeedsApproval(['channels' => 'email,sms'] + $c, 11), 'Paid channels to 11 families', 'approval: paid channels over ten');
    eq(notifyCampaignNeedsApproval(['channelsList' => ['whatsapp']] + $c, 10), null, 'approval: paid channels to ten need none');
    eq(notifyCampaignNeedsApproval(['category' => 'promotional'] + $c, 1), 'Promotional message', 'approval: promotional');
    putenv('NOTIFY_APPROVAL_THRESHOLD=5');
    eq(notifyCampaignNeedsApproval($c, 6), 'Reaches 6 families', 'NOTIFY_APPROVAL_THRESHOLD changes the threshold');
    putenv('NOTIFY_APPROVAL_THRESHOLD');
    eq([notifyFormatClock('07:00 AM', 'en'), notifyFormatClock('07:00 AM', 'ta'), notifyFormatClock('6:30 pm', 'ta'), notifyFormatClock('12:15 AM', 'en'), notifyFormatClock('Evening', 'en')],
        ['7:00 am', 'காலை 7:00', 'மாலை 6:30', '12:15 am', 'Evening'], 'pooja times are formatted per language');
    eq([notifyFormatDate('2026-09-20', 'en'), notifyFormatDate('2026-09-20', 'ta')], ['20 Sep 2026', '20 செப்டம்பர் 2026'], 'dates are formatted per language');
    require_once __DIR__ . '/../backend/includes/devotee_notify.php';
    eq(notifyBookingNumber(91), 'B-000091', 'a reminder quotes the booking number as B-000091');
    eq(notifyBookingNumber(1234567), devoteeBookingNumber(1234567), 'reminders and booking confirmations quote the same booking number');
    eq(notifyParseLocal('2026-10-02T18:00'), '2026-10-02 18:00:00', 'a datetime-local value is parsed');
    eq(notifyParseLocal('2026-02-30 18:00'), null, 'an impossible schedule time is refused');
    eq(notifyPickLang(['en' => 'Hello', 'ta' => 'வணக்கம்'], 'hi'), 'வணக்கம்', 'a language map falls back to Tamil before English');
    eq(notifyPickLang(['fr' => 'Bonjour'], 'hi'), 'Bonjour', '…and to any language after that');
    $langs = notifyLanguages();
    ok(isset($langs['ta'], $langs['en']) && $langs['ta'] === 'தமிழ்', 'languages include Tamil and English with native labels');
    ok(strlen(notifySecret()) >= 32, 'a secret of at least 32 characters exists');

    /* ── End to end with the test drivers ───────────────────────────────── */
    section('Sending: consent, unsubscribe, the stop-updates line');

    $f = $make('f', ['phone' => '919800000066', 'lang' => 'en', 'updates_consent_at' => $now]);
    $g = $make('g', ['phone' => '919800000077', 'lang' => 'ta', 'updates_consent_at' => $now]);

    // registration.received: once, for a consenting registration, on email and WhatsApp.
    $first = notifyEvent('registration.received', ['devotee_id' => $f, 'entity_id' => $f, 'vars' => ['familyCount' => 1]]);
    eq([$first['deduped'], $first['deliveries']['email']['status'] ?? null, $first['deliveries']['whatsapp']['status'] ?? null, isset($first['deliveries']['sms'])],
        [false, 'queued', 'queued', false], 'registration.received queues email and WhatsApp for a consenting registration');
    $again = notifyEvent('registration.received', ['devotee_id' => $f, 'entity_id' => $f, 'vars' => ['familyCount' => 1]]);
    ok($again['deduped'] === true && $again['id'] === $first['id'], 'registration.received is sent once per registration');
    $row = $db->prepare('SELECT lang, category, template_key, cta_url, entity_type, entity_id, dedupe_key FROM notifications WHERE id = :id');
    $row->execute([':id' => $first['id']]);
    eq($row->fetch(PDO::FETCH_ASSOC), ['lang' => 'en', 'category' => 'general', 'template_key' => 'registration_received', 'cta_url' => '/',
        'entity_type' => 'devotee', 'entity_id' => $f, 'dedupe_key' => 'devotee:' . $f . ':registered'], 'the stored notification is in the family\'s language, category general, linking to /');
    $noConsentReg = notifyEvent('registration.received', ['devotee_id' => $ids['d'], 'entity_id' => $ids['d'], 'vars' => ['familyCount' => 1]]);
    eq([$noConsentReg['deliveries']['email']['reason'] ?? null, $noConsentReg['deliveries']['whatsapp']['reason'] ?? null], ['no consent', 'no consent'],
        'a registration without consent is never sent registration.received, even if a caller asked');

    // A guest and a family without consent get no informational message.
    $guestUpdate = notify(['title' => 'Festival', 'body' => 'Come', 'category' => 'festival', 'priority' => 'important', 'channels' => ['email', 'whatsapp', 'sms'],
        'to_email' => $prefix . 'guest@example.test', 'to_phone' => '919800000088', 'dedupe_key' => $dedupe . 'guest-update']);
    eq(array_map(static fn($d) => $d['reason'], $guestUpdate['deliveries']), ['email' => 'no consent', 'whatsapp' => 'no consent', 'sms' => 'no consent'], 'a guest gets no informational message on any channel');
    $familyNoConsent = notify(['title' => 'Festival', 'body' => 'Come', 'category' => 'festival', 'priority' => 'important', 'channels' => ['email', 'whatsapp', 'sms'], 'devotee_id' => $ids['d']]);
    eq(array_map(static fn($d) => $d['reason'], $familyNoConsent['deliveries']), ['email' => 'no consent', 'whatsapp' => 'no consent', 'sms' => 'no consent'], 'a registration without consent gets no informational message on any channel');
    $guestBooking = notifyEvent('booking.confirmed', ['to_phone' => '919800000088', 'to_email' => $prefix . 'guest@example.test', 'lang' => 'en', 'entity_id' => 1,
        'dedupe_key' => $dedupe . 'guest-booking', 'vars' => ['bookingNumber' => 'B-000001', 'sevaName' => 'Abhishekam', 'bookingDate' => '20 Sep 2026']]);
    eq([$guestBooking['deliveries']['email']['status'] ?? null, $guestBooking['deliveries']['whatsapp']['status'] ?? null], ['queued', 'queued'], 'a guest booking confirmation is queued');

    // An archived registration receives no update, but its own booking message still goes.
    eq(notify(['title' => 'x', 'body' => 'y', 'category' => 'festival', 'devotee_id' => $ids['x']])['skipped'], 'registration archived', 'an archived registration receives no update');
    $archivedBooking = notify(['title' => 'Booking', 'body' => 'Confirmed', 'category' => 'booking', 'channels' => ['email'], 'devotee_id' => $ids['x']]);
    eq($archivedBooking['deliveries']['email']['status'] ?? null, 'queued', 'an archived registration still receives its own booking message');

    // Unsubscribe stops informational messages on all three channels, not a booking confirmation.
    $before = notify(['title' => 'Pooja', 'body' => 'Tomorrow', 'category' => 'pooja', 'priority' => 'important', 'channels' => ['email', 'whatsapp', 'sms'], 'devotee_id' => $f]);
    eq(array_map(static fn($d) => $d['status'], $before['deliveries']), ['email' => 'queued', 'whatsapp' => 'queued', 'sms' => 'queued'], 'an important update to a consenting family queues all three channels');
    ok(notifyUnsubscribe($f), 'the family unsubscribes');
    $after = notify(['title' => 'Pooja', 'body' => 'Tomorrow', 'category' => 'pooja', 'priority' => 'important', 'channels' => ['email', 'whatsapp', 'sms'], 'devotee_id' => $f]);
    eq(array_map(static fn($d) => $d['reason'], $after['deliveries']), ['email' => 'unsubscribed', 'whatsapp' => 'unsubscribed', 'sms' => 'unsubscribed'], 'after unsubscribing, an update is skipped on email, WhatsApp and SMS');
    $bookingAfter = notifyEvent('booking.confirmed', ['devotee_id' => $f, 'entity_id' => 1, 'dedupe_key' => $dedupe . 'unsub-booking',
        'vars' => ['bookingNumber' => 'B-000001', 'sevaName' => 'Abhishekam', 'bookingDate' => '20 Sep 2026']]);
    eq([$bookingAfter['deliveries']['email']['status'] ?? null, $bookingAfter['deliveries']['whatsapp']['status'] ?? null], ['queued', 'queued'], 'a booking confirmation still goes after unsubscribing');

    // …and it wins over messages already queued before the unsubscribe.
    foreach ($before['deliveries'] as $channel => $delivery) {
        $out = notifyDispatchDelivery($delivery['id']);
        eq([$out['status'], $out['reason']], ['skipped', 'unsubscribed'], "an update queued before the unsubscribe is skipped at dispatch ({$channel})");
    }
    $event = $db->prepare("SELECT detail FROM notification_delivery_events WHERE delivery_id = :d AND event = 'skipped' ORDER BY id DESC LIMIT 1");
    $event->execute([':d' => $before['deliveries']['email']['id']]);
    eq($event->fetchColumn(), 'unsubscribed (consent changed after it was queued)', 'the delivery history says consent changed after queueing');
    $out = notifyDispatchDelivery($bookingAfter['deliveries']['email']['id']);
    eq($out['status'], 'sent', 'the booking confirmation is sent after the unsubscribe');

    // Archiving after queueing stops an update at dispatch.
    $queuedForG = notify(['title' => 'Event', 'body' => 'Soon', 'category' => 'event', 'channels' => ['email'], 'devotee_id' => $g]);
    $db->prepare('UPDATE devotees SET is_active = 0 WHERE id = :id')->execute([':id' => $g]);
    eq(notifyDispatchDelivery($queuedForG['deliveries']['email']['id'])['reason'], 'registration archived', 'an update to a registration archived after queueing is skipped at dispatch');
    $db->prepare('UPDATE devotees SET is_active = 1 WHERE id = :id')->execute([':id' => $g]);

    // Every update carries the unsubscribe URL on every channel; a booking message does not.
    $update  = notify(['title' => 'திருவிழா', 'body' => 'நாளை திருவிழா.', 'category' => 'festival', 'priority' => 'important', 'channels' => ['email', 'whatsapp', 'sms'], 'devotee_id' => $g, 'cta_url' => '/events']);
    $booking = notifyEvent('booking.confirmed', ['devotee_id' => $g, 'entity_id' => 1, 'dedupe_key' => $dedupe . 'g-booking', 'channels' => ['email', 'whatsapp', 'sms'],
        'vars' => ['bookingNumber' => 'B-000001', 'sevaName' => 'அபிஷேகம்', 'bookingDate' => '20 செப்டம்பர் 2026']]);
    foreach ([$update, $booking] as $n) foreach ($n['deliveries'] as $delivery) notifyDispatchDelivery($delivery['id']);
    $log = testLog(array_merge(array_column($update['deliveries'], 'id'), array_column($booking['deliveries'], 'id')));
    $unsubUrl = notifyUnsubscribeUrl($g);
    $u = static fn(string $channel) => $log[$update['deliveries'][$channel]['id']] ?? [];
    $b = static fn(string $channel) => $log[$booking['deliveries'][$channel]['id']] ?? [];
    ok(($u('email')['headers']['List-Unsubscribe'] ?? null) === '<' . $unsubUrl . '>' && ($u('email')['headers']['List-Unsubscribe-Post'] ?? null) === 'List-Unsubscribe=One-Click',
        'an update email carries List-Unsubscribe and one-click headers', json_encode($u('email')['headers'] ?? null));
    ok(str_contains((string) ($u('email')['body'] ?? ''), 'கோயில் அறிவிப்புகளை நிறுத்த: ' . $unsubUrl), 'an update email body carries the unsubscribe link', (string) ($u('email')['body'] ?? ''));
    ok(str_ends_with((string) ($u('whatsapp')['body'] ?? ''), "\n\nகோயில் அறிவிப்புகளை நிறுத்த: " . $unsubUrl), 'an update WhatsApp message ends with the stop-updates line', (string) ($u('whatsapp')['body'] ?? ''));
    ok(str_ends_with((string) ($u('sms')['body'] ?? ''), "\nகோயில் அறிவிப்புகளை நிறுத்த: " . $unsubUrl), 'an update SMS ends with the stop-updates line', (string) ($u('sms')['body'] ?? ''));
    ok(($b('email')['headers'] ?? []) === [] && !str_contains((string) ($b('email')['body'] ?? ''), '/api/n/u/'), 'a booking email carries no unsubscribe link', json_encode($b('email')));
    ok(!str_contains((string) ($b('whatsapp')['body'] ?? '') . (string) ($b('sms')['body'] ?? ''), '/api/n/u/'), 'booking WhatsApp and SMS carry no stop-updates line');
    ok(!preg_match('/account|notification settings/i', (string) ($u('email')['body'] ?? '') . (string) ($b('email')['body'] ?? '')), 'no email mentions an account or notification settings');
    eq(notifyStopUpdatesLine('en', 'https://x.test/u'), 'To stop temple updates: https://x.test/u', 'the English stop-updates line');

    // Previews show the same lines, with a link that unsubscribes nobody.
    $preview = ['translations' => ['en' => ['title' => 'Festival', 'body' => 'Come tomorrow.']], 'category' => 'festival', 'priority' => 'normal', 'cta_url' => '/events'];
    $p = notifyCampaignPreview($preview, 'sms', 'en');
    ok(str_ends_with($p['body'], 'To stop temple updates: ' . notifyPreviewUnsubscribeUrl()) && $p['sms']['chars'] === notifySmsInfo($p['body'])['chars'], 'an SMS preview of an update counts the stop-updates line', $p['body']);
    ok(str_contains((string) notifyCampaignPreview($preview, 'email', 'en')['html'], 'Stop temple updates'), 'an email preview of an update shows the unsubscribe link');
    ok(str_contains(notifyCampaignPreview($preview, 'whatsapp', 'en')['body'], 'To stop temple updates:'), 'a WhatsApp preview of an update shows the stop-updates line');
    ok(!str_contains(notifyCampaignPreview(['category' => 'booking'] + $preview, 'sms', 'en')['body'], 'stop temple updates'), 'a preview of a booking message has no stop-updates line');
    ok(notifyCampaignPreview($preview, 'push', 'en')['html'] !== null, 'a preview asked for a retired channel shows email');

    // The email footer explains why the message arrived without mentioning an account.
    $copyText = json_encode([notifyEmailCopy('ta'), notifyEmailCopy('en')], JSON_UNESCAPED_UNICODE);
    ok(stripos($copyText, 'account') === false && !str_contains($copyText, 'கணக்கு') && stripos($copyText, 'settings') === false, 'the email footer copy mentions no account or settings');
    $why = notifyEmailText(['title' => 't', 'body' => 'b', 'lang' => 'en', 'kind' => 'informational']);
    ok(str_contains($why, 'agreed to receive temple updates'), 'an update email says the family agreed to updates');
    ok(str_contains(notifyEmailText(['title' => 't', 'body' => 'b', 'lang' => 'en', 'category' => 'booking']), 'booked a seva, made an offering'), 'a booking email says why it was sent');
} finally {
    // Remove everything this run created, whatever failed above.
    $like = addcslashes($prefix, '%_\\') . '%';
    $db->prepare('DELETE FROM seva_bookings WHERE devotee_name = :n')->execute([':n' => 'E2E-NOTIFY-UNIT-' . $run]);
    $db->prepare('DELETE FROM donations WHERE name = :n')->execute([':n' => 'E2E-NOTIFY-UNIT-' . $run]);
    $db->prepare('DELETE FROM notifications WHERE dedupe_key LIKE :k')->execute([':k' => addcslashes($dedupe, '%_\\') . '%']);
    $db->prepare('DELETE FROM devotees WHERE email LIKE :p OR name LIKE :n')->execute([':p' => $like, ':n' => addcslashes($names, '%_\\') . '%']);
}

$left = $db->prepare('SELECT COUNT(*) FROM devotees WHERE email LIKE :p OR name LIKE :n');
$left->execute([':p' => addcslashes($prefix, '%_\\') . '%', ':n' => addcslashes($names, '%_\\') . '%']);
ok((int) $left->fetchColumn() === 0, 'cleanup removed every fixture registration');

echo "\n" . $passed . ' passed, ' . count($failures) . " failed\n";
if ($failures) {
    echo "Failures:\n  - " . implode("\n  - ", $failures) . "\n";
    exit(1);
}
exit(0);
