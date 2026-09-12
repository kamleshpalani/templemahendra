<?php
// backend/admin/contact_messages.php — Inbox for enquiries from the public contact
// form: search, date filter, call / WhatsApp, delete (single + bulk), CSV export.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db      = getDB();
$perPage = 20;

/** Digits-only number for wa.me (Indian 10-digit numbers get the 91 prefix). */
function messagesWaNumber(string $phone): string
{
    $d = preg_replace('/\D+/', '', $phone) ?? '';
    if (strlen($d) === 11 && $d[0] === '0') $d = substr($d, 1);
    if (strlen($d) === 10) $d = '91' . $d;
    return $d;
}

// ── Filters (GET, whitelisted) ───────────────────────────────────────────────
$str       = static fn(string $k): string => is_string($_GET[$k] ?? null) ? trim($_GET[$k]) : '';
$validDate = static function (string $s): string {
    return preg_match('/^\d{4}-\d{2}-\d{2}$/', $s) && checkdate((int) substr($s, 5, 2), (int) substr($s, 8, 2), (int) substr($s, 0, 4)) ? $s : '';
};

$q       = $str('q');
$fromRaw = $str('from');
$toRaw   = $str('to');
$from    = $validDate($fromRaw);
$to      = $validDate($toRaw);
$badFrom = $fromRaw !== '' && $from === '';
$badTo   = $toRaw !== '' && $to === '';
if ($from !== '' && $to !== '' && $to < $from) [$from, $to] = [$to, $from];
$sort    = 'created_at'; // only sortable column
$dir     = $str('dir') === 'asc' ? 'asc' : 'desc';
$page    = max(1, (int) $str('page'));

$query      = ['q' => $q, 'from' => $from, 'to' => $to, 'sort' => $sort, 'dir' => $dir];
$hasFilters = $q !== '' || $from !== '' || $to !== '';
$selfUrl    = '/admin/contact_messages.php' . adminQuery($query, ['page' => $page > 1 ? $page : null]);

$where  = [];
$params = [];
if ($q !== '') {
    $like = '%' . addcslashes($q, '%_\\') . '%';
    $where[] = '(name LIKE :q_name OR phone LIKE :q_phone OR message LIKE :q_msg)';
    $params[':q_name'] = $like;
    $params[':q_phone'] = $like;
    $params[':q_msg'] = $like;
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

// ── POST actions (delete / bulk_delete) → flash + redirect ──────────────────
$msg = adminCsrfGuard();
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $msg === '') {
    $action = is_string($_POST['action'] ?? null) ? $_POST['action'] : '';

    if ($action === 'delete') {
        $id = is_scalar($_POST['id'] ?? null) ? (int) $_POST['id'] : 0;
        if ($id > 0) {
            $stmt = $db->prepare('DELETE FROM contact_messages WHERE id = :id');
            $stmt->execute([':id' => $id]);
            $_SESSION['flash_contact_messages'] = $stmt->rowCount()
                ? ['success', 'Message deleted.']
                : ['warning', 'That message was already deleted.'];
        } else {
            $_SESSION['flash_contact_messages'] = ['error', 'Invalid message id.'];
        }
        header('Location: ' . $selfUrl);
        exit;
    }

    if ($action === 'bulk_delete') {
        $ids = [];
        foreach ((array) ($_POST['ids'] ?? []) as $v) {
            if (is_scalar($v) && (int) $v > 0) $ids[(int) $v] = (int) $v;
        }
        $ids = array_values($ids);
        if ($ids) {
            $stmt = $db->prepare('DELETE FROM contact_messages WHERE id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')');
            $stmt->execute($ids);
            $n = $stmt->rowCount();
            $_SESSION['flash_contact_messages'] = ['success', $n . ' message' . ($n === 1 ? '' : 's') . ' deleted.'];
        } else {
            $_SESSION['flash_contact_messages'] = ['warning', 'Select at least one message to delete.'];
        }
        header('Location: ' . $selfUrl);
        exit;
    }

    $msg = '<p class="alert alert--error" role="alert">Unknown action.</p>';
}

