<?php
// backend/admin/donations.php — Donations report: KPIs, filters, sortable list,
// purpose breakdown and a filter-aware CSV export.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db      = getDB();
$perPage = 25;

/** Purpose values used by the public Donations form → admin labels. */
$purposeLabels = [
    'kumbabhishekam' => 'Kumbabhishekam',
    'annadanam_hall' => 'Annadanam Hall construction',
    'annadanam'      => 'Annadanam',
    'abhishekam'     => 'Abhishekam',
    'festival'       => 'Festival Fund',
    'maintenance'    => 'Temple Maintenance',
    'other'          => 'Other',
];
$purposeTones = ['gold', 'maroon', 'moon', 'sage', 'info', 'warning', 'danger'];
$sortCols     = ['created_at' => 'created_at', 'amount' => 'amount', 'name' => 'name'];

/** Digits-only number for wa.me (Indian 10-digit numbers get the 91 prefix). */
function donationsWaNumber(string $phone): string
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
$purpose = $str('purpose');
if (!isset($purposeLabels[$purpose])) $purpose = '';
$fromRaw = $str('from');
$toRaw   = $str('to');
$from    = $validDate($fromRaw);
$to      = $validDate($toRaw);
$badFrom = $fromRaw !== '' && $from === '';
$badTo   = $toRaw !== '' && $to === '';
if ($from !== '' && $to !== '' && $to < $from) [$from, $to] = [$to, $from];
$sort    = isset($sortCols[$str('sort')]) ? $str('sort') : 'created_at';
$dir     = $str('dir') === 'asc' ? 'asc' : 'desc';
$page    = max(1, (int) $str('page'));

$query      = ['q' => $q, 'purpose' => $purpose, 'from' => $from, 'to' => $to, 'sort' => $sort, 'dir' => $dir];
$hasFilters = $q !== '' || $purpose !== '' || $from !== '' || $to !== '';

