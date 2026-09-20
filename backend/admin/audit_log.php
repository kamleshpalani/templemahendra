<?php
// backend/admin/audit_log.php — Read-only Audit Logs (brief §28): every row
// adminAudit() / liveAudit() wrote to admin_activity, filterable by who, what
// (module), which record, and when, with CSV export. Gated by `audit.view`
// (admin + owner) in adminPageCapability(); the page has no write path.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db      = getDB();
$perPage = 50;

/**
 * Module = the part of an action name before its verb. Login/session rows
 * carry no underscore prefix, so they are grouped as "Sign-in" explicitly.
 */
const AUDIT_MODULES = [
    'signin'       => ['label' => 'Sign-in & sessions', 'like' => null,
                       'in' => ['login', 'login_failed', 'logout', 'session_expired', 'session_revoked', 'account_locked', 'password_change', 'profile_update']],
    'user'         => ['label' => 'Committee accounts',  'like' => 'user_%'],
    'settings'     => ['label' => 'Settings',            'like' => 'settings_%'],
    'announcement' => ['label' => 'Announcements',       'like' => 'announcement_%'],
    'widget'       => ['label' => 'Homepage widgets',    'like' => 'widget_%'],
    'deity'        => ['label' => 'Deities',             'like' => 'deity_%'],
    'pooja'        => ['label' => 'Poojas',              'like' => 'pooja_%'],
    'seva'         => ['label' => 'Sevas',               'like' => 'seva_%'],
    'event'        => ['label' => 'Events',              'like' => 'event_%'],
    'calendar'     => ['label' => 'Temple calendar',     'like' => 'calendar_%'],
    'sponsor'      => ['label' => 'Sponsors',            'like' => 'sponsor_%'],
    'donation'     => ['label' => 'Donations',           'like' => 'donation_%'],
    'payment'      => ['label' => 'Online payments',     'like' => 'payment_%'],
    'booking'      => ['label' => 'Seva bookings',       'like' => 'booking_%'],
    'message'      => ['label' => 'Contact messages',    'like' => 'message_%'],
    'gallery'      => ['label' => 'Gallery',             'like' => 'gallery_%'],
    'video'        => ['label' => 'Videos',              'like' => 'video_%'],
    'live'         => ['label' => 'Live streaming',      'like' => 'live_%'],
    'notification' => ['label' => 'Notifications',       'like' => 'notification_%'],
    'devotee'      => ['label' => 'Devotees',            'like' => 'devotee_%'],
];

/** Tone for the action badge, from the verb at the end of the action name. */
function auditTone(string $action): string
{
    if (in_array($action, ['login_failed', 'account_locked', 'session_revoked'], true)) return 'danger';
    if (in_array($action, ['login', 'logout', 'session_expired'], true)) return 'muted';
    if (str_ends_with($action, '_deleted') || str_ends_with($action, '_delete') || str_ends_with($action, '_bulk') || str_contains($action, 'refund')) return 'danger';
    if (str_ends_with($action, '_created') || str_ends_with($action, '_create') || str_ends_with($action, '_uploaded')) return 'success';
    if (str_ends_with($action, '_toggled') || str_ends_with($action, '_hidden') || str_ends_with($action, '_disable')) return 'warning';
    return 'info';
}

/** "video_category_updated" → "Video category updated". */
function auditLabel(string $action): string
{
    return ucfirst(str_replace('_', ' ', $action));
}

// ── Filters (GET, whitelisted) ───────────────────────────────────────────────
$str       = static fn(string $k): string => is_string($_GET[$k] ?? null) ? trim($_GET[$k]) : '';
$validDate = static function (string $s): string {
    return preg_match('/^\d{4}-\d{2}-\d{2}$/', $s) && checkdate((int) substr($s, 5, 2), (int) substr($s, 8, 2), (int) substr($s, 0, 4)) ? $s : '';
};

$q        = mb_substr($str('q'), 0, 190);
$actor    = mb_substr($str('actor'), 0, 60);
$module   = isset(AUDIT_MODULES[$str('module')]) ? $str('module') : '';
$action   = preg_match('/^[a-z0-9_]{1,60}$/', $str('action')) ? $str('action') : '';
$fromRaw  = $str('from');
$toRaw    = $str('to');
$from     = $validDate($fromRaw);
$to       = $validDate($toRaw);
$badFrom  = $fromRaw !== '' && $from === '';
$badTo    = $toRaw !== '' && $to === '';
if ($from !== '' && $to !== '' && $to < $from) [$from, $to] = [$to, $from];
$dir      = $str('dir') === 'asc' ? 'asc' : 'desc';
$page     = max(1, (int) $str('page'));

$query      = ['q' => $q, 'actor' => $actor, 'module' => $module, 'action' => $action, 'from' => $from, 'to' => $to, 'dir' => $dir];
$hasFilters = $q !== '' || $actor !== '' || $module !== '' || $action !== '' || $from !== '' || $to !== '';

