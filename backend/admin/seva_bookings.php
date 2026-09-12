<?php
// backend/admin/seva_bookings.php — Seva bookings work queue: filter, sort,
// paginate, quick/bulk status changes, reach devotees, CSV export.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

const SB_BASE     = '/admin/seva_bookings.php';
const SB_PER_PAGE = 25;
$statuses = ['pending', 'confirmed', 'completed', 'cancelled'];

/** Same-origin referer (this page only) so redirects land back on the filtered list. */
function sbBackUrl(): string
{
    $ref = (string) ($_SERVER['HTTP_REFERER'] ?? '');
    if ($ref === '') return SB_BASE;
    $p = parse_url($ref);
    if (!$p || empty($p['host'])) return SB_BASE;
    $host = $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
    if (strcasecmp($host, (string) ($_SERVER['HTTP_HOST'] ?? '')) !== 0) return SB_BASE;
    if (($p['path'] ?? '') !== SB_BASE) return SB_BASE;
    return SB_BASE . (!empty($p['query']) ? '?' . $p['query'] : '');
}

/** Digits only, normalised to an Indian international number when it is a 10-digit local one. */
function sbIntlDigits(string $phone): string
{
    $d = preg_replace('/\D+/', '', $phone) ?? '';
    if (strlen($d) === 11 && $d[0] === '0') $d = substr($d, 1);
    if (strlen($d) === 10) $d = '91' . $d;
    return $d;
}

function sbFlash(string $type, string $text): void
{
    $_SESSION['flash_seva_bookings'] = [$type, $text];
}

// ── POST actions ────────────────────────────────────────────────────────────
$msg = adminCsrfGuard();

if ($_SERVER['REQUEST_METHOD'] === 'POST' && $msg === '') {
    $action = (string) ($_POST['action'] ?? '');

    if ($action === 'bulk_status') {
        $newStatus = (string) ($_POST['status'] ?? '');
        $ids = array_values(array_unique(array_filter(array_map('intval', (array) ($_POST['ids'] ?? [])), fn($i) => $i > 0)));
        if (!in_array($newStatus, $statuses, true)) {
            sbFlash('error', 'Choose a valid status to apply.');
        } elseif (!$ids) {
            sbFlash('error', 'Select at least one booking first.');
        } else {
            $marks = implode(',', array_fill(0, count($ids), '?'));
            $stmt  = $db->prepare("UPDATE seva_bookings SET status = ? WHERE id IN ($marks)");
            $stmt->execute(array_merge([$newStatus], $ids));
            $n = count($ids);
            sbFlash('success', "Updated $n booking" . ($n === 1 ? '' : 's') . ' to ' . ucfirst($newStatus) . '.');
        }
        header('Location: ' . sbBackUrl());
        exit;
    }

    // Single status change (inline select or row menu)
    if (isset($_POST['id'], $_POST['status'])) {
        $newStatus = in_array($_POST['status'], $statuses, true) ? $_POST['status'] : 'pending';
        $id        = (int) $_POST['id'];
        $stmt = $db->prepare('UPDATE seva_bookings SET status = :s WHERE id = :id');
        $stmt->execute([':s' => $newStatus, ':id' => $id]);
        $name = $db->prepare('SELECT devotee_name FROM seva_bookings WHERE id = :id');
        $name->execute([':id' => $id]);
        $who = (string) $name->fetchColumn();
        sbFlash('success', $who !== ''
            ? "Booking #$id for $who marked " . ucfirst($newStatus) . '.'
            : "Booking #$id not found.");
        header('Location: ' . sbBackUrl());
        exit;
    }
}

// Flash from the previous request
if ($msg === '' && !empty($_SESSION['flash_seva_bookings'])) {
    [$fType, $fText] = $_SESSION['flash_seva_bookings'];
    $msg = '<p class="alert alert--' . h($fType === 'error' ? 'error' : 'success') . '" role="' . ($fType === 'error' ? 'alert' : 'status') . '">' . h($fText) . '</p>';
}
unset($_SESSION['flash_seva_bookings']);

// ── Filters (GET) ───────────────────────────────────────────────────────────
$q      = trim(mb_substr((string) ($_GET['q'] ?? ''), 0, 120));
$status = in_array($_GET['status'] ?? '', $statuses, true) ? (string) $_GET['status'] : '';
$isDate = static function (string $d): bool {
    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $d, $m)) return false;
    return checkdate((int) $m[2], (int) $m[3], (int) $m[1]);
};
$from = (string) ($_GET['from'] ?? '');
$to   = (string) ($_GET['to'] ?? '');
if (!$isDate($from)) $from = '';
if (!$isDate($to))   $to   = '';
if ($from !== '' && $to !== '' && $from > $to) [$from, $to] = [$to, $from];