$where  = [];
$params = [];
if ($q !== '') {
    $like = '%' . addcslashes($q, '%_\\') . '%';
    $where[] = '(name LIKE :q_name OR phone LIKE :q_phone OR message LIKE :q_msg)';
    $params[':q_name'] = $like;
    $params[':q_phone'] = $like;
    $params[':q_msg'] = $like;
}
if ($purpose === 'other') {
    // Blank purposes from the public form are reported as "Other" (matches the dashboard)
    $where[] = "(purpose = 'other' OR purpose IS NULL OR purpose = '')";
} elseif ($purpose !== '') {
    $where[] = 'purpose = :purpose';
    $params[':purpose'] = $purpose;
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
$orderSql = ' ORDER BY ' . $sortCols[$sort] . ' ' . strtoupper($dir) . ', id ' . strtoupper($dir);

// ── CSV export (report) — respects the active filters and sort ──────────────
if ($str('export') === 'csv') {
    $stmt = $db->prepare('SELECT id, name, phone, amount, purpose, message, created_at FROM donations' . $whereSql . $orderSql);
    $stmt->execute($params);
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="donations-' . date('Y-m-d') . '.csv"');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF"); // BOM so Excel reads Tamil correctly
    // Empty escape string = strict RFC 4180 (quotes doubled, no backslash special
    // case) so a message containing \" is not mis-parsed by Excel / pandas.
    fputcsv($out, ['id', 'name', 'phone', 'amount', 'purpose', 'message', 'created_at'], ',', '"', '');
    while ($r = $stmt->fetch()) {
        fputcsv($out, [$r['id'], $r['name'], $r['phone'], $r['amount'], $r['purpose'], $r['message'], $r['created_at']], ',', '"', '');
    }
    fclose($out);
    exit;
}

// ── KPIs (all time) ──────────────────────────────────────────────────────────
$agg = $db->query('SELECT COUNT(*) c, COALESCE(SUM(amount),0) total, COALESCE(AVG(amount),0) avg_amt, COALESCE(MAX(amount),0) max_amt, MIN(created_at) first_at FROM donations')->fetch();
$countAll = (int) $agg['c'];
$totalAll = (float) $agg['total'];
$avgAll   = (float) $agg['avg_amt'];
$maxAll   = (float) $agg['max_amt'];
$monthRow = $db->query("SELECT COUNT(*) c, COALESCE(SUM(amount),0) total FROM donations WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')")->fetch();
$monthSum = (float) $monthRow['total'];
$monthCnt = (int) $monthRow['c'];
$prevSum  = (float) $db->query("SELECT COALESCE(SUM(amount),0) FROM donations WHERE created_at >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01') AND created_at < DATE_FORMAT(CURDATE(), '%Y-%m-01')")->fetchColumn();

$delta = null;
$deltaDown = false;
if ($prevSum > 0) {
    $pct       = ($monthSum - $prevSum) / $prevSum * 100;
    $deltaDown = $pct < 0;
    $delta     = ($pct >= 0 ? '+' : '') . number_format($pct, 0) . '% vs last month';
} elseif ($monthSum > 0) {
    $delta = 'First pledges this month';
}

// ── Filtered list + totals ───────────────────────────────────────────────────
$fstmt = $db->prepare('SELECT COUNT(*) c, COALESCE(SUM(amount),0) total FROM donations' . $whereSql);
$fstmt->execute($params);
$filtered      = $fstmt->fetch();
$filteredCount = (int) $filtered['c'];
$filteredSum   = (float) $filtered['total'];

$result = adminPaginate($db, 'SELECT id, name, phone, amount, purpose, message, created_at FROM donations' . $whereSql . $orderSql, $params, $page, $perPage);
$rows   = $result['rows'];

// Donations by purpose over the same filtered set
$pstmt = $db->prepare("SELECT COALESCE(NULLIF(purpose,''),'other') p, SUM(amount) total, COUNT(*) c FROM donations" . $whereSql . ' GROUP BY p ORDER BY total DESC');
$pstmt->execute($params);
$purposeShares = [];
foreach ($pstmt->fetchAll() as $i => $p) {
    $purposeShares[] = [
        'label' => $purposeLabels[$p['p']] ?? ucfirst((string) $p['p']),
        'value' => (float) $p['total'],
        'hint'  => adminFmtMoney((float) $p['total']) . ' · ' . (int) $p['c'] . ' pledge' . ((int) $p['c'] === 1 ? '' : 's'),
        'tone'  => $purposeTones[$i % count($purposeTones)],
    ];
}

// Quick date ranges (chips)
$today  = date('Y-m-d');
$ranges = [
    'All time'     => ['from' => '', 'to' => ''],
    'Today'        => ['from' => $today, 'to' => $today],
    'This month'   => ['from' => date('Y-m-01'), 'to' => $today],
    'Last 30 days' => ['from' => date('Y-m-d', strtotime('-29 days')), 'to' => $today],
    'This year'    => ['from' => date('Y-01-01'), 'to' => $today],
];

$exportHref = 'donations.php' . adminQuery($query, ['export' => 'csv', 'page' => null]);

// ── Page ─────────────────────────────────────────────────────────────────────
$msg = adminCsrfGuard();
if ($badFrom || $badTo) {
    $msg .= '<p class="alert alert--warning" role="status">The date filter was ignored because it was not a valid date (use YYYY-MM-DD).</p>';
}

adminHeader('Donations', 'Devotees', [
    'actions' => '<a href="/admin/bulk_upload.php?entity=donations" class="btn btn-gold btn--sm">' . adminIcon('upload') . 'Bulk import</a>',
]);
echo $msg;
echo adminPageIntro(
    'Pledges submitted through the public Donations page and bulk imports. Search, filter by purpose or date, sort the columns, and export exactly what you see as CSV.',
    '<a href="' . h($exportHref) . '" class="btn btn-primary btn--sm">' . adminIcon('download') . ($hasFilters ? 'Export filtered CSV' : 'Export CSV') . '</a>'
);

echo adminKpi([
    ['label' => 'Total recorded', 'value' => adminFmtMoney($totalAll), 'icon' => 'banknote', 'variant' => 'accent', 'sub' => $countAll . ' pledge' . ($countAll === 1 ? '' : 's') . ' all time'],
    ['label' => 'This month',     'value' => adminFmtMoney($monthSum), 'icon' => 'trending', 'delta' => $delta, 'deltaDown' => $deltaDown, 'sub' => $monthCnt . ' pledge' . ($monthCnt === 1 ? '' : 's') . ' this month'],
    ['label' => 'Pledges',        'value' => $countAll,                 'icon' => 'clipboard', 'sub' => $agg['first_at'] ? 'Since ' . adminFmtDate($agg['first_at']) : 'None recorded yet'],
    ['label' => 'Average pledge', 'value' => adminFmtMoney($avgAll),   'icon' => 'activity', 'sub' => $maxAll > 0 ? 'Largest ' . adminFmtMoney($maxAll) : 'No pledges yet'],
]);
?>

<form method="GET" action="donations.php" class="toolbar" role="search" aria-label="Filter donations">
  <input type="hidden" name="sort" value="<?= h($sort) ?>" />
  <input type="hidden" name="dir" value="<?= h($dir) ?>" />
  <div class="toolbar__search">
    <?= adminIcon('search') ?>
    <label class="sr-only" for="f-q">Search donations</label>
    <input id="f-q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search name, phone or message…" autocomplete="off" />
  </div>
  <div class="toolbar__group">
    <label for="f-purpose">Purpose
      <select id="f-purpose" name="purpose">
        <option value="">All purposes</option>
        <?php foreach ($purposeLabels as $val => $label): ?>
          <option value="<?= h($val) ?>"<?= $purpose === $val ? ' selected' : '' ?>><?= h($label) ?></option>
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
      <a href="donations.php" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Reset</a>
    <?php endif; ?>
  </div>
  <span class="toolbar__count"><?= $filteredCount ?> record<?= $filteredCount === 1 ? '' : 's' ?> · <?= adminFmtMoney($filteredSum) ?></span>
</form>

<nav class="filter-chips mb-4" aria-label="Quick date ranges">
  <?php foreach ($ranges as $label => $r): $current = $from === $r['from'] && $to === $r['to']; ?>
    <a class="chip" href="<?= h('donations.php' . adminQuery($query, ['from' => $r['from'], 'to' => $r['to'], 'page' => null])) ?>"<?= $current ? ' aria-current="page"' : '' ?>><?= h($label) ?></a>
  <?php endforeach; ?>
</nav>

<?php if ($rows): ?>
<div class="table-wrap">
  <table class="table" data-no-search>
    <thead>
      <tr>
        <th scope="col">#</th>
        <?= adminSortLink('name', 'Devotee', $query) ?>
        <?= adminSortLink('amount', 'Amount', $query) ?>
        <th scope="col">Purpose</th>
        <th scope="col">Message</th>
        <?= adminSortLink('created_at', 'Date', $query) ?>
        <th scope="col"><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      <?php foreach ($rows as $i => $row):
        $n       = ($result['page'] - 1) * $perPage + $i + 1;
        $tel     = preg_replace('/[^\d+]/', '', (string) $row['phone']) ?? '';
        $wa      = donationsWaNumber((string) $row['phone']);
        $pKey    = (string) ($row['purpose'] ?? '');
        $pLabel  = $pKey !== '' ? ($purposeLabels[$pKey] ?? $pKey) : '';
        $message = (string) ($row['message'] ?? '');
        $greet   = 'வணக்கம் ' . $row['name'] . ', நன்றி! Thank you for your donation pledge of ' . adminFmtMoney((float) $row['amount'], 2)
                 . ($pLabel !== '' ? ' towards ' . $pLabel : '') . ' to Dhabbalavaar Renuka Devi Temple.';
        $menu    = [];
        if ($tel !== '') $menu[] = ['label' => 'Call', 'href' => 'tel:' . $tel, 'icon' => 'phone'];
        if ($wa !== '')  $menu[] = ['label' => 'WhatsApp', 'href' => 'https://wa.me/' . $wa . '?text=' . rawurlencode($greet), 'icon' => 'external'];
      ?>
      <tr>
        <td class="cell-muted tabular"><?= $n ?></td>
        <td>
          <span class="cell-title"><?= h($row['name']) ?></span>
          <?php if ($tel !== ''): ?><a class="cell-sub" href="tel:<?= h($tel) ?>"><?= h($row['phone']) ?></a><?php else: ?><span class="cell-sub"><?= h($row['phone']) ?></span><?php endif; ?>
        </td>
        <td class="cell-money"><?= adminFmtMoney((float) $row['amount'], 2) ?></td>
        <td><?= $pLabel !== '' ? adminBadge($pLabel, 'gold') : '<span class="text-muted">—</span>' ?></td>
        <td><?= $message !== '' ? '<span class="cell-clip">' . h($message) . '</span>' : '<span class="text-muted">—</span>' ?></td>
        <td class="cell-date"><time datetime="<?= h($row['created_at']) ?>"><?= adminFmtDate($row['created_at'], true) ?></time></td>
        <td class="cell-actions"><?= $menu ? adminMenu($menu, 'Actions for ' . $row['name']) : '' ?></td>
      </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
</div>
<?= adminPagination($result['page'], $result['pages'], $query, $result['total'], $perPage) ?>
<?php elseif ($hasFilters): ?>
  <?= adminEmpty('search', 'No donations match these filters', 'Try a wider date range, a different purpose, or clear the search.', '<a href="donations.php" class="btn btn-primary btn--sm">' . adminIcon('x') . 'Clear filters</a>') ?>
<?php else: ?>
  <?= adminEmpty('banknote', 'No donations recorded yet', 'Pledges submitted on the public Donations page will appear here. You can also import past donations from a CSV or Excel file.', '<a href="/admin/bulk_upload.php?entity=donations" class="btn btn-primary btn--sm">' . adminIcon('upload') . 'Import past donations</a>') ?>
<?php endif; ?>

<?php if ($purposeShares): ?>
<section class="card card--static mt-6" aria-labelledby="by-purpose-title">
  <div class="card__head">
    <h2 id="by-purpose-title"><?= adminIcon('banknote', 'ico--sm') ?> Donations by purpose</h2>
    <span class="text-xs text-muted"><?= $hasFilters ? 'Filtered set · ' : 'All time · ' ?><?= adminFmtMoney($filteredSum) ?></span>
  </div>
  <div class="card__body">
    <?= adminShares($purposeShares, 'Donations by purpose') ?>
  </div>
</section>
<?php endif; ?>

<?php adminFooter(); ?>