// ── CSV export — respects the active filters and sort ───────────────────────
if ($str('export') === 'csv') {
    $stmt = $db->prepare('SELECT id, name, phone, message, created_at FROM contact_messages' . $whereSql . $orderSql);
    $stmt->execute($params);
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="contact-messages-' . date('Y-m-d') . '.csv"');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF"); // BOM so Excel reads Tamil correctly
    fputcsv($out, ['id', 'name', 'phone', 'message', 'created_at'], ',', '"', '\\');
    while ($r = $stmt->fetch()) {
        fputcsv($out, [$r['id'], $r['name'], $r['phone'], $r['message'], $r['created_at']], ',', '"', '\\');
    }
    fclose($out);
    exit;
}

// ── Data ─────────────────────────────────────────────────────────────────────
$totalAll = (int) $db->query('SELECT COUNT(*) FROM contact_messages')->fetchColumn();
$week     = (int) $db->query('SELECT COUNT(*) FROM contact_messages WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)')->fetchColumn();
$result   = adminPaginate($db, 'SELECT id, name, phone, message, created_at FROM contact_messages' . $whereSql . $orderSql, $params, $page, $perPage);
$rows     = $result['rows'];

// Flash from a previous redirect
$flash = $_SESSION['flash_contact_messages'] ?? null;
unset($_SESSION['flash_contact_messages']);
if (is_array($flash) && count($flash) === 2) {
    [$tone, $text] = $flash;
    $tone = in_array($tone, ['success', 'error', 'warning', 'info'], true) ? $tone : 'info';
    $msg .= '<p class="alert alert--' . $tone . '" role="' . ($tone === 'error' ? 'alert' : 'status') . '">' . h((string) $text) . '</p>';
}
if ($badFrom || $badTo) {
    $msg .= '<p class="alert alert--warning" role="status">The date filter was ignored because it was not a valid date (use YYYY-MM-DD).</p>';
}

$exportHref = 'contact_messages.php' . adminQuery($query, ['export' => 'csv', 'page' => null]);

// Quick date ranges (chips)
$today  = date('Y-m-d');
$ranges = [
    'All time'    => ['from' => '', 'to' => ''],
    'Today'       => ['from' => $today, 'to' => $today],
    'Last 7 days' => ['from' => date('Y-m-d', strtotime('-6 days')), 'to' => $today],
    'This month'  => ['from' => date('Y-m-01'), 'to' => $today],
];

// ── Page ─────────────────────────────────────────────────────────────────────
adminHeader('Contact Messages', 'Devotees', [
    'actions' => '<a href="/contact" target="_blank" rel="noopener" class="btn btn--sm">' . adminIcon('external') . 'Contact page</a>',
]);
echo $msg;
echo adminPageIntro(
    'Enquiries sent through the public contact form — ' . $totalAll . ' message' . ($totalAll === 1 ? '' : 's') . ' in total, ' . $week . ' in the last 7 days. Call or WhatsApp a devotee from the row menu, delete what has been handled, or export the inbox as CSV.',
    '<a href="' . h($exportHref) . '" class="btn btn-primary btn--sm">' . adminIcon('download') . ($hasFilters ? 'Export filtered CSV' : 'Export CSV') . '</a>'
);
?>

<form method="GET" action="contact_messages.php" class="toolbar" role="search" aria-label="Filter messages">
  <input type="hidden" name="dir" value="<?= h($dir) ?>" />
  <div class="toolbar__search">
    <?= adminIcon('search') ?>
    <label class="sr-only" for="f-q">Search messages</label>
    <input id="f-q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search name, phone or message…" autocomplete="off" />
  </div>
  <div class="toolbar__group">
    <label for="f-from">From
      <input id="f-from" type="date" name="from" value="<?= h($from) ?>"<?= $badFrom ? ' aria-invalid="true"' : '' ?> />
    </label>
    <label for="f-to">To
      <input id="f-to" type="date" name="to" value="<?= h($to) ?>"<?= $badTo ? ' aria-invalid="true"' : '' ?> />
    </label>
    <button type="submit" class="btn btn--sm"><?= adminIcon('filter') ?> Apply</button>
    <?php if ($hasFilters): ?>
      <a href="contact_messages.php" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Reset</a>
    <?php endif; ?>
  </div>
  <span class="toolbar__count"><?= $result['total'] ?> message<?= $result['total'] === 1 ? '' : 's' ?></span>
</form>