$sortable = ['created_at', 'preferred_date', 'devotee_name', 'seva_name', 'status'];
$sort = in_array($_GET['sort'] ?? '', $sortable, true) ? (string) $_GET['sort'] : 'created_at';
$dirParam = (string) ($_GET['dir'] ?? '');
$dir  = in_array($dirParam, ['asc', 'desc'], true) ? $dirParam : ($sort === 'created_at' ? 'desc' : 'asc');
$page = max(1, (int) ($_GET['page'] ?? 1));

$where  = [];
$params = [];
if ($q !== '') {
    $like = '%' . addcslashes($q, '%_\\') . '%';
    $where[] = '(devotee_name LIKE :q1 OR phone LIKE :q2 OR seva_name LIKE :q3)';
    $params += [':q1' => $like, ':q2' => $like, ':q3' => $like];
}
if ($from !== '') {
    $where[] = 'created_at >= :from';
    $params[':from'] = $from . ' 00:00:00';
}
if ($to !== '') {
    $where[] = 'created_at < :to';
    $params[':to'] = (new DateTime($to))->modify('+1 day')->format('Y-m-d') . ' 00:00:00';
}
$baseWhere  = $where;   // without status → chip counts
$baseParams = $params;
if ($status !== '') {
    $where[] = 'status = :status';
    $params[':status'] = $status;
}
$whereSql = $where ? ' WHERE ' . implode(' AND ', $where) : '';
$sql      = 'SELECT * FROM seva_bookings' . $whereSql . " ORDER BY $sort " . strtoupper($dir) . ', id DESC';

$filtersActive = $q !== '' || $from !== '' || $to !== '' || $status !== '';
$isDefaultSort = $sort === 'created_at' && $dir === 'desc';
// $query feeds adminSortLink/adminPagination (needs sort+dir); $linkQuery keeps chip/export URLs free of the defaults.
$query     = ['q' => $q, 'from' => $from, 'to' => $to, 'status' => $status, 'sort' => $sort, 'dir' => $dir, 'page' => $page > 1 ? $page : null];
$linkQuery = $isDefaultSort ? array_merge($query, ['sort' => null, 'dir' => null]) : $query;

// ── CSV export (respects current filters) ───────────────────────────────────
if (($_GET['export'] ?? '') === 'csv') {
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    header('Content-Type: text/csv; charset=UTF-8');
    header('Content-Disposition: attachment; filename="seva-bookings-' . date('Y-m-d') . '.csv"');
    header('Cache-Control: no-store');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF");
    fputcsv($out, ['id', 'devotee_name', 'phone', 'seva_id', 'seva_name', 'preferred_date', 'message', 'status', 'created_at']);
    while ($r = $stmt->fetch()) {
        fputcsv($out, [$r['id'], $r['devotee_name'], $r['phone'], $r['seva_id'], $r['seva_name'], $r['preferred_date'], $r['message'], $r['status'], $r['created_at']]);
    }
    fclose($out);
    exit;
}

// ── Data ────────────────────────────────────────────────────────────────────
$counts = array_fill_keys($statuses, 0);
foreach ($db->query('SELECT status, COUNT(*) c FROM seva_bookings GROUP BY status')->fetchAll() as $r) {
    $counts[$r['status']] = (int) $r['c'];
}

$chipCounts = array_fill_keys($statuses, 0);
$stmt = $db->prepare('SELECT status, COUNT(*) c FROM seva_bookings' . ($baseWhere ? ' WHERE ' . implode(' AND ', $baseWhere) : '') . ' GROUP BY status');
$stmt->execute($baseParams);
foreach ($stmt->fetchAll() as $r) $chipCounts[$r['status']] = (int) $r['c'];
$chipCounts[''] = array_sum($chipCounts);

$list  = adminPaginate($db, $sql, $params, $page, SB_PER_PAGE);
$rows  = $list['rows'];
$total = $list['total'];
$page  = $list['page'];
$query['page'] = $linkQuery['page'] = $page > 1 ? $page : null;

// ── Render ──────────────────────────────────────────────────────────────────
$topActions = '<a href="/admin/sevas.php" class="btn btn-ghost btn--sm">' . adminIcon('sparkles') . 'Manage sevas</a>';
adminHeader('Seva Bookings', 'Devotees', ['actions' => $topActions]);
echo $msg;

