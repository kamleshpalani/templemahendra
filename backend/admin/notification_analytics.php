<?php
// backend/admin/notification_analytics.php — Delivery Analytics: are messages
// reaching devotees, and is the worker that sends them alive?
//
// Everything here is read from notifications and notification_deliveries, the
// queue itself, so the numbers are what actually happened rather than a copy
// kept for reporting. Definitions (they are shown on the page too):
//
//   sent       the provider accepted it: status sent, delivered or read
//   delivered  the provider confirmed it (delivered, read), or an in-app
//              notification is on the bell — in-app has no provider in between
//   failed     failed (retry pending), rejected or dead
//   rates      numerator ÷ denominator, one decimal, "—" when nothing qualifies
//
// Dates are chosen in the temple's timezone and converted to UTC before they
// reach SQL, because every notification DATETIME is UTC (SPEC §3). All filters
// are bound parameters; the date range is always a plain range on created_at.
//
// Requeue needs notifications.compose; everything else needs only
// notifications.view. The CSV holds no email addresses or phone numbers.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/notify.php';
require_once __DIR__ . '/includes/admin_layout.php';

const NA_PAGE     = '/admin/notification_analytics.php';
const NA_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'rejected', 'dead', 'skipped', 'cancelled'];
const NA_CHANNEL_LABELS = ['inapp' => 'In-app', 'email' => 'Email', 'whatsapp' => 'WhatsApp', 'sms' => 'SMS', 'push' => 'Push'];
const NA_MAX_DAYS = 366;

$db  = getDB();
$str = static fn(array $src, string $k): string => is_scalar($src[$k] ?? null) ? trim((string) $src[$k]) : '';

if (!notifyTablesExist()) {
    adminHeader('Delivery Analytics', 'Communication');
    echo adminEmpty('activity', 'Notifications are not switched on yet', 'Apply database/migrations/007_notifications.sql. Sends, opens, clicks and failures will be reported here once messages go out.');
    adminFooter();
    exit;
}

$canCompose = adminCan('notifications.compose');
$me         = currentAdmin() ?? [];
$actorName  = (string) ($me['username'] ?? 'admin');
$tz         = notifyTempleTz();
$tzLabel    = $tz === 'Asia/Kolkata' ? 'IST' : $tz;

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** A rate as ['text' => '42.9%' | '—', 'title' => 'n/d']. Never divides by zero. */
function naRate(int $n, int $d): array
{
    return ['text' => $d > 0 ? number_format($n / $d * 100, 1) . '%' : '—', 'title' => $n . '/' . $d];
}

/** A UTC DATETIME in the temple's timezone, e.g. "13 Sep 2026 · 18:45". */
function naLocal(?string $utc, string $tz, string $format = 'd M Y · H:i'): string
{
    if ($utc === null || $utc === '') return '—';
    try {
        return notifyFromUtc($utc, $tz, $format);
    } catch (Throwable) {
        return $utc;
    }
}

/** "3 min ago" measured in UTC (adminAgo() reads times in PHP's zone, which is not what these columns hold). */
function naAgoSeconds(string $utc): int
{
    try {
        $then = new DateTimeImmutable($utc, new DateTimeZone('UTC'));
        $now  = new DateTimeImmutable(notifyNow(), new DateTimeZone('UTC'));
        return max(0, $now->getTimestamp() - $then->getTimestamp());
    } catch (Throwable) {
        return PHP_INT_MAX;
    }
}

function naAgoText(int $seconds): string
{
    if ($seconds < 60) return 'just now';
    if ($seconds < 3600) return intdiv($seconds, 60) . ' min ago';
    if ($seconds < 86400) return intdiv($seconds, 3600) . ' h ago';
    return intdiv($seconds, 86400) . ' d ago';
}

/**
 * A CSV cell a spreadsheet will not execute. A value starting with = + - or @
 * is read as a formula by Excel and LibreOffice (a notification title is
 * committee-written and a failure reason is provider-written, so neither is
 * trusted); a leading apostrophe makes it text. Tab and carriage return are
 * treated the same way, as OWASP recommends.
 */
function naCsvCell(mixed $value): string
{
    $s = $value === null ? '' : (string) $value;
    return preg_match('/^[=+\-@\t\r]/', $s) ? "'" . $s : $s;
}

/** KPI cards in the dashboard's .stat markup, with data-kpi hooks and the n/d of a rate in a title. */
function naKpiGrid(array $items, string $label): string
{
    $out = '<div class="stats-grid" role="list" aria-label="' . h($label) . '">';
    foreach ($items as $i => $it) {
        $title = isset($it['title']) ? ' title="' . h($it['title']) . '"' : '';
        $out .= '<div class="card card--static stat rise" role="listitem" style="--i:' . (int) $i . '">';
        $out .= '<span class="stat__icon">' . adminIcon($it['icon']) . '</span><div class="stat__body">';
        $out .= '<div class="stat__val" data-kpi="' . h($it['key']) . '"' . $title . '>' . h((string) $it['value']) . '</div>';
        $out .= '<div class="stat__label">' . h($it['label']) . '</div>';
        if (!empty($it['sub'])) $out .= '<div class="stat__sub">' . h($it['sub']) . '</div>';
        $out .= '</div></div>';
    }
    return $out . '</div>';
}

/* ── Filters ─────────────────────────────────────────────────────────────── */

$src   = $_SERVER['REQUEST_METHOD'] === 'POST' ? $_POST : $_GET; // a requeue returns to the list it came from
$today = notifyFromUtc(notifyNow(), $tz, 'Y-m-d');
$isDay = static fn(string $d): bool => (bool) preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) && isValidDate($d);

$from = $isDay($str($src, 'from')) ? $str($src, 'from') : (new DateTimeImmutable($today))->modify('-29 days')->format('Y-m-d');
$to   = $isDay($str($src, 'to')) ? $str($src, 'to') : $today;
if ($from > $to) [$from, $to] = [$to, $from];
$clamped = false;
$span    = (int) (new DateTimeImmutable($from))->diff(new DateTimeImmutable($to))->days + 1;
if ($span > NA_MAX_DAYS) {
    $from    = (new DateTimeImmutable($to))->modify('-' . (NA_MAX_DAYS - 1) . ' days')->format('Y-m-d');
    $span    = NA_MAX_DAYS;
    $clamped = true;
}