<nav class="filter-chips mb-4" aria-label="Quick date ranges">
  <?php foreach ($ranges as $label => $r): $current = $from === $r['from'] && $to === $r['to']; ?>
    <a class="chip" href="<?= h('contact_messages.php' . adminQuery($query, ['from' => $r['from'], 'to' => $r['to'], 'page' => null])) ?>"<?= $current ? ' aria-current="page"' : '' ?>><?= h($label) ?></a>
  <?php endforeach; ?>
</nav>

<?php if ($rows): ?>
<div class="table-wrap">
  <table class="table" data-bulk="bulk-form" data-no-search>
    <thead>
      <tr>
        <th scope="col" class="cell-select"><input type="checkbox" data-select-all aria-label="Select all messages on this page" /></th>
        <th scope="col">Devotee</th>
        <th scope="col">Message</th>
        <?= adminSortLink('created_at', 'Received', $query) ?>
        <th scope="col"><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      <?php foreach ($rows as $row):
        $id    = (int) $row['id'];
        $tel   = preg_replace('/[^\d+]/', '', (string) $row['phone']) ?? '';
        $wa    = messagesWaNumber((string) $row['phone']);
        $greet = 'வணக்கம் ' . $row['name'] . ', உங்கள் செய்திக்கு நன்றி. This is Dhabbalavaar Renuka Devi Temple replying to your enquiry on our website — how can we help?';
        $menu  = [];
        if ($tel !== '') $menu[] = ['label' => 'Call', 'href' => 'tel:' . $tel, 'icon' => 'phone'];
        if ($wa !== '')  $menu[] = ['label' => 'WhatsApp', 'href' => 'https://wa.me/' . $wa . '?text=' . rawurlencode($greet), 'icon' => 'external'];
        if ($menu) $menu[] = 'divider';
        $menu[] = ['label' => 'Delete', 'form' => ['action' => 'delete', 'id' => $id], 'icon' => 'trash', 'danger' => true, 'confirm' => 'Delete this message?', 'confirmLabel' => 'Delete'];
      ?>
      <tr>
        <td class="cell-select"><input type="checkbox" name="ids[]" value="<?= $id ?>" aria-label="Select message from <?= h($row['name']) ?>" /></td>
        <td>
          <span class="cell-title"><?= h($row['name']) ?></span>
          <?php if ($tel !== ''): ?><a class="cell-sub" href="tel:<?= h($tel) ?>"><?= h($row['phone']) ?></a><?php else: ?><span class="cell-sub"><?= h($row['phone']) ?></span><?php endif; ?>
        </td>
        <td><?= nl2br(h($row['message'])) ?></td>
        <td class="cell-date">
          <time datetime="<?= h($row['created_at']) ?>"><?= adminFmtDate($row['created_at'], true) ?></time>
          <span class="cell-sub"><?= h(adminAgo($row['created_at'])) ?></span>
        </td>
        <td class="cell-actions"><?= adminMenu($menu, 'Actions for message from ' . $row['name']) ?></td>
      </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
</div>

<form method="POST" action="<?= h($selfUrl) ?>" id="bulk-form" class="bulk-bar" hidden aria-label="Bulk actions">
  <?= csrfField() ?>
  <input type="hidden" name="action" value="bulk_delete" />
  <span class="bulk-bar__count" aria-live="polite">0 selected</span>
  <button type="submit" class="btn btn-danger btn--sm" data-confirm="Delete the selected messages? This cannot be undone." data-confirm-label="Delete"><?= adminIcon('trash') ?> Delete selected</button>
  <button type="button" class="btn btn-ghost btn--sm" data-bulk-clear><?= adminIcon('x') ?> Clear selection</button>
</form>

<?= adminPagination($result['page'], $result['pages'], $query, $result['total'], $perPage) ?>
<?php elseif ($hasFilters): ?>
  <?= adminEmpty('search', 'No messages match these filters', 'Try a wider date range or clear the search.', '<a href="contact_messages.php" class="btn btn-primary btn--sm">' . adminIcon('x') . 'Clear filters</a>') ?>
<?php else: ?>
  <?= adminEmpty('mail', 'No messages yet', 'Enquiries submitted through the contact form on the public website will appear here.', '<a href="/contact" target="_blank" rel="noopener" class="btn btn-primary btn--sm">' . adminIcon('external') . 'View the contact page</a>') ?>
<?php endif; ?>

<?php adminFooter(); ?>
