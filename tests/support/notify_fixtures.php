<?php
/**
 * tests/support/notify_fixtures.php — shared setup for the notification test
 * suites. CLI only; refuses to run from a web server.
 *
 *   php tests/support/notify_fixtures.php create-devotee '{"email":"x@example.test","password":"Kolam99Deep", …}'
 *   php tests/support/notify_fixtures.php notify '{"devotee_id":12,"title":"…","body":"…","category":"general"}'
 *   php tests/support/notify_fixtures.php cleanup '{"email_prefix":"e2e-notify-"}'
 *   php tests/support/notify_fixtures.php sql '{"query":"SELECT …","params":[…]}'
 *
 * Every command prints one JSON object on stdout and exits 0 on success, 1 on
 * failure with {"error": "..."}.
 *
 * Why devotees are created here and not through /api/auth/register: sign-up is
 * rate-limited per connection, and several suites running at once from one
 * machine would exhaust it and fail for reasons that have nothing to do with
 * what they test. Signing IN still goes through the real endpoint.
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

$cmd  = $argv[1] ?? '';
$args = json_decode($argv[2] ?? '{}', true);
if (!is_array($args)) out(['error' => 'second argument must be a JSON object'], 1);

try {
    $db = getDB();
    switch ($cmd) {
        case 'create-devotee': {
            $email = mb_strtolower(trim((string) ($args['email'] ?? '')));
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) out(['error' => 'email required'], 1);
            $cols = [
                'name'          => (string) ($args['name'] ?? 'E2E Devotee'),
                'email'         => $email,
                'phone'         => isset($args['phone']) ? preg_replace('/\D+/', '', (string) $args['phone']) : null,
                'phone_country' => $args['phoneCountry'] ?? ($args['phone'] ?? null ? 'IN' : null),
                'country'       => $args['country'] ?? 'IN',
                'state'         => $args['state'] ?? 'TN',
                'city'          => $args['city'] ?? 'Pudupatti',
                'pass_hash'     => password_hash((string) ($args['password'] ?? 'Kolam99Deep'), PASSWORD_BCRYPT),
            ];
            $db->prepare('DELETE FROM devotees WHERE email = :e')->execute([':e' => $email]);
            $names = array_keys($cols);
            $db->prepare('INSERT INTO devotees (' . implode(',', $names) . ') VALUES (:' . implode(',:', $names) . ')')
               ->execute(array_combine(array_map(fn($n) => ':' . $n, $names), array_values($cols)));
            $id = (int) $db->lastInsertId();
            if (!empty($args['verified'])) {
                $db->prepare('UPDATE devotees SET email_verified_at = UTC_TIMESTAMP() WHERE id = :id')->execute([':id' => $id]);
            }
            if (!empty($args['phoneVerified'])) {
                $db->prepare('UPDATE devotees SET phone_verified_at = UTC_TIMESTAMP() WHERE id = :id')->execute([':id' => $id]);
            }
            out(['id' => $id, 'email' => $email]);
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
            $prefix = (string) ($args['email_prefix'] ?? '');
            if (strlen($prefix) < 6 || !preg_match('/^[a-z0-9._-]+$/i', $prefix)) {
                out(['error' => 'email_prefix must be at least six safe characters'], 1);
            }
            $like = addcslashes($prefix, '%_\\') . '%';
            // Notifications, deliveries, prefs, devices, tags and OTPs cascade from devotees.
            $stmt = $db->prepare('DELETE FROM devotees WHERE email LIKE :p');
            $stmt->execute([':p' => $like]);
            out(['deleted_devotees' => $stmt->rowCount()]);
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