$channel  = in_array($str($src, 'channel'), NOTIFY_CHANNELS, true) ? $str($src, 'channel') : '';
$status   = in_array($str($src, 'status'), NA_STATUSES, true) ? $str($src, 'status') : '';
$campaign = preg_match('/^\d{1,10}$/', $str($src, 'campaign')) ? (int) $str($src, 'campaign') : 0;
$category = $str($src, 'category');
$categories = notifyCategories(false);
$category = isset($categories[$category]) ? $category : '';
$source   = $str($src, 'source');
$segment  = 0;
if (preg_match('/^segment:(\d{1,10})$/', $source, $m)) {
    $segment = (int) $m[1];
} elseif (!in_array($source, ['automated', 'campaign'], true)) {
    $source = '';
}

$query = [
    'from' => $from, 'to' => $to, 'channel' => $channel, 'status' => $status,
    'campaign' => $campaign ?: '', 'category' => $category, 'source' => $source,
];
$defaultFrom = (new DateTimeImmutable($today))->modify('-29 days')->format('Y-m-d');
$hasFilters  = $channel !== '' || $status !== '' || $campaign > 0 || $category !== '' || $source !== '' || $from !== $defaultFrom || $to !== $today;
$selfUrl     = NA_PAGE . rtrim(adminQuery($query), '?');

// The half-open UTC range [fromUtc, toUtc) covering whole temple-time days.
$fromUtc = notifyToUtc($from . ' 00:00:00', $tz);
$toUtc   = notifyToUtc((new DateTimeImmutable($to))->modify('+1 day')->format('Y-m-d') . ' 00:00:00', $tz);

/**
 * WHERE for the filtered deliveries (alias d, joined to notifications n). The
 * date range is on d.created_at, the moment the message was queued, so a
 * delivery belongs to one day however long its retries take.
 */
$where  = ['d.created_at >= :from', 'd.created_at < :to'];
$params = [':from' => $fromUtc, ':to' => $toUtc];
if ($channel !== '')  { $where[] = 'd.channel = :channel';   $params[':channel'] = $channel; }
if ($status !== '')   { $where[] = 'd.status = :status';     $params[':status'] = $status; }
if ($category !== '') { $where[] = 'n.category = :category'; $params[':category'] = $category; }
if ($campaign > 0)    { $where[] = 'n.campaign_id = :campaign'; $params[':campaign'] = $campaign; }
if ($source === 'automated') $where[] = 'n.campaign_id IS NULL';
if ($source === 'campaign')  $where[] = 'n.campaign_id IS NOT NULL';
if ($segment > 0) {
    $where[] = 'n.campaign_id IN (SELECT sc.id FROM notification_campaigns sc WHERE sc.segment_id = :segment)';
    $params[':segment'] = $segment;
}
$fromSql  = ' FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id';
$whereSql = ' WHERE ' . implode(' AND ', $where);

// Status groups, written once so every query counts the same way.
$SENT      = "d.status IN ('sent','delivered','read')";
$DELIVERED = "(d.status IN ('delivered','read') OR (d.channel = 'inapp' AND d.status = 'sent'))";
$FAILED    = "d.status IN ('failed','rejected','dead')";
$ATTEMPTED = "d.status IN ('sent','delivered','read','failed','rejected','dead')";
$OPENED    = "($SENT AND (d.read_at IS NOT NULL OR d.status = 'read'))";
$CLICKED   = "($SENT AND d.clicked_at IS NOT NULL)";

/* ── Requeue (POST) ──────────────────────────────────────────────────────── */

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $msg = adminCsrfGuard();
    $action = $str($_POST, 'action');
    if ($msg === '' && $action === 'requeue') {
        $id = preg_match('/^\d{1,10}$/', $str($_POST, 'delivery_id')) ? (int) $str($_POST, 'delivery_id') : 0;
        if (!$canCompose) {
            $_SESSION['flash_nanalytics'] = ['error', 'Your role cannot requeue deliveries.'];
        } elseif ($id <= 0) {
            $_SESSION['flash_nanalytics'] = ['error', 'Invalid delivery id.'];
        } else {
            $stmt = $db->prepare(
                "SELECT d.status, d.channel, JSON_CONTAINS_PATH(COALESCE(n.vars, JSON_OBJECT()), 'one', '$._secret') AS has_secret
                   FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE d.id = :id"
            );
            $stmt->execute([':id' => $id]);
            $d = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$d) {
                $_SESSION['flash_nanalytics'] = ['warning', 'Delivery #' . $id . ' no longer exists.'];
            } elseif (!in_array($d['status'], ['failed', 'rejected', 'dead'], true)) {
                $_SESSION['flash_nanalytics'] = ['info', 'Delivery #' . $id . ' is ' . $d['status'] . ' now, so there is nothing to requeue.'];
            } elseif ((int) $d['has_secret'] === 1) {
                $_SESSION['flash_nanalytics'] = ['error', 'Delivery #' . $id . ' carried a one-time code or link, which is never stored, so it cannot be sent again. The devotee can ask for a new one.'];
            } elseif (notifyRequeue($id, $actorName)) {
                $_SESSION['flash_nanalytics'] = ['success', 'Delivery #' . $id . ' (' . (NA_CHANNEL_LABELS[$d['channel']] ?? $d['channel']) . ') is back in the queue with its attempts reset. The worker sends it on its next run.'];
            } else {
                $_SESSION['flash_nanalytics'] = ['error', 'Delivery #' . $id . ' could not be requeued. It may have changed in the meantime; reload and try again.'];
            }
        }
        header('Location: ' . $selfUrl, true, 303);
        exit;
    }
    if ($msg === '') $msg = '<p class="alert alert--error" role="alert">Unknown action.</p>';
    $_SESSION['flash_nanalytics'] = ['error', strip_tags($msg)];
    header('Location: ' . $selfUrl, true, 303);
    exit;
}

/* ── CSV export ──────────────────────────────────────────────────────────── */

