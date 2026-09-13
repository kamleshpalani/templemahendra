<?php
// backend/admin/donations.php — Donations report: KPIs, filters, sortable list,
// purpose breakdown and a filter-aware CSV export.
//
// "Send receipt" (a row action, editors and owners) sends the donation.receipt
// notification once the committee has the money in hand. Sending it again is a
// deliberate act — a lost email, a corrected address — so each send is its own
// numbered receipt (sequence = receipts already sent + 1) rather than a
// duplicate the dedupe key would swallow.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/devotee_auth.php';
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

/** Same-origin referer on this page only, so a POST lands back on the filtered list. */
function donationsBackUrl(): string
{
    $base = '/admin/donations.php';
    $ref  = (string) ($_SERVER['HTTP_REFERER'] ?? '');
    $p    = $ref !== '' ? parse_url($ref) : false;
    if (!$p || empty($p['host'])) return $base;
    $host = $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
    if (strcasecmp($host, (string) ($_SERVER['HTTP_HOST'] ?? '')) !== 0 || ($p['path'] ?? '') !== $base) return $base;
    return $base . (!empty($p['query']) ? '?' . $p['query'] : '');
}

function donationsFlash(string $type, string $text): void
{
    $_SESSION['flash_donations'] = [$type, $text];
}

/** "email", "email and WhatsApp", "email, WhatsApp and SMS". */
function donationsJoin(array $items): string
{
    if (count($items) <= 1) return (string) ($items[0] ?? '');
    $last = array_pop($items);
    return implode(', ', $items) . ' and ' . $last;
}

/** How many receipts have gone out for each donation id. */
function donationsReceiptCounts(PDO $db, array $ids): array
{
    if (!$ids || !devoteeNotifyReady()) return [];
    $marks = implode(',', array_fill(0, count($ids), '?'));
    $stmt  = $db->prepare(
        "SELECT entity_id, COUNT(*) AS c FROM notifications
          WHERE entity_type = 'donation' AND event = 'donation.receipt' AND entity_id IN ($marks)
          GROUP BY entity_id"
    );
    $stmt->execute(array_values($ids));
    $out = [];
    foreach ($stmt->fetchAll() as $r) $out[(int) $r['entity_id']] = (int) $r['c'];
    return $out;
}

/**
 * Send donation.receipt for one donation. Returns [flash type, flash text]
 * saying which channels it was queued on and which were skipped, and why — the
 * committee needs to know when a receipt could not reach anyone.
 */
function donationsSendReceipt(PDO $db, int $id, string $actor): array
{
    if (!devoteeNotifyReady()) {
        return ['error', 'Receipts cannot be sent yet: notifications are not installed on this site (migration 007).'];
    }
    $stmt = $db->prepare('SELECT id, devotee_id, name, phone, phone_country, amount, purpose, created_at FROM donations WHERE id = :id');
    $stmt->execute([':id' => $id]);
    $d = $stmt->fetch();
    if (!$d) return ['error', "Donation #$id no longer exists."];

    $receipt   = devoteeReceiptNumber($id);
    $sequence  = (donationsReceiptCounts($db, [$id])[$id] ?? 0) + 1;
    $devoteeId = $d['devotee_id'] !== null ? (int) $d['devotee_id'] : null;
    $l         = devoteeCopyLang($devoteeId !== null ? devoteeNotifyLang($devoteeId) : 'ta');
    $ctx = [
        'entity_id' => $id,
        'sequence'  => $sequence,
        'actor'     => $actor,
        'vars'      => [
            'receiptNumber'   => $receipt,
            'donationAmount'  => devoteeMoneyLabel((float) $d['amount']),
            'donationPurpose' => devoteeDonationPurposeLabel($d['purpose'], $l),
            'donationDate'    => notifyFormatDate(substr((string) $d['created_at'], 0, 10), $l),
        ],
    ];
    $who = trim((string) $d['name']);
    if ($devoteeId !== null) {
        $ctx['devotee_id'] = $devoteeId;
    } else {
        $phone = devoteeIntlPhone((string) $d['phone'], $d['phone_country'] ?? null);
        if (strlen($phone) < 7) return ['error', "Receipt $receipt was not sent: the donation has no account and no usable phone number."];
        $ctx['to_phone'] = $phone;
        $ctx['name']     = $who;
        $ctx['lang']     = 'ta';
    }

    $r = devoteeNotifyEvent('donation.receipt', $ctx);
    if ($r === null || ($r['id'] === null && empty($r['deduped']))) {
        return ['error', "Receipt $receipt could not be sent (" . ($r['skipped'] ?? 'the notification service failed') . '). Please try again.'];
    }
    if (!empty($r['deduped'])) {
        return ['warning', "Receipt $receipt number $sequence was already sent a moment ago, so nothing new was sent."];
    }

    $names   = ['email' => 'email', 'whatsapp' => 'WhatsApp', 'sms' => 'SMS', 'push' => 'push'];
    $queued  = [];
    $skipped = [];
    $inApp   = false;
    foreach ($r['deliveries'] as $channel => $delivery) {
        $ok = in_array($delivery['status'], ['queued', 'sending', 'sent', 'delivered', 'read'], true);
        if ($channel === 'inapp') {
            if ($ok) $inApp = true;
            else $skipped[] = 'their account (' . ($delivery['reason'] ?? 'skipped') . ')';
            continue;
        }
        if ($ok) $queued[] = $names[$channel] ?? $channel;
        else $skipped[] = ($names[$channel] ?? $channel) . ' (' . ($delivery['reason'] ?? $delivery['status']) . ')';
    }

    $text = "Receipt $receipt (receipt $sequence)" . ($who !== '' ? " for $who" : '') . ': ';
    $parts = [];
    if ($queued) $parts[] = 'queued for ' . donationsJoin($queued);
    if ($inApp)  $parts[] = 'shown in their account';
    $text .= ($parts ? implode('; ', $parts) : 'no channel could take it') . '.';
    if ($skipped) $text .= ' Skipped: ' . implode(', ', $skipped) . '.';

    adminAudit('donation_receipt', $receipt, "receipt $sequence; queued: " . ($queued ? implode(', ', $queued) : 'none') . ($inApp ? '; in-app' : '') . '; skipped: ' . ($skipped ? implode(', ', $skipped) : 'none'));
    return [$queued || $inApp ? 'success' : 'warning', $text];
}