$where  = [];
$params = [];
if ($q !== '') {
    $like = '%' . addcslashes($q, '%_\\') . '%';
    $where[] = '(subject LIKE :q_subject OR detail LIKE :q_detail OR ip LIKE :q_ip)';
    $params[':q_subject'] = $like;
    $params[':q_detail']  = $like;
    $params[':q_ip']      = $like;
}
if ($actor !== '') {
    $where[] = 'actor = :actor';
    $params[':actor'] = $actor;
}
if ($action !== '') {
    $where[] = 'action = :action';
    $params[':action'] = $action;
} elseif ($module !== '') {
    $m = AUDIT_MODULES[$module];
    if ($m['like'] !== null) {
        $where[] = 'action LIKE :module_like';
        $params[':module_like'] = $m['like'];
    } else {
        $marks = [];
        foreach ($m['in'] as $i => $name) {
            $marks[] = ':m' . $i;
            $params[':m' . $i] = $name;
        }
        $where[] = 'action IN (' . implode(',', $marks) . ')';
    }
}
if ($from !== '') {
    $where[] = 'created_at >= :from_at';
    $params[':from_at'] = $from . ' 00:00:00';
}
if ($to !== '') {
    $where[] = 'created_at <= :to_at';
    $params[':to_at'] = $to . ' 23:59:59';
}
$whereSql = $where ? ' WHERE ' . implode(' AND ', $where) : '';
$orderSql = ' ORDER BY created_at ' . strtoupper($dir) . ', id ' . strtoupper($dir);
$select   = 'SELECT id, actor, action, subject, detail, ip, created_at FROM admin_activity' . $whereSql . $orderSql;

// ── CSV export — respects the active filters and sort ───────────────────────
if ($str('export') === 'csv') {
    adminAudit('audit_exported', 'admin_activity', $hasFilters ? http_build_query(array_filter($query)) : 'all rows');
    $stmt = $db->prepare($select . ' LIMIT 10000');
    $stmt->execute($params);
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="audit-log-' . date('Y-m-d') . '.csv"');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF");
    fputcsv($out, ['id', 'when', 'actor', 'action', 'subject', 'detail', 'ip'], ',', '"', '');
    while ($r = $stmt->fetch()) {
        fputcsv($out, [$r['id'], $r['created_at'], $r['actor'], $r['action'], $r['subject'], $r['detail'], $r['ip']], ',', '"', '');
    }
    fclose($out);
    exit;
}

// ── Data ─────────────────────────────────────────────────────────────────────
$totalAll = (int) $db->query('SELECT COUNT(*) FROM admin_activity')->fetchColumn();
$today    = (int) $db->query('SELECT COUNT(*) FROM admin_activity WHERE created_at >= CURDATE()')->fetchColumn();
$failed7  = (int) $db->query("SELECT COUNT(*) FROM admin_activity WHERE action IN ('login_failed','account_locked') AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)")->fetchColumn();
$actors   = $db->query('SELECT actor, COUNT(*) AS n FROM admin_activity GROUP BY actor ORDER BY n DESC, actor ASC LIMIT 40')->fetchAll();
$result   = adminPaginate($db, $select, $params, $page, $perPage);
$rows     = $result['rows'];

$msg = '';
if ($badFrom || $badTo) {
    $msg .= '<p class="alert alert--warning" role="status">The date filter was ignored because it was not a valid date (use YYYY-MM-DD).</p>';
}

$exportHref = 'audit_log.php' . adminQuery($query, ['export' => 'csv', 'page' => null]);
$todayIso   = date('Y-m-d');
$ranges     = [
    'All time'    => ['from' => '', 'to' => ''],
    'Today'       => ['from' => $todayIso, 'to' => $todayIso],
    'Last 7 days' => ['from' => date('Y-m-d', strtotime('-6 days')), 'to' => $todayIso],
    'This month'  => ['from' => date('Y-m-01'), 'to' => $todayIso],
];

// ── Page ─────────────────────────────────────────────────────────────────────
adminHeader('Audit Logs', 'People');
echo $msg;
echo adminPageIntro(
    'Who changed what, and when. Every sign-in, content change, payment action, sponsor change, account change and live-stream update is recorded here and cannot be edited or deleted from the CMS.',
    '<a href="' . h($exportHref) . '" class="btn btn-primary btn--sm">' . adminIcon('download') . ($hasFilters ? 'Export filtered CSV' : 'Export CSV') . '</a>'
);
echo adminKpi([
    ['label' => 'Entries',              'value' => number_format($totalAll), 'icon' => 'history'],
    ['label' => 'Today',                'value' => number_format($today),    'icon' => 'activity'],
    ['label' => 'Failed sign-ins (7d)', 'value' => number_format($failed7),  'icon' => 'shield', 'tone' => $failed7 > 0 ? 'danger' : 'success'],
]);
?>