if ($str($_GET, 'export') === 'csv') {
    requireAdminCan('export');
    $cols = [
        'delivery_id', 'queued_at_' . strtolower(preg_replace('/\W+/', '_', $tzLabel)), 'channel', 'status', 'attempts', 'max_attempts',
        'provider', 'provider_message_id', 'sent_at', 'delivered_at', 'read_at', 'clicked_at', 'failure_reason', 'skip_reason',
        'notification_id', 'category', 'priority', 'source', 'event', 'template_key', 'campaign_id', 'campaign_name',
        'title', 'recipient_type', 'devotee_id',
    ];
    // Unbuffered, so a year of deliveries streams instead of filling PHP's memory.
    // Nothing else queries the connection until the export exits.
    $db->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, false);
    $stmt = $db->prepare(
        'SELECT d.id, d.created_at, d.channel, d.status, d.attempts, d.max_attempts, d.provider, d.provider_message_id,
                d.sent_at, d.delivered_at, d.read_at, d.clicked_at, d.failure_reason, d.skip_reason,
                n.id AS notification_id, n.category, n.priority, n.event, n.template_key, n.campaign_id, c.name AS campaign_name,
                n.title, n.recipient_type, n.devotee_id'
        . $fromSql . ' LEFT JOIN notification_campaigns c ON c.id = n.campaign_id' . $whereSql
        . ' ORDER BY d.created_at, d.id'
    );
    $stmt->execute($params);
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="notification-deliveries-' . $from . '-to-' . $to . '.csv"');
    header('Cache-Control: no-store');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF"); // BOM so Excel reads Tamil titles correctly
    fputcsv($out, $cols, ',', '"', '');
    $local = static fn(?string $utc): string => $utc === null ? '' : notifyFromUtc($utc, $tz);
    while ($r = $stmt->fetch(PDO::FETCH_ASSOC)) {
        fputcsv($out, array_map('naCsvCell', [
            $r['id'], $local($r['created_at']), $r['channel'], $r['status'], $r['attempts'], $r['max_attempts'],
            $r['provider'], $r['provider_message_id'], $local($r['sent_at']), $local($r['delivered_at']), $local($r['read_at']), $local($r['clicked_at']),
            $r['failure_reason'], $r['skip_reason'], $r['notification_id'], $r['category'], $r['priority'],
            $r['campaign_id'] !== null ? 'campaign' : 'automated', $r['event'], $r['template_key'], $r['campaign_id'], $r['campaign_name'],
            $r['title'], $r['recipient_type'], $r['devotee_id'],
        ]), ',', '"', '');
    }
    fclose($out);
    exit;
}

/* ── Numbers ─────────────────────────────────────────────────────────────── */

$totals = $db->prepare(
    "SELECT COUNT(*) AS total,
            COUNT(DISTINCT d.notification_id) AS notifications,
            COALESCE(SUM($SENT), 0) AS sent,
            COALESCE(SUM($DELIVERED), 0) AS delivered,
            COALESCE(SUM($FAILED), 0) AS failed,
            COALESCE(SUM(d.channel = 'email' AND $SENT), 0) AS email_sent,
            COALESCE(SUM(d.channel = 'email' AND $OPENED), 0) AS email_opened,
            COALESCE(SUM(d.channel = 'inapp' AND $SENT), 0) AS inapp_sent,
            COALESCE(SUM(d.channel = 'inapp' AND $OPENED), 0) AS inapp_read,
            COALESCE(SUM($CLICKED), 0) AS clicked,
            COALESCE(SUM(d.channel = 'whatsapp' AND $ATTEMPTED), 0) AS wa_attempted,
            COALESCE(SUM(d.channel = 'whatsapp' AND d.status IN ('delivered','read')), 0) AS wa_delivered,
            COALESCE(SUM(d.channel = 'sms' AND $ATTEMPTED), 0) AS sms_attempted,
            COALESCE(SUM(d.channel = 'sms' AND d.status IN ('delivered','read')), 0) AS sms_delivered,
            COALESCE(SUM(d.channel = 'push' AND $SENT), 0) AS push_sent,
            COALESCE(SUM(d.channel = 'push' AND $CLICKED), 0) AS push_clicked"
    . $fromSql . $whereSql
);
$totals->execute($params);
$t = array_map('intval', $totals->fetch(PDO::FETCH_ASSOC) ?: []);

// Notifications created in the range. Without delivery filters this counts the
// notifications table itself (a notification whose every channel was skipped
// still counts); with them, the notifications that have a matching delivery.
$nWhere  = ['n.created_at >= :from', 'n.created_at < :to'];
$nParams = [':from' => $fromUtc, ':to' => $toUtc];
if ($category !== '') { $nWhere[] = 'n.category = :category'; $nParams[':category'] = $category; }
if ($campaign > 0)    { $nWhere[] = 'n.campaign_id = :campaign'; $nParams[':campaign'] = $campaign; }
if ($source === 'automated') $nWhere[] = 'n.campaign_id IS NULL';
if ($source === 'campaign')  $nWhere[] = 'n.campaign_id IS NOT NULL';
if ($segment > 0) {
    $nWhere[] = 'n.campaign_id IN (SELECT sc.id FROM notification_campaigns sc WHERE sc.segment_id = :segment)';
    $nParams[':segment'] = $segment;
}
if ($channel !== '' || $status !== '') {
    $sub = ['nd.notification_id = n.id'];
    if ($channel !== '') { $sub[] = 'nd.channel = :channel'; $nParams[':channel'] = $channel; }
    if ($status !== '')  { $sub[] = 'nd.status = :status';   $nParams[':status'] = $status; }
    $nWhere[] = 'EXISTS (SELECT 1 FROM notification_deliveries nd WHERE ' . implode(' AND ', $sub) . ')';
}
$stmt = $db->prepare('SELECT COUNT(*) FROM notifications n WHERE ' . implode(' AND ', $nWhere));
$stmt->execute($nParams);
$notificationsCreated = (int) $stmt->fetchColumn();