$introActions = '';
if ($counts['pending'] > 0 && $status !== 'pending') {
    $introActions .= '<a href="?status=pending" class="btn btn-primary btn--sm">' . adminIcon('clock') . 'Review ' . $counts['pending'] . ' pending</a>';
}
$introActions .= '<a href="' . h(adminQuery($linkQuery, ['export' => 'csv', 'page' => null])) . '" class="btn btn--sm">' . adminIcon('download') . 'Export CSV</a>';
echo adminPageIntro(
    'Online seva requests from devotees — confirm, complete or cancel them singly or in bulk, reach the devotee by phone or WhatsApp, and export the filtered list as CSV.',
    $introActions
);

echo adminKpi([
    ['label' => 'Pending',   'value' => $counts['pending'],   'icon' => 'clock',        'href' => '?status=pending',   'variant' => 'accent', 'sub' => 'Awaiting confirmation'],
    ['label' => 'Confirmed', 'value' => $counts['confirmed'], 'icon' => 'check',        'href' => '?status=confirmed', 'sub' => 'Scheduled with the temple'],
    ['label' => 'Completed', 'value' => $counts['completed'], 'icon' => 'check-circle', 'href' => '?status=completed', 'sub' => 'Sevas performed'],
    ['label' => 'Cancelled', 'value' => $counts['cancelled'], 'icon' => 'x',            'href' => '?status=cancelled', 'sub' => 'Withdrawn requests'],
]);
?>

<nav class="filter-chips" aria-label="Filter by status">
  <?php foreach (array_merge([''], $statuses) as $s): $active = $status === $s; ?>
    <a href="<?= h(adminQuery($linkQuery, ['status' => $s, 'page' => null])) ?>" class="chip"<?= $active ? ' aria-current="page"' : '' ?>>
      <?= $s === '' ? 'All' : ucfirst($s) ?><span class="chip__count"><?= $chipCounts[$s] ?></span>
    </a>
  <?php endforeach; ?>
</nav>

<form method="GET" action="<?= SB_BASE ?>" class="toolbar mt-4" role="search" aria-label="Search and filter bookings">
  <?php if ($status !== ''): ?><input type="hidden" name="status" value="<?= h($status) ?>" /><?php endif; ?>
  <?php if (!$isDefaultSort): ?>
    <input type="hidden" name="sort" value="<?= h($sort) ?>" />
    <input type="hidden" name="dir" value="<?= h($dir) ?>" />
  <?php endif; ?>
  <div class="toolbar__search">
    <?= adminIcon('search') ?>
    <label class="sr-only" for="q">Search bookings</label>
    <input type="search" id="q" name="q" value="<?= h($q) ?>" placeholder="Search devotee, phone or seva…" autocomplete="off" />
  </div>
  <div class="toolbar__group">
    <label for="from">From <input type="date" id="from" name="from" value="<?= h($from) ?>" /></label>
    <label for="to">To <input type="date" id="to" name="to" value="<?= h($to) ?>" /></label>
    <button type="submit" class="btn btn--sm"><?= adminIcon('filter') ?> Filter</button>
    <?php if ($filtersActive): ?>
      <a href="<?= SB_BASE ?>" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Clear</a>
    <?php endif; ?>
  </div>
  <span class="toolbar__count" aria-live="polite"><?= $total ?> record<?= $total === 1 ? '' : 's' ?></span>
</form>

<?php if (!$rows): ?>
  <?php if ($filtersActive): ?>
    <?= adminEmpty('clipboard', 'No bookings match these filters', 'Try a different search term, date range or status.', '<a href="' . SB_BASE . '" class="btn btn-primary btn--sm">' . adminIcon('x') . 'Clear filters</a>') ?>
  <?php else: ?>
    <?= adminEmpty('clipboard', 'No bookings yet', 'Seva requests submitted from the public Sevas page will queue up here for you to confirm.', '<a href="/sevas" target="_blank" rel="noopener" class="btn btn--sm">' . adminIcon('external') . 'View public Sevas page</a><a href="/admin/sevas.php" class="btn btn-ghost btn--sm">' . adminIcon('sparkles') . 'Manage sevas</a>') ?>
  <?php endif; ?>
<?php else: ?>