<form method="GET" action="audit_log.php" class="toolbar" role="search" aria-label="Filter audit log">
  <input type="hidden" name="dir" value="<?= h($dir) ?>" />
  <div class="toolbar__search">
    <?= adminIcon('search') ?>
    <label class="sr-only" for="f-q">Search record, detail or IP</label>
    <input id="f-q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search record, detail or IP…" autocomplete="off" maxlength="190" />
  </div>
  <div class="toolbar__group">
    <label for="f-actor">Who
      <select id="f-actor" name="actor">
        <option value="">Anyone</option>
        <?php foreach ($actors as $a): ?>
          <option value="<?= h($a['actor']) ?>"<?= $a['actor'] === $actor ? ' selected' : '' ?>><?= h($a['actor']) ?> (<?= (int) $a['n'] ?>)</option>
        <?php endforeach; ?>
        <?php if ($actor !== '' && !in_array($actor, array_column($actors, 'actor'), true)): ?>
          <option value="<?= h($actor) ?>" selected><?= h($actor) ?></option>
        <?php endif; ?>
      </select>
    </label>
    <label for="f-module">What
      <select id="f-module" name="module">
        <option value="">Everything</option>
        <?php foreach (AUDIT_MODULES as $key => $m): ?>
          <option value="<?= h($key) ?>"<?= $key === $module ? ' selected' : '' ?>><?= h($m['label']) ?></option>
        <?php endforeach; ?>
      </select>
    </label>
    <label for="f-from">From
      <input id="f-from" type="date" name="from" value="<?= h($from) ?>"<?= $badFrom ? ' aria-invalid="true"' : '' ?> />
    </label>
    <label for="f-to">To
      <input id="f-to" type="date" name="to" value="<?= h($to) ?>"<?= $badTo ? ' aria-invalid="true"' : '' ?> />
    </label>
    <button type="submit" class="btn btn--sm"><?= adminIcon('filter') ?> Apply</button>
    <?php if ($hasFilters): ?>
      <a href="audit_log.php" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Reset</a>
    <?php endif; ?>
  </div>
  <span class="toolbar__count"><?= $result['total'] ?> entr<?= $result['total'] === 1 ? 'y' : 'ies' ?></span>
</form>

<nav class="filter-chips mb-4" aria-label="Quick date ranges">
  <?php foreach ($ranges as $label => $r): $current = $from === $r['from'] && $to === $r['to']; ?>
    <a class="chip" href="<?= h('audit_log.php' . adminQuery($query, ['from' => $r['from'], 'to' => $r['to'], 'page' => null])) ?>"<?= $current ? ' aria-current="page"' : '' ?>><?= h($label) ?></a>
  <?php endforeach; ?>
  <?php if ($action !== ''): ?>
    <a class="chip" href="<?= h('audit_log.php' . adminQuery($query, ['action' => null, 'page' => null])) ?>" aria-current="page"><?= adminIcon('x', 'ico--xs') ?> <?= h(auditLabel($action)) ?></a>
  <?php endif; ?>
</nav>

<?php if ($rows): ?>
<div class="table-wrap">
  <table class="table" data-no-search>
    <thead>
      <tr>
        <?= adminSortLink('created_at', 'When', array_merge($query, ['sort' => 'created_at'])) ?>
        <th scope="col">Who</th>
        <th scope="col">Action</th>
        <th scope="col">Record</th>
        <th scope="col">Detail</th>
        <th scope="col">IP</th>
      </tr>
    </thead>
    <tbody>
      <?php foreach ($rows as $row): $act = (string) $row['action']; ?>
      <tr>
        <td class="cell-date">
          <time datetime="<?= h($row['created_at']) ?>"><?= adminFmtDate($row['created_at'], true) ?></time>
          <span class="cell-sub"><?= h(adminAgo($row['created_at'])) ?></span>
        </td>
        <td>
          <a class="cell-title" href="<?= h('audit_log.php' . adminQuery($query, ['actor' => $row['actor'], 'page' => null])) ?>" title="Only <?= h($row['actor']) ?>"><?= h($row['actor']) ?></a>
        </td>
        <td>
          <a href="<?= h('audit_log.php' . adminQuery($query, ['action' => $act, 'module' => null, 'page' => null])) ?>" title="Only this action"><?= adminBadge(auditLabel($act), auditTone($act)) ?></a>
        </td>
        <td><?= $row['subject'] !== null && $row['subject'] !== '' ? '<code class="audit-subject">' . h($row['subject']) . '</code>' : '<span class="cell-sub">—</span>' ?></td>
        <td><?= $row['detail'] !== null && $row['detail'] !== '' ? '<span class="cell-clip audit-detail">' . h($row['detail']) . '</span>' : '<span class="cell-sub">—</span>' ?></td>
        <td class="cell-date"><?= h($row['ip'] ?? '—') ?></td>
      </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
</div>

<?= adminPagination($result['page'], $result['pages'], $query, $result['total'], $perPage) ?>
<?php elseif ($hasFilters): ?>
  <?= adminEmpty('search', 'No entries match these filters', 'Try a wider date range, another person, or clear the search.', '<a href="audit_log.php" class="btn btn-primary btn--sm">' . adminIcon('x') . 'Clear filters</a>') ?>
<?php else: ?>
  <?= adminEmpty('history', 'Nothing recorded yet', 'Sign-ins and changes made in the CMS will appear here as they happen.') ?>
<?php endif; ?>

<?php adminFooter(); ?>