// Sends per temple-time day. Grouped in 15-minute UTC buckets and folded into
// local days in PHP: every real UTC offset is a multiple of 15 minutes (India
// is +5:30, Nepal +5:45), so no bucket straddles a local midnight, and nothing
// depends on MySQL's time zone tables, which shared hosts often do not load.
$stmt = $db->prepare(
    "SELECT TIMESTAMPDIFF(MINUTE, '2000-01-01 00:00:00', d.created_at) DIV 15 AS bucket, COUNT(*) AS n"
    . $fromSql . $whereSql . " AND $SENT GROUP BY bucket"
);
$stmt->execute($params);
$monthly = $span > 62;
$series  = [];
$cursor  = new DateTimeImmutable($from);
$end     = new DateTimeImmutable($to);
while ($cursor <= $end) {
    $k = $cursor->format($monthly ? 'Y-m' : 'Y-m-d');
    $series[$k] ??= 0;
    $cursor = $cursor->modify('+1 day');
}
foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $b) {
    $utc = gmdate('Y-m-d H:i:s', 946684800 + (int) $b['bucket'] * 900);
    $k   = notifyFromUtc($utc, $tz, $monthly ? 'Y-m' : 'Y-m-d');
    if (isset($series[$k])) $series[$k] += (int) $b['n'];
}
$bars = [];
foreach ($series as $k => $n) {
    $d = new DateTimeImmutable($monthly ? $k . '-01' : $k);
    $bars[] = [
        'label' => $monthly ? $d->format('M') : $d->format('j'),
        'value' => $n,
        'hint'  => ($monthly ? $d->format('F Y') : $d->format('D, d M Y')) . ' · ' . number_format($n) . ' sent',
    ];
}

// Per channel
$stmt = $db->prepare(
    "SELECT d.channel, COUNT(*) AS total,
            COALESCE(SUM(d.status IN ('queued','sending')), 0) AS pending,
            COALESCE(SUM($SENT), 0) AS sent, COALESCE(SUM($DELIVERED), 0) AS delivered,
            COALESCE(SUM($OPENED), 0) AS opened, COALESCE(SUM($CLICKED), 0) AS clicked,
            COALESCE(SUM($ATTEMPTED), 0) AS attempted, COALESCE(SUM($FAILED), 0) AS failed,
            COALESCE(SUM(d.status = 'skipped'), 0) AS skipped, COALESCE(SUM(d.status = 'cancelled'), 0) AS cancelled"
    . $fromSql . $whereSql . ' GROUP BY d.channel'
);
$stmt->execute($params);
$byChannel = [];
foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) $byChannel[$r['channel']] = array_map('intval', array_diff_key($r, ['channel' => 1]));
$shareTones = ['inapp' => 'gold', 'email' => 'maroon', 'whatsapp' => 'sage', 'sms' => 'moon', 'push' => 'info'];
$shares = [];
foreach (NA_CHANNEL_LABELS as $ch => $label) {
    if (!isset($byChannel[$ch])) continue;
    $shares[] = ['label' => $label, 'value' => $byChannel[$ch]['total'], 'hint' => number_format($byChannel[$ch]['total']), 'tone' => $shareTones[$ch]];
}

// Per campaign
$stmt = $db->prepare(
    "SELECT n.campaign_id, c.name, c.status AS campaign_status,
            COUNT(DISTINCT n.id) AS recipients, COALESCE(SUM($SENT), 0) AS sent, COALESCE(SUM($DELIVERED), 0) AS delivered,
            COALESCE(SUM($OPENED), 0) AS opened, COALESCE(SUM($CLICKED), 0) AS clicked, COALESCE(SUM($FAILED), 0) AS failed,
            MAX(d.created_at) AS last_at"
    . $fromSql . ' LEFT JOIN notification_campaigns c ON c.id = n.campaign_id' . $whereSql
    . ' AND n.campaign_id IS NOT NULL GROUP BY n.campaign_id, c.name, c.status ORDER BY last_at DESC LIMIT 50'
);
$stmt->execute($params);
$campaignRows = $stmt->fetchAll(PDO::FETCH_ASSOC);

// Worker health: live, not filtered — the queue does not care what range you are looking at.
$lastRun = $db->query('SELECT * FROM notification_worker_runs ORDER BY started_at DESC, id DESC LIMIT 1')->fetch(PDO::FETCH_ASSOC) ?: null;
$runAge  = $lastRun ? naAgoSeconds((string) $lastRun['started_at']) : null;
$stale   = $lastRun === null || $runAge > 300;
$stmt = $db->prepare('SELECT COUNT(*) AS runs, COALESCE(SUM(error IS NOT NULL), 0) AS errors FROM notification_worker_runs WHERE started_at >= :since');
$stmt->execute([':since' => gmdate('Y-m-d H:i:s', (new DateTimeImmutable(notifyNow(), new DateTimeZone('UTC')))->getTimestamp() - 86400)]);
$runs24 = array_map('intval', $stmt->fetch(PDO::FETCH_ASSOC) ?: ['runs' => 0, 'errors' => 0]);
$queue  = [];
foreach ($db->query(
    "SELECT channel, SUM(status = 'queued') AS queued, SUM(status = 'sending') AS sending,
            SUM(status = 'failed') AS retrying, SUM(status = 'dead') AS dead
       FROM notification_deliveries WHERE status IN ('queued','sending','failed','dead') GROUP BY channel"
)->fetchAll(PDO::FETCH_ASSOC) as $r) {
    $queue[$r['channel']] = array_map('intval', array_diff_key($r, ['channel' => 1]));
}
$deadTotal = array_sum(array_column($queue, 'dead'));

// Failed and dead deliveries in the filter, newest first.
$failWhere = $whereSql . " AND d.status IN ('failed','rejected','dead')";
$page      = max(1, (int) $str($_GET, 'page'));
$failed    = adminPaginate(
    $db,
    "SELECT d.id, d.channel, d.status, d.attempts, d.max_attempts, d.next_attempt_at, d.provider, d.failure_reason,
            d.provider_response, d.created_at, d.updated_at, n.id AS notification_id, n.title, n.category, n.campaign_id,
            n.devotee_id, n.recipient_type, dv.name AS devotee_name,
            JSON_CONTAINS_PATH(COALESCE(n.vars, JSON_OBJECT()), 'one', '$._secret') AS has_secret"
    . $fromSql . ' LEFT JOIN devotees dv ON dv.id = n.devotee_id' . $failWhere . ' ORDER BY d.updated_at DESC, d.id DESC',
    $params, $page, 20,
    'SELECT COUNT(*)' . $fromSql . $failWhere
);

