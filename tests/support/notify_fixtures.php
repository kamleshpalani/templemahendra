<?php
/**
 * tests/support/notify_fixtures.php — shared setup for the registration and
 * notification test suites. CLI only; refuses to run from a web server.
 *
 *   php tests/support/notify_fixtures.php create-devotee '{"name":"E2E-X Kumar","phone":"919800001234","consent":true, …}'
 *   php tests/support/notify_fixtures.php notify '{"devotee_id":12,"title":"…","body":"…","category":"general"}'
 *   php tests/support/notify_fixtures.php event '{"event":"booking.confirmed","ctx":{…}}'
 *   php tests/support/notify_fixtures.php cleanup '{"name_prefix":"E2E-NOTIFY-"}'   (or "email_prefix")
 *   php tests/support/notify_fixtures.php sql '{"query":"SELECT …","params":[…]}'
 *
 * create-devotee writes a family registration as the registration form would
 * (migration 009): name, phone, optional email, address, lang, and optionally
 * consent ("consent": true), a withdrawn consent ("unsubscribed": true), an
 * archived registration ("active": false) and family members
 * ("members": [{"name":"…","relationship":"son","age":12}]). Anything left out
 * gets a plausible default.
 *
 * Every command prints one JSON object on stdout and exits 0 on success, 1 on
 * failure with {"error": "..."}.
 *
 * Why registrations are created here and not through /api/registrations: the
 * form is rate-limited per connection, and several suites running at once from
 * one machine would exhaust it and fail for reasons that have nothing to do
 * with what they test. The registration suites still post to the real endpoint.
 *
 * The database environment comes from the caller (see PHP_BIN in the suites).
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../../backend/includes/db.php';
require_once __DIR__ . '/../../backend/includes/helpers.php';

function out(array $data, int $code = 0): never
{
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
    exit($code);
}

/** A cleanup prefix long and plain enough that it can only match test rows. */
function safePrefix(string $prefix): bool
{
    return strlen($prefix) >= 6 && preg_match('/^[A-Za-z0-9._ -]+$/', $prefix) === 1;
}

$cmd  = $argv[1] ?? '';
$args = json_decode($argv[2] ?? '{}', true);
if (!is_array($args)) out(['error' => 'second argument must be a JSON object'], 1);

try {
    $db = getDB();
    switch ($cmd) {
        case 'create-devotee': {
            $email = mb_strtolower(trim((string) ($args['email'] ?? '')));
            if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) out(['error' => 'email is not a valid address'], 1);
            $phone = isset($args['phone']) ? preg_replace('/\D+/', '', (string) $args['phone']) : null;
            $cols  = [
                'name'          => (string) ($args['name'] ?? 'E2E Devotee'),
                'email'         => $email !== '' ? $email : null,
                'phone'         => $phone !== '' ? $phone : null,
                'phone_country' => $args['phoneCountry'] ?? ($phone ? 'IN' : null),
                'address1'      => (string) ($args['address1'] ?? '12 Middle Street'),
                'address2'      => $args['address2'] ?? null,
                'city'          => (string) ($args['city'] ?? 'Pudupatti'),
                'state'         => $args['state'] ?? 'TN',
                'country'       => $args['country'] ?? 'IN',
                'postcode'      => $args['postcode'] ?? null,
                'lang'          => ($args['lang'] ?? 'ta') === 'en' ? 'en' : 'ta',
                'is_active'     => array_key_exists('active', $args) && !$args['active'] ? 0 : 1,
            ];
            if ($email !== '') {
                $db->prepare('DELETE FROM devotees WHERE email = :e')->execute([':e' => $email]);
            }
            $names = array_keys($cols);
            $db->prepare('INSERT INTO devotees (' . implode(',', $names) . ') VALUES (:' . implode(',:', $names) . ')')
               ->execute(array_combine(array_map(fn($n) => ':' . $n, $names), array_values($cols)));
            $id = (int) $db->lastInsertId();
            if (!empty($args['consent'])) {
                $db->prepare('UPDATE devotees SET updates_consent_at = UTC_TIMESTAMP() WHERE id = :id')->execute([':id' => $id]);
            }
            if (!empty($args['unsubscribed'])) {
                $db->prepare('UPDATE devotees SET unsubscribed_at = UTC_TIMESTAMP() WHERE id = :id')->execute([':id' => $id]);
            }
            $insert = $db->prepare(
                'INSERT INTO devotee_family_members (devotee_id, name, relationship, age, sort_order)
                 VALUES (:d, :n, :r, :a, :o)'
            );
            foreach (array_values((array) ($args['members'] ?? [])) as $i => $m) {
                $insert->execute([
                    ':d' => $id,
                    ':n' => (string) ($m['name'] ?? 'Member ' . ($i + 1)),
                    ':r' => (string) ($m['relationship'] ?? 'other_relative'),
                    ':a' => isset($m['age']) ? (int) $m['age'] : null,
                    ':o' => $i,
                ]);
            }
            out(['id' => $id, 'email' => $cols['email']]);
        }

        case 'notify': {
            require_once __DIR__ . '/../../backend/includes/notify.php';
            if (!function_exists('notify')) out(['error' => 'notify() is not implemented yet'], 1);
            out(['result' => notify($args)]);
        }

        case 'event': {
            require_once __DIR__ . '/../../backend/includes/notify.php';
            if (!function_exists('notifyEvent')) out(['error' => 'notifyEvent() is not implemented yet'], 1);
            out(['result' => notifyEvent((string) ($args['event'] ?? ''), (array) ($args['ctx'] ?? []))]);
        }

        case 'cleanup': {
            $emailPrefix = (string) ($args['email_prefix'] ?? '');
            $namePrefix  = (string) ($args['name_prefix'] ?? '');
            if ($emailPrefix === '' && $namePrefix === '') {
                out(['error' => 'give email_prefix or name_prefix'], 1);
            }
            foreach ([$emailPrefix, $namePrefix] as $p) {
                if ($p !== '' && !safePrefix($p)) out(['error' => 'a prefix must be at least six plain characters'], 1);
            }
            // Family members, notifications, deliveries, tags and the legacy
            // tables all cascade from devotees.
            $deleted = 0;
            if ($emailPrefix !== '') {
                $stmt = $db->prepare('DELETE FROM devotees WHERE email LIKE :p');
                $stmt->execute([':p' => addcslashes($emailPrefix, '%_\\') . '%']);
                $deleted += $stmt->rowCount();
            }
            if ($namePrefix !== '') {
                $stmt = $db->prepare('DELETE FROM devotees WHERE name LIKE :p');
                $stmt->execute([':p' => addcslashes($namePrefix, '%_\\') . '%']);
                $deleted += $stmt->rowCount();
            }
            out(['deleted_devotees' => $deleted]);
        }

        case 'sql': {
            $query = (string) ($args['query'] ?? '');
            $stmt  = $db->prepare($query);
            $stmt->execute((array) ($args['params'] ?? []));
            $rows = $stmt->columnCount() > 0 ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
            out(['rows' => $rows, 'affected' => $stmt->rowCount()]);
        }
    }
    out(['error' => 'unknown command; use create-devotee, notify, event, cleanup or sql'], 1);
} catch (Throwable $e) {
    out(['error' => get_class($e) . ': ' . $e->getMessage()], 1);
}