<div class="table-wrap">
  <table class="table" data-bulk="bulk-form" data-no-search>
    <thead>
      <tr>
        <th scope="col" class="cell-select"><input type="checkbox" data-select-all aria-label="Select all" /></th>
        <?= adminSortLink('devotee_name', 'Devotee', $query) ?>
        <?= adminSortLink('seva_name', 'Seva', $query) ?>
        <?= adminSortLink('preferred_date', 'Preferred date', $query) ?>
        <th scope="col">Note</th>
        <?= adminSortLink('created_at', 'Received', $query) ?>
        <?= adminSortLink('status', 'Status', $query) ?>
        <th scope="col">Set status</th>
        <th scope="col"><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      <?php foreach ($rows as $row):
        $id     = (int) $row['id'];
        $intl   = sbIntlDigits((string) $row['phone']);
        $tel    = 'tel:' . (strlen($intl) === 12 ? '+' . $intl : preg_replace('/\D+/', '', (string) $row['phone']));
        $wa     = 'https://wa.me/' . $intl;
        $menu   = [
            ['label' => 'Call devotee', 'href' => $tel, 'icon' => 'phone'],
            ['label' => 'WhatsApp',     'href' => $wa,  'icon' => 'external'],
            'divider',
        ];
        foreach ($statuses as $s) {
            if ($s === $row['status']) continue;
            $item = ['label' => 'Mark ' . $s, 'form' => ['action' => 'set_status', 'id' => $id, 'status' => $s], 'icon' => ['pending' => 'clock', 'confirmed' => 'check', 'completed' => 'check-circle', 'cancelled' => 'x'][$s]];
            if ($s === 'cancelled') {
                $item['danger']       = true;
                $item['confirm']      = 'Cancel the ' . $row['seva_name'] . ' booking for ' . $row['devotee_name'] . '?';
                $item['confirmLabel'] = 'Cancel booking';
            }
            $menu[] = $item;
        }
      ?>
      <tr>
        <td class="cell-select"><input type="checkbox" name="ids[]" value="<?= $id ?>" aria-label="Select booking #<?= $id ?> — <?= h($row['devotee_name']) ?>" /></td>
        <td>
          <span class="cell-title"><?= h($row['devotee_name']) ?></span>
          <a class="cell-sub" href="<?= h($tel) ?>"><?= h($row['phone']) ?></a>
        </td>
        <td><?= h($row['seva_name']) ?></td>
        <td class="cell-date"><?= adminFmtDate($row['preferred_date']) ?></td>
        <td>
          <?php if (trim((string) $row['message']) !== ''): ?>
            <span class="cell-clip" title="<?= h($row['message']) ?>"><?= h($row['message']) ?></span>
          <?php else: ?>
            <span class="cell-muted">—</span>
          <?php endif; ?>
        </td>
        <td class="cell-date"><time datetime="<?= h(str_replace(' ', 'T', (string) $row['created_at'])) ?>"><?= adminFmtDate($row['created_at'], true) ?></time></td>
        <td><?= adminBadge(ucfirst($row['status']), adminStatusTone($row['status'])) ?></td>
        <td>
          <form method="POST" action="<?= SB_BASE ?>">
            <?= csrfField() ?>
            <input type="hidden" name="id" value="<?= $id ?>" />
            <label class="sr-only" for="st-<?= $id ?>">Change status for <?= h($row['devotee_name']) ?></label>
            <select id="st-<?= $id ?>" class="inline-status" name="status" data-autosubmit>
              <?php foreach ($statuses as $s): ?>
                <option value="<?= $s ?>"<?= $row['status'] === $s ? ' selected' : '' ?>><?= ucfirst($s) ?></option>
              <?php endforeach; ?>
            </select>
            <noscript><button type="submit" class="btn btn--xs">Save</button></noscript>
          </form>
        </td>
        <td class="cell-actions"><?= adminMenu($menu, 'Actions for booking #' . $id) ?></td>
      </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
</div>

<form method="POST" action="<?= SB_BASE ?>" id="bulk-form" class="bulk-bar" hidden>
  <?= csrfField() ?>
  <input type="hidden" name="action" value="bulk_status" />
  <span class="bulk-bar__count"></span>
  <label class="sr-only" for="bulk-status">Status to apply</label>
  <select name="status" id="bulk-status">
    <?php foreach ($statuses as $s): ?>
      <option value="<?= $s ?>"><?= ucfirst($s) ?></option>
    <?php endforeach; ?>
  </select>
  <button type="submit" class="btn btn-gold btn--sm" data-confirm="Change status for the selected bookings?" data-confirm-label="Apply"><?= adminIcon('check') ?> Apply</button>
  <button type="button" class="btn btn-ghost btn--sm" data-bulk-clear><?= adminIcon('x') ?> Clear</button>
</form>

<?= adminPagination($page, $list['pages'], $query, $total, SB_PER_PAGE) ?>

<?php endif; ?>

<?php adminFooter(); ?>