// Filter options
$campaignOptions = $db->query('SELECT id, name FROM notification_campaigns ORDER BY created_at DESC, id DESC LIMIT 200')->fetchAll(PDO::FETCH_ASSOC);
$segmentOptions  = $db->query('SELECT id, name FROM notification_segments ORDER BY name LIMIT 200')->fetchAll(PDO::FETCH_ASSOC);

// Flash
$msg   = '';
$flash = $_SESSION['flash_nanalytics'] ?? null;
unset($_SESSION['flash_nanalytics']);
if (is_array($flash) && count($flash) === 2) {
    [$tone, $text] = $flash;
    $tone = in_array($tone, ['success', 'error', 'warning', 'info'], true) ? $tone : 'info';
    $msg  = '<p class="alert alert--' . $tone . '" role="' . ($tone === 'error' ? 'alert' : 'status') . '">' . h((string) $text) . '</p>';
}

$statusTones = ['queued' => 'muted', 'sending' => 'info', 'sent' => 'info', 'delivered' => 'success', 'read' => 'success',
                'failed' => 'warning', 'rejected' => 'danger', 'dead' => 'danger', 'skipped' => 'muted', 'cancelled' => 'muted'];
$rate = static function (array $r) {
    return '<span class="na-rate" title="' . h($r['title']) . '">' . h($r['text']) . '</span>';
};
$exportHref = NA_PAGE . adminQuery($query, ['export' => 'csv']);
$ranges = ['Today' => 0, '7 days' => 6, '30 days' => 29, '90 days' => 89];

/* ── Page ────────────────────────────────────────────────────────────────── */

// Actions sit in the intro row rather than the topbar, which on a phone has room only for the title.
adminHeader('Delivery Analytics', 'Communication', ['wide' => true]);
echo $msg;
echo adminPageIntro(
    'Whether notifications are reaching devotees: what was sent, delivered, opened and clicked, what failed and why, and whether the sending worker is running. '
    . 'Dates are in ' . $tzLabel . '.' . ($clamped ? ' The range was shortened to the last ' . NA_MAX_DAYS . ' days.' : ''),
    (adminCan('export') ? '<a href="' . h($exportHref) . '" class="btn btn-primary btn--sm">' . adminIcon('download') . ($hasFilters ? 'Export filtered CSV' : 'Export CSV') . '</a>' : '')
    . '<a href="/admin/notification_templates.php" class="btn btn-ghost btn--sm">' . adminIcon('mail') . 'Message templates</a>'
);
?>

<form method="GET" action="<?= h(NA_PAGE) ?>" class="card card--static na-filters mb-4" aria-label="Filter deliveries">
  <div class="na-filters__grid">
    <label for="f-from"><span class="field__label">From</span>
      <input id="f-from" type="date" name="from" value="<?= h($from) ?>" max="<?= h($today) ?>" required />
    </label>
    <label for="f-to"><span class="field__label">To</span>
      <input id="f-to" type="date" name="to" value="<?= h($to) ?>" max="<?= h($today) ?>" required />
    </label>
    <label for="f-channel"><span class="field__label">Channel</span>
      <select id="f-channel" name="channel">
        <option value="">All channels</option>
        <?php foreach (NA_CHANNEL_LABELS as $ch => $label): ?><option value="<?= h($ch) ?>"<?= $channel === $ch ? ' selected' : '' ?>><?= h($label) ?></option><?php endforeach; ?>
      </select>
    </label>
    <label for="f-status"><span class="field__label">Status</span>
      <select id="f-status" name="status">
        <option value="">Any status</option>
        <?php foreach (NA_STATUSES as $s): ?><option value="<?= h($s) ?>"<?= $status === $s ? ' selected' : '' ?>><?= h(ucfirst($s)) ?></option><?php endforeach; ?>
      </select>
    </label>
    <label for="f-category"><span class="field__label">Category</span>
      <select id="f-category" name="category">
        <option value="">All categories</option>
        <?php foreach ($categories as $k => $c): ?><option value="<?= h($k) ?>"<?= $category === $k ? ' selected' : '' ?>><?= h($c['label_en']) ?></option><?php endforeach; ?>
      </select>
    </label>
    <label for="f-source"><span class="field__label">Source</span>
      <select id="f-source" name="source">
        <option value="">All sources</option>
        <option value="automated"<?= $source === 'automated' ? ' selected' : '' ?>>Automated messages</option>
        <option value="campaign"<?= $source === 'campaign' ? ' selected' : '' ?>>Any campaign</option>
        <?php if ($segmentOptions): ?>
        <optgroup label="Campaigns to a saved audience">
          <?php foreach ($segmentOptions as $sg): ?><option value="segment:<?= (int) $sg['id'] ?>"<?= $segment === (int) $sg['id'] ? ' selected' : '' ?>><?= h($sg['name']) ?></option><?php endforeach; ?>
        </optgroup>
        <?php endif; ?>
      </select>
    </label>
    <label for="f-campaign"><span class="field__label">Campaign</span>
      <select id="f-campaign" name="campaign">
        <option value="">All campaigns</option>
        <?php foreach ($campaignOptions as $co): ?><option value="<?= (int) $co['id'] ?>"<?= $campaign === (int) $co['id'] ? ' selected' : '' ?>><?= h($co['name']) ?></option><?php endforeach; ?>
      </select>
    </label>
  </div>
  <div class="na-filters__foot">
    <nav class="filter-chips" aria-label="Quick date ranges">
      <?php foreach ($ranges as $label => $days):
          $rFrom = (new DateTimeImmutable($today))->modify('-' . $days . ' days')->format('Y-m-d'); ?>
        <a class="chip" href="<?= h(NA_PAGE . adminQuery($query, ['from' => $rFrom, 'to' => $today, 'page' => null])) ?>"<?= $from === $rFrom && $to === $today ? ' aria-current="true"' : '' ?>><?= h($label) ?></a>
      <?php endforeach; ?>
    </nav>
    <div class="form-actions">
      <button type="submit" class="btn btn--sm"><?= adminIcon('filter') ?> Apply</button>
      <?php if ($hasFilters): ?><a href="<?= h(NA_PAGE) ?>" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Reset</a><?php endif; ?>
    </div>
  </div>