// ── POST actions (Post → Redirect → Get) ─────────────────────────────────────
// requireAdminAuth() has already refused a viewer's POST (devotees.edit); the
// explicit check keeps the rule visible where the action lives.
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (adminCsrfGuard() !== '') {
        donationsFlash('error', 'Your session expired or the form was tampered with. Please reload and try again.');
    } elseif (($_POST['action'] ?? '') === 'send_receipt') {
        requireAdminCan('devotees.edit');
        [$fType, $fText] = donationsSendReceipt($db, (int) ($_POST['id'] ?? 0), (string) (currentAdmin()['username'] ?? 'admin'));
        donationsFlash($fType, $fText);
    } else {
        donationsFlash('error', 'That action is not available on this page.');
    }
    header('Location: ' . donationsBackUrl(), true, 303);
    exit;
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

// Receipts already sent for the rows on this page, so the action can say so.
$canReceipt   = adminCan('devotees.edit') && devoteeNotifyReady();
$receiptsSent = $canReceipt ? donationsReceiptCounts($db, array_map(static fn(array $r): int => (int) $r['id'], $rows)) : [];

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
if ($msg === '' && !empty($_SESSION['flash_donations'])) {
    [$fType, $fText] = $_SESSION['flash_donations'];
    unset($_SESSION['flash_donations']);
    $tone = in_array($fType, ['success', 'warning', 'error'], true) ? $fType : 'success';
    $msg  = '<p class="alert alert--' . $tone . '" role="' . ($tone === 'success' ? 'status' : 'alert') . '">' . h($fText) . '</p>';
}
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
        if ($canReceipt) {
            $sentCount = $receiptsSent[(int) $row['id']] ?? 0;
            if ($menu) $menu[] = 'divider';
            $menu[] = [
                'label'        => $sentCount > 0 ? 'Send receipt again (' . $sentCount . ' sent)' : 'Send receipt',
                'icon'         => 'clipboard',
                'form'         => ['action' => 'send_receipt', 'id' => (int) $row['id']],
                'confirm'      => 'Send receipt ' . devoteeReceiptNumber((int) $row['id']) . ' for ' . adminFmtMoney((float) $row['amount'], 2) . ' to ' . $row['name'] . '?'
                                . ($sentCount > 0 ? ' ' . $sentCount . ' receipt' . ($sentCount === 1 ? ' has' : 's have') . ' already been sent.' : ''),
                'confirmLabel' => 'Send receipt',
            ];
        }
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
