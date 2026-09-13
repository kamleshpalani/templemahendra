<?php
/**
 * tests/support/notify_core_harness.php — calls into the Notification Service
 * core for tests/notify-worker.mjs. CLI only; refuses to run from a web server.
 *
 *   php tests/support/notify_core_harness.php campaign-save '{"input":{…},"actor":{"username":"e2e","role":"editor"}}'
 *   php tests/support/notify_core_harness.php campaign-transition '{"id":9,"action":"submit","actor":{…}}'
 *   php tests/support/notify_core_harness.php bulk-devotees '{"prefix":"e2e-core-abc-bulk-","count":600,"tag":"e2e-core-abc"}'
 *   php tests/support/notify_core_harness.php cleanup '{"email_prefix":"e2e-core-","run_ids":[1,2]}'
 *
 * Every command prints one JSON object and exits 0, or 1 with {"error": "…"}.
 * The second argument may be "@path/to/file.json" for payloads too long for a
 * command line.
 *
 * The functions called here are the real ones; this file only translates JSON
 * to arguments, plus a few fixtures the shared notify_fixtures.php does not
 * offer (hundreds of devotees at once, targeted cleanup of this suite's rows).
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../../backend/includes/notify.php';

function harnessOut(array $data, int $code = 0): never
{
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR), "\n";
    exit($code);
}

$cmd = $argv[1] ?? '';
$raw = $argv[2] ?? '{}';
if (str_starts_with($raw, '@')) $raw = (string) @file_get_contents(substr($raw, 1));
$args = json_decode($raw, true);
if (!is_array($args)) harnessOut(['error' => 'second argument must be a JSON object'], 1);

$actor = static fn(): array => (array) ($args['actor'] ?? []);

try {
    $db = getDB();
    switch ($cmd) {
        case 'campaign-save':
            harnessOut(notifyCampaignSave((array) ($args['input'] ?? []), $actor(), isset($args['id']) ? (int) $args['id'] : null));

        case 'campaign-transition':
            harnessOut(notifyCampaignTransition((int) ($args['id'] ?? 0), (string) ($args['action'] ?? ''), $actor(), (array) ($args['opts'] ?? [])));

        case 'campaign-get':
            harnessOut(['campaign' => notifyCampaignGet((int) ($args['id'] ?? 0))]);

        case 'campaign-stats':
            harnessOut(notifyCampaignStats((int) ($args['id'] ?? 0)));

        case 'campaign-preview':
            harnessOut(notifyCampaignPreview((array) ($args['campaign'] ?? []), (string) ($args['channel'] ?? 'inapp'), (string) ($args['lang'] ?? 'ta'), isset($args['sample']) ? (int) $args['sample'] : null));

        case 'campaign-test-send':
            harnessOut(notifyCampaignTestSend((int) ($args['id'] ?? 0), $actor(), (array) ($args['to'] ?? [])));

        case 'needs-approval':
            harnessOut(['reason' => notifyCampaignNeedsApproval((array) ($args['campaign'] ?? []), (int) ($args['estimate'] ?? 0))]);

        case 'audience-count':
            try {
                harnessOut(['count' => notifyAudienceCount((array) ($args['rules'] ?? []))]);
            } catch (InvalidArgumentException $e) {
                harnessOut(['invalid' => $e->getMessage()]);
            }

        case 'dispatch':
            harnessOut(notifyDispatchDelivery((int) ($args['id'] ?? 0), (array) ($args['secret_vars'] ?? [])));

        case 'requeue':
            harnessOut(['ok' => notifyRequeue((int) ($args['id'] ?? 0), (string) ($args['actor'] ?? 'e2e'))]);

        case 'provider-update':
            harnessOut(['changed' => notifyApplyProviderUpdate(
                (string) ($args['provider'] ?? ''), (string) ($args['message_id'] ?? ''), (string) ($args['status'] ?? ''),
                isset($args['error']) ? (string) $args['error'] : null, isset($args['at']) ? (string) $args['at'] : null
            )]);

        case 'record-click':
            notifyRecordClick((int) ($args['id'] ?? 0));
            harnessOut(['ok' => true]);

        case 'record-open':
            notifyRecordOpen((int) ($args['id'] ?? 0));
            harnessOut(['ok' => true]);

        case 'register-device':
            harnessOut(notifyRegisterDevice((int) ($args['devotee_id'] ?? 0), (array) ($args['subscription'] ?? []), (string) ($args['platform'] ?? 'web'), $args['user_agent'] ?? null));

        case 'remove-device':
            harnessOut(['ok' => notifyRemoveDevice((int) ($args['devotee_id'] ?? 0), (string) ($args['endpoint'] ?? ''))]);

        case 'vapid':
            $keys = notifyVapidKeys();
            harnessOut(['public' => notifyVapidPublicKey(), 'source' => $keys['source'] ?? null, 'privateLength' => isset($keys['private']) ? strlen(notifyB64uDecode($keys['private'])) : null]);

        case 'otp-issue':
            harnessOut(notifyOtpIssue((int) ($args['devotee_id'] ?? 0), (string) ($args['phone'] ?? '')));

        case 'otp-verify':
            harnessOut(notifyOtpVerify((int) ($args['devotee_id'] ?? 0), (string) ($args['phone'] ?? ''), (string) ($args['code'] ?? '')));

        case 'prefs':
            harnessOut(notifyPrefs((int) ($args['devotee_id'] ?? 0)));

        case 'prefs-save':
            try {
                harnessOut(['prefs' => notifySavePrefs((int) ($args['devotee_id'] ?? 0), (array) ($args['input'] ?? []))]);
            } catch (InvalidArgumentException $e) {
                harnessOut(['invalid' => $e->getMessage()]);
            }

        case 'bulk-devotees': {
            // Hundreds of devotees in a few statements. One bcrypt hash is shared:
            // these accounts are never signed in to.
            $prefix = (string) ($args['prefix'] ?? '');
            $count  = max(1, min(2000, (int) ($args['count'] ?? 1)));
            if (!preg_match('/^e2e-[a-z0-9._-]{4,60}$/', $prefix)) harnessOut(['error' => 'prefix must start with e2e- and be safe'], 1);
            $hash    = password_hash('Kolam99Deep', PASSWORD_BCRYPT, ['cost' => 4]);
            $country = normalizeCountry($args['country'] ?? 'IN') ?? 'IN';
            $now     = gmdate('Y-m-d H:i:s');
            for ($start = 0; $start < $count; $start += 200) {
                $rows = [];
                $params = [];
                for ($i = $start; $i < min($count, $start + 200); $i++) {
                    $rows[] = '(?, ?, NULL, ?, ?, ?, ?, ?, ?)';
                    array_push($params, 'E2E Bulk ' . $i, $prefix . $i . '@example.test', $country, 'TN', 'Pudupatti', $hash, !empty($args['verified']) ? $now : null, $now);
                }
                $db->prepare('INSERT INTO devotees (name, email, phone, country, state, city, pass_hash, email_verified_at, created_at) VALUES ' . implode(', ', $rows))
                   ->execute($params);
            }
            $like = addcslashes($prefix, '%_\\') . '%';
            if (!empty($args['tag'])) {
                $db->prepare("INSERT IGNORE INTO devotee_tags (devotee_id, tag, created_by) SELECT id, :t, 'e2e' FROM devotees WHERE email LIKE :p")
                   ->execute([':t' => (string) $args['tag'], ':p' => $like]);
            }
            $stmt = $db->prepare('SELECT COUNT(*) AS n, MIN(id) AS first, MAX(id) AS last FROM devotees WHERE email LIKE :p');
            $stmt->execute([':p' => $like]);
            harnessOut($stmt->fetch(PDO::FETCH_ASSOC));
        }

        case 'tag': {
            $ins = $db->prepare("INSERT IGNORE INTO devotee_tags (devotee_id, tag, created_by) VALUES (:d, :t, 'e2e')");
            foreach ((array) ($args['devotee_ids'] ?? []) as $id) $ins->execute([':d' => (int) $id, ':t' => (string) ($args['tag'] ?? '')]);
            harnessOut(['ok' => true]);
        }

        case 'cleanup': {
            // Only what this suite creates: devotees by e-mail prefix, and rows
            // named or keyed E2E-CORE / e2e:core.
            $prefix = (string) ($args['email_prefix'] ?? '');
            if (!preg_match('/^e2e-core[a-z0-9._-]*$/', $prefix)) harnessOut(['error' => 'email_prefix must start with e2e-core'], 1);
            $like = addcslashes($prefix, '%_\\') . '%';
            $deleted = [];

            $ids = $db->prepare('SELECT id FROM devotees WHERE email LIKE :p');
            $ids->execute([':p' => $like]);
            $devoteeIds = array_map('intval', $ids->fetchAll(PDO::FETCH_COLUMN));
            if ($devoteeIds) {
                $buckets = [];
                foreach ($devoteeIds as $id) array_push($buckets, 'otp-issue-15m:d' . $id, 'otp-issue-day:d' . $id);
                foreach (array_chunk($buckets, 500) as $chunk) {
                    $db->prepare('DELETE FROM rate_limits WHERE bucket IN (' . implode(',', array_fill(0, count($chunk), '?')) . ')')->execute($chunk);
                }
            }

            $campaignIds = array_map('intval', $db->query(
                "SELECT id FROM notification_campaigns WHERE name LIKE 'E2E-CORE-%' OR name LIKE 'Reminder: E2E-CORE-%'"
            )->fetchAll(PDO::FETCH_COLUMN));
            $bookingIds = array_map('intval', $db->query("SELECT id FROM seva_bookings WHERE devotee_name LIKE 'E2E-CORE-%'")->fetchAll(PDO::FETCH_COLUMN));

            $where = ["dedupe_key LIKE 'e2e:core:%'"];
            if ($campaignIds) {
                $in = implode(',', $campaignIds);
                $where[] = "campaign_id IN ({$in})";
                $where[] = "(entity_type = 'campaign' AND entity_id IN ({$in}))";
            }
            if ($bookingIds) $where[] = "(entity_type = 'seva_booking' AND entity_id IN (" . implode(',', $bookingIds) . '))';
            $deleted['notifications'] = $db->exec('DELETE FROM notifications WHERE ' . implode(' OR ', $where));

            $auditWhere = "campaign_name LIKE 'E2E-CORE-%' OR campaign_name LIKE 'Reminder: E2E-CORE-%'";
            if ($campaignIds) $auditWhere .= ' OR campaign_id IN (' . implode(',', $campaignIds) . ')';
            $deleted['audit'] = $db->exec("DELETE FROM notification_audit WHERE {$auditWhere}");
            $deleted['campaigns'] = $campaignIds ? $db->exec('DELETE FROM notification_campaigns WHERE id IN (' . implode(',', $campaignIds) . ')') : 0;

            $deleted['bookings'] = $db->exec("DELETE FROM seva_bookings WHERE devotee_name LIKE 'E2E-CORE-%'");
            $deleted['events']   = $db->exec("DELETE FROM events WHERE title_en LIKE 'E2E-CORE-%'");
            $deleted['poojas']   = $db->exec("DELETE FROM poojas WHERE name_en LIKE 'E2E-CORE-%'");

            $runs = array_values(array_filter(array_map('intval', (array) ($args['run_ids'] ?? [])), static fn(int $i): bool => $i > 0));
            $deleted['worker_runs'] = $runs ? $db->exec('DELETE FROM notification_worker_runs WHERE id IN (' . implode(',', $runs) . ')') : 0;

            $stmt = $db->prepare('DELETE FROM devotees WHERE email LIKE :p');
            $stmt->execute([':p' => $like]);
            $deleted['devotees'] = $stmt->rowCount();
            harnessOut(['deleted' => $deleted]);
        }
    }
    harnessOut(['error' => 'unknown command'], 1);
} catch (Throwable $e) {
    harnessOut(['error' => get_class($e) . ': ' . $e->getMessage()], 1);
}