</form>

<?php
$opensRate = naRate($t['email_opened'] ?? 0, $t['email_sent'] ?? 0);
$readRate  = naRate($t['inapp_read'] ?? 0, $t['inapp_sent'] ?? 0);
$ctr       = naRate($t['clicked'] ?? 0, $t['sent'] ?? 0);
$waRate    = naRate($t['wa_delivered'] ?? 0, $t['wa_attempted'] ?? 0);
$smsRate   = naRate($t['sms_delivered'] ?? 0, $t['sms_attempted'] ?? 0);
$pushRate  = naRate($t['push_clicked'] ?? 0, $t['push_sent'] ?? 0);

echo naKpiGrid([
    ['key' => 'notifications', 'icon' => 'bell',         'value' => number_format($notificationsCreated), 'label' => 'Notifications created', 'sub' => number_format($t['total'] ?? 0) . ' deliveries across channels'],
    ['key' => 'sent',          'icon' => 'arrow-up-right','value' => number_format($t['sent'] ?? 0),      'label' => 'Deliveries sent',       'sub' => 'Accepted by the provider or shown on the bell'],
    ['key' => 'delivered',     'icon' => 'check-circle', 'value' => number_format($t['delivered'] ?? 0),  'label' => 'Delivered',             'sub' => 'Confirmed by the provider; in-app counts once shown'],
    ['key' => 'failed',        'icon' => 'alert',        'value' => number_format($t['failed'] ?? 0),     'label' => 'Failed',                'sub' => 'Retrying, rejected or dead'],
], 'Delivery counts');

echo naKpiGrid([
    ['key' => 'email_open_rate', 'icon' => 'mail',     'value' => $opensRate['text'], 'title' => $opensRate['title'], 'label' => 'Email open rate',        'sub' => ($t['email_opened'] ?? 0) . ' of ' . ($t['email_sent'] ?? 0) . ' sent emails opened'],
    ['key' => 'inapp_read_rate', 'icon' => 'bell',     'value' => $readRate['text'],  'title' => $readRate['title'],  'label' => 'In-app read rate',       'sub' => ($t['inapp_read'] ?? 0) . ' of ' . ($t['inapp_sent'] ?? 0) . ' read'],
    ['key' => 'click_rate',      'icon' => 'external', 'value' => $ctr['text'],       'title' => $ctr['title'],       'label' => 'Click-through rate',     'sub' => ($t['clicked'] ?? 0) . ' of ' . ($t['sent'] ?? 0) . ' sent were clicked'],
    ['key' => 'whatsapp_rate',   'icon' => 'phone',    'value' => $waRate['text'],    'title' => $waRate['title'],    'label' => 'WhatsApp delivery rate', 'sub' => ($t['wa_delivered'] ?? 0) . ' of ' . ($t['wa_attempted'] ?? 0) . ' attempted'],
    ['key' => 'sms_rate',        'icon' => 'phone',    'value' => $smsRate['text'],   'title' => $smsRate['title'],   'label' => 'SMS delivery rate',      'sub' => ($t['sms_delivered'] ?? 0) . ' of ' . ($t['sms_attempted'] ?? 0) . ' attempted'],
    ['key' => 'push_rate',       'icon' => 'activity', 'value' => $pushRate['text'],  'title' => $pushRate['title'],  'label' => 'Push engagement',        'sub' => ($t['push_clicked'] ?? 0) . ' of ' . ($t['push_sent'] ?? 0) . ' push messages opened'],
], 'Delivery rates');
?>

<div class="dash-grid">
  <section class="card card--static" aria-labelledby="daily-title">
    <div class="card__head">
      <h2 id="daily-title"><?= adminIcon('trending', 'ico--sm') ?> <?= $monthly ? 'Monthly' : 'Daily' ?> sends</h2>
      <span class="field__hint"><?= h(naLocal($fromUtc, $tz, 'd M')) ?> – <?= h((new DateTimeImmutable($to))->format('d M Y')) ?></span>
    </div>
    <div class="card__body na-bars">
      <?php if (($t['sent'] ?? 0) > 0): ?>
        <?= adminBars($bars, ($monthly ? 'Deliveries sent per month' : 'Deliveries sent per day') . ' (' . $tzLabel . ')') ?>
      <?php else: ?>
        <?= adminEmpty('activity', 'Nothing sent in this range', $hasFilters ? 'Try a wider date range or fewer filters.' : 'Messages the worker sends will chart here.', '', true) ?>
      <?php endif; ?>
    </div>
  </section>

  <section class="card card--static" aria-labelledby="shares-title">
    <div class="card__head"><h2 id="shares-title"><?= adminIcon('layers', 'ico--sm') ?> Deliveries by channel</h2></div>
    <div class="card__body">
      <?php if ($shares): ?>
        <?= adminShares($shares, 'Deliveries by channel') ?>
      <?php else: ?>
        <?= adminEmpty('layers', 'No deliveries in this range', '', '', true) ?>
      <?php endif; ?>
    </div>
  </section>
</div>

<section class="card card--static mb-6" aria-labelledby="chan-title">
  <div class="card__head"><h2 id="chan-title"><?= adminIcon('table', 'ico--sm') ?> Channel performance</h2></div>
  <?php if ($byChannel): ?>
  <?php /* tabindex: the table holds no link or button, so without it a keyboard user could not scroll it on a narrow screen. */ ?>
  <div class="table-wrap table-wrap--flush na-table-wrap" tabindex="0" role="region" aria-labelledby="chan-title">
    <table class="table" data-no-search>
      <thead>
        <tr>
          <th scope="col">Channel</th><th scope="col" class="cell-num">Deliveries</th><th scope="col" class="cell-num">Waiting</th>
          <th scope="col" class="cell-num">Sent</th><th scope="col" class="cell-num">Delivered</th><th scope="col" class="cell-num">Opened / read</th>
          <th scope="col" class="cell-num">Clicked</th><th scope="col" class="cell-num">Failed</th><th scope="col" class="cell-num">Skipped</th>
          <th scope="col" class="cell-num">Delivery rate</th><th scope="col" class="cell-num">Click rate</th>
        </tr>
      </thead>
      <tbody>
        <?php foreach (NA_CHANNEL_LABELS as $ch => $label): if (!isset($byChannel[$ch])) continue; $c = $byChannel[$ch]; ?>
        <tr data-channel="<?= h($ch) ?>">
          <td><span class="cell-title"><?= h($label) ?></span></td>
          <td class="cell-num"><?= number_format($c['total']) ?></td>
          <td class="cell-num"><?= number_format($c['pending']) ?></td>
          <td class="cell-num"><?= number_format($c['sent']) ?></td>
          <td class="cell-num"><?= number_format($c['delivered']) ?></td>
          <td class="cell-num"><?= number_format($c['opened']) ?></td>
          <td class="cell-num"><?= number_format($c['clicked']) ?></td>
          <td class="cell-num"><?= number_format($c['failed']) ?></td>
          <td class="cell-num"><?= number_format($c['skipped'] + $c['cancelled']) ?></td>
          <td class="cell-num"><?= $rate(naRate($c['delivered'], $ch === 'inapp' ? $c['sent'] : $c['attempted'])) ?></td>
          <td class="cell-num"><?= $rate(naRate($c['clicked'], $c['sent'])) ?></td>
        </tr>
        <?php endforeach; ?>
      </tbody>
    </table>
  </div>
  <p class="field__hint na-note">Skipped includes cancelled deliveries and channels a devotee switched off or has no contact for. Delivery rate is delivered ÷ attempted (in-app: ÷ sent). Hover a rate for its count.</p>
  <?php else: ?>
    <div class="card__body"><?= adminEmpty('table', 'No deliveries in this range', '', '', true) ?></div>
  <?php endif; ?>
</section>

<div class="dash-grid">
  <section class="card card--static" aria-labelledby="camp-title">
    <div class="card__head"><h2 id="camp-title"><?= adminIcon('megaphone', 'ico--sm') ?> Campaign performance</h2></div>
    <?php if ($campaignRows): ?>
    <div class="table-wrap table-wrap--flush">
      <table class="table" data-no-search>
        <thead>
          <tr>
            <th scope="col">Campaign</th><th scope="col" class="cell-num">Recipients</th><th scope="col" class="cell-num">Sent</th>
            <th scope="col" class="cell-num">Delivered</th><th scope="col" class="cell-num">Opened</th><th scope="col" class="cell-num">Clicked</th>
            <th scope="col" class="cell-num">Failed</th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($campaignRows as $cr): ?>
          <tr>
            <td>
              <a class="cell-title" href="<?= h(NA_PAGE . adminQuery($query, ['campaign' => (int) $cr['campaign_id'], 'page' => null])) ?>"><?= h($cr['name'] ?? ('Campaign #' . $cr['campaign_id'])) ?></a>
              <span class="cell-sub"><?= h(ucfirst((string) ($cr['campaign_status'] ?? 'deleted'))) ?> · last queued <?= h(naLocal($cr['last_at'], $tz, 'd M')) ?></span>
            </td>
            <td class="cell-num"><?= number_format((int) $cr['recipients']) ?></td>
            <td class="cell-num"><?= number_format((int) $cr['sent']) ?></td>
            <td class="cell-num"><?= number_format((int) $cr['delivered']) ?></td>
            <td class="cell-num"><?= number_format((int) $cr['opened']) ?> <span class="cell-sub"><?= $rate(naRate((int) $cr['opened'], (int) $cr['sent'])) ?></span></td>
            <td class="cell-num"><?= number_format((int) $cr['clicked']) ?> <span class="cell-sub"><?= $rate(naRate((int) $cr['clicked'], (int) $cr['sent'])) ?></span></td>
            <td class="cell-num"><?= number_format((int) $cr['failed']) ?></td>
          </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>
    <?php else: ?>
      <div class="card__body"><?= adminEmpty('megaphone', 'No campaign messages in this range', 'Campaigns the committee sends appear here with their reach and engagement.', '', true) ?></div>
    <?php endif; ?>
  </section>

  <section class="card card--static" aria-labelledby="worker-title" data-worker-health>
    <div class="card__head">
      <h2 id="worker-title"><?= adminIcon('clock', 'ico--sm') ?> Worker health</h2>
      <?= $stale ? adminBadge($lastRun ? 'Not running' : 'Never run', 'danger') : adminBadge('Running', 'success', true) ?>
    </div>
    <div class="card__body">
      <?php if ($stale): ?>
        <div class="callout callout--maroon mb-4" role="alert">
          <?= adminIcon('alert') ?>
          <p><?= $lastRun
              ? 'The worker last ran ' . h(naAgoText((int) $runAge)) . '. It should run every minute, so nothing external is being sent. Check the cron job for backend/bin/notify_worker.php, or the /api/notify-cron trigger.'
              : 'The worker has never run, so no email, WhatsApp, SMS or push message has been sent. Set up the cron job for backend/bin/notify_worker.php (every minute), or the /api/notify-cron trigger.' ?></p>
        </div>
      <?php endif; ?>
      <dl class="dl-grid">
        <dt>Last run</dt>
        <dd><?= $lastRun ? h(naLocal($lastRun['started_at'], $tz)) . ' ' . h($tzLabel) . ' <span class="text-muted">(' . h(naAgoText((int) $runAge)) . ', ' . h((string) $lastRun['trigger']) . ')</span>' : 'Never' ?></dd>
        <?php if ($lastRun): ?>
        <dt>That run</dt>
        <dd><?= (int) $lastRun['claimed'] ?> claimed · <?= (int) $lastRun['sent'] ?> sent · <?= (int) $lastRun['failed'] ?> failed · <?= (int) $lastRun['dead'] ?> dead · <?= number_format((int) $lastRun['duration_ms']) ?> ms</dd>
        <dt>Last error</dt>
        <dd><?= $lastRun['error'] !== null && $lastRun['error'] !== '' ? '<span class="na-error">' . h((string) $lastRun['error']) . '</span>' : 'None' ?></dd>
        <?php endif; ?>
        <dt>Last 24 hours</dt>
        <dd><?= $runs24['runs'] ?> run<?= $runs24['runs'] === 1 ? '' : 's' ?>, <?= $runs24['errors'] ?> with an error</dd>
        <dt>Dead, waiting for you</dt>
        <dd><?= number_format($deadTotal) ?></dd>
      </dl>

      <h3 class="subhead">Queue now</h3>
      <?php if ($queue): ?>
      <div class="table-wrap table-wrap--flush na-table-wrap" tabindex="0" role="region" aria-label="Queue by channel">
        <table class="table table--compact" data-no-search data-no-responsive>
          <thead><tr><th scope="col">Channel</th><th scope="col" class="cell-num">Queued</th><th scope="col" class="cell-num">Sending</th><th scope="col" class="cell-num">Retrying</th><th scope="col" class="cell-num">Dead</th></tr></thead>
          <tbody>
            <?php foreach (NA_CHANNEL_LABELS as $ch => $label): if (!isset($queue[$ch])) continue; $qd = $queue[$ch]; ?>
            <tr data-queue="<?= h($ch) ?>"><th scope="row"><?= h($label) ?></th><td class="cell-num"><?= $qd['queued'] ?></td><td class="cell-num"><?= $qd['sending'] ?></td><td class="cell-num"><?= $qd['retrying'] ?></td><td class="cell-num"><?= $qd['dead'] ?></td></tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      </div>
      <p class="field__hint na-note">Queued includes messages held for a later time.</p>
      <?php else: ?>
        <p class="field__hint">The queue is empty.</p>
      <?php endif; ?>
    </div>
  </section>
</div>

<section class="card card--static" aria-labelledby="failed-title" id="failed">
  <div class="card__head">
    <h2 id="failed-title"><?= adminIcon('alert-circle', 'ico--sm') ?> Failed and dead deliveries</h2>
    <span class="field__hint"><?= number_format($failed['total']) ?> in this filter</span>
  </div>
  <?php if ($failed['rows']): ?>
  <div class="table-wrap table-wrap--flush">
    <table class="table" data-no-search>
      <thead>
        <tr>
          <th scope="col">Delivery</th><th scope="col">Message</th><th scope="col">Status</th>
          <th scope="col">Reason and provider response</th><th scope="col">Updated</th>
          <th scope="col"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <?php foreach ($failed['rows'] as $f):
            $fid = (int) $f['id'];
            $who = $f['devotee_id'] !== null
                ? '<a href="/admin/devotees.php?edit=' . (int) $f['devotee_id'] . '">' . h($f['devotee_name'] ?? ('Devotee #' . $f['devotee_id'])) . '</a>'
                : 'Guest';
        ?>
        <tr data-delivery="<?= $fid ?>">
          <td>
            <span class="cell-title">#<?= $fid ?> · <?= h(NA_CHANNEL_LABELS[$f['channel']] ?? $f['channel']) ?></span>
            <span class="cell-sub"><?= $who ?><?= $f['provider'] ? ' · ' . h((string) $f['provider']) : '' ?></span>
          </td>
          <td>
            <span class="cell-clip"><?= h((string) $f['title']) ?></span>
            <span class="cell-sub"><?= h(($categories[$f['category']]['label_en'] ?? $f['category'])) ?><?= $f['campaign_id'] !== null ? ' · campaign #' . (int) $f['campaign_id'] : ' · automated' ?></span>
          </td>
          <td>
            <?= adminBadge(ucfirst((string) $f['status']), $statusTones[$f['status']] ?? 'muted') ?>
            <span class="cell-sub">Attempt <?= (int) $f['attempts'] ?> of <?= (int) $f['max_attempts'] ?><?= $f['status'] === 'failed' && $f['next_attempt_at'] ? ' · retry ' . h(naLocal($f['next_attempt_at'], $tz, 'd M H:i')) : '' ?></span>
          </td>
          <td class="na-reason">
            <?= $f['failure_reason'] !== null && $f['failure_reason'] !== '' ? h((string) $f['failure_reason']) : '<span class="text-muted">No reason recorded</span>' ?>
            <?php if ($f['provider_response'] !== null && $f['provider_response'] !== ''): ?>
              <details class="na-response">
                <summary>Provider response</summary>
                <pre><?= h((string) $f['provider_response']) ?></pre>
              </details>
            <?php endif; ?>
          </td>
          <td class="cell-date"><time datetime="<?= h(notifyIso($f['updated_at'])) ?>"><?= h(naLocal($f['updated_at'], $tz)) ?></time></td>
          <td class="cell-actions">
            <?php if ($canCompose && (int) $f['has_secret'] !== 1): ?>
              <form method="POST" action="<?= h($selfUrl) ?>" class="na-requeue">
                <?= csrfField() ?>
                <input type="hidden" name="action" value="requeue" />
                <input type="hidden" name="delivery_id" value="<?= $fid ?>" />
                <?php foreach ($query as $qk => $qv): if ($qv === '' || $qv === null) continue; ?>
                  <input type="hidden" name="<?= h($qk) ?>" value="<?= h((string) $qv) ?>" />
                <?php endforeach; ?>
                <button type="submit" class="btn btn--sm" aria-label="Requeue delivery #<?= $fid ?>"
                        data-confirm="Send delivery #<?= $fid ?> again? Its attempts start from zero and the worker sends it on its next run." data-confirm-label="Requeue"><?= adminIcon('refresh') ?> Requeue</button>
              </form>
            <?php elseif ((int) $f['has_secret'] === 1): ?>
              <span class="cell-sub">One-time code or link; cannot be re-sent</span>
            <?php endif; ?>
          </td>
        </tr>
        <?php endforeach; ?>
      </tbody>
    </table>
  </div>
  <?= adminPagination($failed['page'], $failed['pages'], $query, $failed['total'], 20) ?>
  <?php else: ?>
    <div class="card__body"><?= adminEmpty('check-circle', 'No failed deliveries in this range', $status !== '' && !in_array($status, ['failed', 'rejected', 'dead'], true) ? 'The status filter excludes failures.' : 'Every message in this filter was sent, is on its way, or was skipped on purpose.', '', true) ?></div>
  <?php endif; ?>
</section>

<?php adminFooter(); ?>
