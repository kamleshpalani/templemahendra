<?php
// backend/admin/receipts.php — Finance → Receipts (brief §14, §15 Finance, §28):
// every receipt issued for an online payment, donations and seva bookings
// alike, with its receipt number, payment number, donor, purpose, amount,
// issue date, CCAvenue reference and where the money stands now.
//
// The page owns no payment logic. The rows come from the same read model as
// Admin → Online Payments (payAdminPayablesSql, payReceiptAttemptSql), the
// receipt link is the one the payments module builds for the donor
// (payReceiptPath), and "Resend receipt" goes through payNotifyReceiptResend —
// the code path admin/payments.php uses — so the two pages can never disagree
// about a receipt.
//
// Permissions (auth.php): reading and exporting need payments.view, resending
// needs payments.manage. requireAdminAuth() refuses a viewer's POST before this
// file's handler runs; the explicit check below keeps the rule visible.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/payments.php';
require_once __DIR__ . '/includes/admin_layout.php';

const RCPT_ADMIN_BASE = '/admin/receipts.php';
const RCPT_PER_PAGE   = 25;
/** Receipt status shown → payable status stored. A receipt is PAID until some of its money goes back. */
const RCPT_STATUSES   = [
    'PAID'               => 'SUCCESS',
    'REFUND_INITIATED'   => 'REFUND_INITIATED',
    'PARTIALLY_REFUNDED' => 'PARTIALLY_REFUNDED',
    'REFUNDED'           => 'REFUNDED',
];
const RCPT_SORTS = ['date', 'amount', 'receipt', 'name'];

$db        = getDB();
$tables    = payTablesExist();
$me        = currentAdmin() ?? [];
$actor     = (string) ($me['username'] ?? 'admin');
$canManage = adminCan('payments.manage');

/** Queue a flash for the page this request redirects to. */
function rcptFlash(string $type, string $text): void
{
    $_SESSION['flash_receipts'] = [$type, $text];
}

/** Same-origin referer on this page only, so a POST lands back on the filtered list it came from. */
function rcptBackUrl(): string
{
    $ref = (string) ($_SERVER['HTTP_REFERER'] ?? '');
    $p   = $ref !== '' ? parse_url($ref) : false;
    if (!$p || empty($p['host'])) return RCPT_ADMIN_BASE;
    $host = $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
    if (strcasecmp($host, (string) ($_SERVER['HTTP_HOST'] ?? '')) !== 0 || ($p['path'] ?? '') !== RCPT_ADMIN_BASE) return RCPT_ADMIN_BASE;
    return RCPT_ADMIN_BASE . (!empty($p['query']) ? '?' . $p['query'] : '');
}

/** The receipt status shown for a payable status: PAID for SUCCESS, the refund states as they are. */
function rcptStatusOf(?string $payableStatus): string
{
    return $payableStatus === 'SUCCESS' ? 'PAID' : (string) $payableStatus;
}

/** "Paid", "Refund initiated", … for a receipt status. */
function rcptStatusLabel(string $receiptStatus): string
{
    return $receiptStatus === 'PAID' ? 'Paid' : payStatusLabel($receiptStatus);
}

/** A UTC database time shown in IST, or an em dash. */
function rcptTime(?string $utc, bool $withTime = true): string
{
    if ($utc === null || $utc === '') return '—';
    return payIstDate($utc, $withTime ? 'd M Y · H:i' : 'd M Y');
}

/** A `<time>` element carrying the UTC value and showing IST. */
function rcptTimeTag(?string $utc, bool $withTime = true): string
{
    if ($utc === null || $utc === '') return '<span class="text-muted">—</span>';
    return '<time datetime="' . h(str_replace(' ', 'T', $utc) . 'Z') . '">' . h(rcptTime($utc, $withTime)) . '</time>';
}

/** "email, WhatsApp and SMS" from a channel list. */
function rcptChannelWords(array $channels): string
{
    $names = ['email' => 'email', 'whatsapp' => 'WhatsApp', 'sms' => 'SMS'];
    $items = array_map(static fn(string $c): string => $names[$c] ?? $c, $channels);
    if (count($items) <= 1) return (string) ($items[0] ?? '');
    $last = array_pop($items);
    return implode(', ', $items) . ' and ' . $last;
}

/**
 * Whitelisted list filters from a query array: q (receipt number, payment
 * number, donor name, email or phone), month (IST "YYYY-MM" of the issue date),
 * type (donation | seva_booking), status (a RCPT_STATUSES key), sort
 * (date | amount | receipt | name), dir (asc | desc).
 */
function rcptFilters(array $query): array
{
    $str = static fn(string $k): string => is_scalar($query[$k] ?? null) ? trim((string) $query[$k]) : '';
    return [
        'q'      => mb_substr($str('q'), 0, 100),
        'month'  => preg_match('/^\d{4}-(0[1-9]|1[0-2])$/D', $str('month')) ? $str('month') : '',
        'type'   => in_array($str('type'), ['donation', 'seva_booking'], true) ? $str('type') : '',
        'status' => isset(RCPT_STATUSES[strtoupper($str('status'))]) ? strtoupper($str('status')) : '',
        'sort'   => in_array($str('sort'), RCPT_SORTS, true) ? $str('sort') : 'date',
        'dir'    => strtolower($str('dir')) === 'asc' ? 'asc' : 'desc',
    ];
}

/**
 * The receipts read model: one row per issued receipt — every column of
 * payAdminPayablesSql() (alias x) plus the receipt attempt's tracking_id,
 * bank_ref_no, payment_mode, environment and order_id (alias t, named by
 * payReceiptAttemptSql()) and, once migration 023 is in, the pooja a donation
 * sponsors (pooja_en, pooja_ta, pooja_date).
 */
function rcptBaseSql(): string
{
    $withPooja = payPoojaLinksReady();
    $poojaCols = $withPooja
        ? 'pj.name_en AS pooja_en, pj.name_ta AS pooja_ta, pj.pooja_date AS pooja_date'
        : 'NULL AS pooja_en, NULL AS pooja_ta, NULL AS pooja_date';
    $poojaJoin = $withPooja
        ? "LEFT JOIN donations dd ON x.kind = 'donation' AND dd.id = x.id LEFT JOIN poojas pj ON pj.id = dd.pooja_id"
        : '';
    return "SELECT x.kind, x.id, x.number, x.name, x.phone, x.email, x.country, x.purpose, x.purpose_en, x.purpose_ta,
                   x.amount, x.currency, x.status, x.receipt_number, x.paid_at, x.amount_refunded, x.lang, x.created_utc,
                   t.tracking_id AS receipt_tracking, t.bank_ref_no AS receipt_bank_ref, t.payment_mode AS receipt_mode,
                   t.environment AS receipt_env, t.order_id AS receipt_order_id, {$poojaCols}
              FROM (" . payAdminPayablesSql() . ") x
              LEFT JOIN " . payReceiptAttemptSql() . " ra ON ra.payable_type = x.kind AND ra.payable_id = x.id
              LEFT JOIN payment_transactions t ON t.id = ra.receipt_id
              {$poojaJoin}";
}

/** WHERE clause (always at least "a receipt was issued") and params for rcptFilters() output. */
function rcptWhere(array $f): array
{
    $where  = ['x.receipt_number IS NOT NULL'];
    $params = [];
    if ($f['q'] !== '') {
        $like  = '%' . addcslashes($f['q'], '%_\\') . '%';
        $parts = ['x.receipt_number LIKE :q1', 'x.number LIKE :q2', 'x.name LIKE :q3', 'x.email LIKE :q4'];
        $params += [':q1' => $like, ':q2' => $like, ':q3' => $like, ':q4' => $like];
        $digits = preg_replace('/\D+/', '', $f['q']) ?? '';
        if (strlen($digits) >= 4) {
            $parts[] = 'x.phone LIKE :q5';
            $params[':q5'] = '%' . $digits . '%';
        }
        $where[] = '(' . implode(' OR ', $parts) . ')';
    }
    if ($f['month'] !== '') {
        $first = $f['month'] . '-01';
        $range = payIstRangeUtc($first, (new DateTimeImmutable($first, new DateTimeZone('UTC')))->format('Y-m-t'));
        $where[] = 'x.paid_at >= :mf AND x.paid_at < :mt';
        $params[':mf'] = $range['from'];
        $params[':mt'] = $range['to'];
    }
    if ($f['type'] !== '') {
        $where[] = 'x.kind = :kind';
        $params[':kind'] = $f['type'];
    }
    if ($f['status'] !== '') {
        $where[] = 'x.status = :status';
        $params[':status'] = RCPT_STATUSES[$f['status']];
    }
    return [' WHERE ' . implode(' AND ', $where), $params];
}

/** ORDER BY for rcptFilters() output: newest receipt first by default. */
function rcptOrder(array $f): string
{
    $col = match ($f['sort']) {
        'amount'  => 'x.amount',
        'receipt' => 'x.receipt_number',
        'name'    => 'x.name',
        default   => 'x.paid_at',
    };
    $dir = $f['dir'] === 'asc' ? 'ASC' : 'DESC';
    return " ORDER BY {$col} {$dir}, x.id {$dir}";
}

/** Purpose of a receipt in both scripts: the category (and the pooja it sponsors) or the seva. */
function rcptPurpose(array $r): array
{
    if ($r['kind'] === 'seva_booking') {
        return ['en' => 'Seva: ' . (string) $r['purpose_en'], 'ta' => (string) ($r['purpose_ta'] ?? '')];
    }
    $en = (string) ($r['purpose_en'] ?? '') !== '' ? (string) $r['purpose_en'] : (string) ($r['purpose'] ?? 'Donation');
    $ta = (string) ($r['purpose_ta'] ?? '');
    if ((string) ($r['pooja_en'] ?? '') !== '') {
        $when = (string) ($r['pooja_date'] ?? '') !== '' ? ' (' . adminFmtDate((string) $r['pooja_date']) . ')' : '';
        $en .= ' · ' . (string) $r['pooja_en'] . $when;
        $ta .= ($ta !== '' ? ' · ' : '') . (string) ($r['pooja_ta'] ?? '');
    }
    return ['en' => $en, 'ta' => $ta];
}

/** Totals of the filtered set per currency: [currency => {count, gross, refunded, net}] as amount strings. */
function rcptTotals(PDO $db, string $listSql, array $params): array
{
    $stmt = $db->prepare("SELECT r.currency, COUNT(*) AS n, SUM(r.amount) AS gross, SUM(r.amount_refunded) AS refunded FROM ({$listSql}) r GROUP BY r.currency ORDER BY r.currency");
    $stmt->execute($params);
    $out = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $gross = payAmountCents((string) $row['gross']);
        $refunded = payAmountCents((string) $row['refunded']);
        $out[(string) $row['currency']] = [
            'count'    => (int) $row['n'],
            'gross'    => payCentsToAmount($gross),
            'refunded' => payCentsToAmount($refunded),
            'net'      => payCentsToAmount($gross - $refunded),
        ];
    }
    return $out;
}

/** The CSV header for the receipts export. */
function rcptCsvHeader(): array
{
    return ['receipt_number', 'kind', 'number', 'donor_name', 'phone', 'email', 'purpose', 'purpose_ta', 'amount', 'currency', 'status',
            'issued_at_ist', 'tracking_id', 'bank_ref_no', 'payment_mode', 'amount_refunded', 'environment'];
}

/** One export row in rcptCsvHeader() order, every cell passed through payCsvCell(). */
function rcptCsvRow(array $r): array
{
    $purpose = rcptPurpose($r);
    return array_map('payCsvCell', [
        $r['receipt_number'], $r['kind'], $r['number'], $r['name'], $r['phone'], $r['email'], $purpose['en'], $purpose['ta'],
        payAmountFormat((string) $r['amount'], 'INR'), $r['currency'], rcptStatusOf($r['status']),
        $r['paid_at'] ? payIstDate($r['paid_at'], 'Y-m-d H:i:s') : '',
        $r['receipt_tracking'], $r['receipt_bank_ref'], $r['receipt_mode'],
        payAmountFormat((string) $r['amount_refunded'], 'INR'), $r['receipt_env'],
    ]);
}

// ── POST actions (Post → Redirect → Get) ─────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action   = (string) ($_POST['action'] ?? '');
    $redirect = rcptBackUrl();
    $number   = is_scalar($_POST['number'] ?? null) ? trim((string) $_POST['number']) : '';

    if (adminCsrfGuard() !== '') {
        rcptFlash('error', 'Your session expired or the form was tampered with. Please reload and try again.');
    } elseif (!$tables) {
        rcptFlash('error', 'Online payments are not installed yet: apply database migration 010_payments.sql first.');
    } elseif ($action === 'resend_receipt') {
        requireAdminCan('payments.manage');
        $payable = payParseNumber($number) !== null ? payLoadPayable($db, $number) : null;
        if ($payable === null) {
            rcptFlash('error', 'That payment no longer exists.');
        } elseif ((string) ($payable['receipt_number'] ?? '') === '' || !in_array($payable['status'], PAY_PAID_STATUSES, true)) {
            rcptFlash('error', 'No receipt has been issued for ' . $payable['number'] . ': only a paid payment has a receipt to send.');
        } else {
            // The same code path as Admin → Online Payments → Resend receipt.
            $res = payNotifyReceiptResend($db, $payable, $actor);
            if ($res['ok']) {
                $queued  = [];
                $skipped = [];
                foreach ($res['result']['deliveries'] ?? [] as $channel => $d) {
                    $good = in_array($d['status'], ['queued', 'sending', 'sent', 'delivered', 'read'], true);
                    if ($good) $queued[] = $channel;
                    else $skipped[] = $channel . ' (' . ($d['reason'] ?? $d['status']) . ')';
                }
                $text = 'Receipt ' . $payable['receipt_number'] . ' (send ' . $res['sequence'] . '): '
                    . ($queued ? 'queued for ' . rcptChannelWords($queued) : 'no channel could take it') . '.';
                if ($skipped) $text .= ' Skipped: ' . implode(', ', $skipped) . '.';
                rcptFlash($queued ? 'success' : 'warning', $text);
                adminAudit('receipts_resend', (string) $payable['receipt_number'], $payable['number'] . ': send ' . $res['sequence'] . '; channels: ' . implode(', ', $res['channels']));
            } else {
                rcptFlash('error', $res['message'] !== '' ? $res['message'] : 'The receipt could not be sent.');
            }
        }
    } else {
        rcptFlash('error', 'That action is not available on this page.');
    }
    header('Location: ' . $redirect, true, 303);
    exit;
}

// ── Filters ──────────────────────────────────────────────────────────────────
$str     = static fn(string $k): string => is_scalar($_GET[$k] ?? null) ? trim((string) $_GET[$k]) : '';
$filters = rcptFilters($_GET);
$page    = max(1, (int) $str('page'));
$query   = array_filter($filters, static fn($v): bool => $v !== '' && $v !== null);
[$where, $params] = $tables ? rcptWhere($filters) : ['', []];
$listSql = $tables ? rcptBaseSql() . $where : '';

// ── CSV export of the filtered receipts (viewers may export) ─────────────────
if ($tables && $str('export') === 'csv' && adminCan('export')) {
    $stmt = $db->prepare($listSql . rcptOrder($filters) . ' LIMIT 50000');
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $applied = array_filter(['q' => $filters['q'], 'month' => $filters['month'], 'type' => $filters['type'], 'status' => $filters['status']], static fn($v): bool => $v !== '');
    adminAudit('receipts_export', 'receipts.csv', count($rows) . ' rows' . ($applied ? '; filters: ' . http_build_query($applied, '', ', ') : ''));
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="receipts-' . date('Y-m-d') . '.csv"');
    header('Cache-Control: no-store');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF"); // BOM so Excel reads Tamil correctly
    // Empty escape string = strict RFC 4180, as the other admin exports use.
    fputcsv($out, rcptCsvHeader(), ',', '"', '');
    foreach ($rows as $row) fputcsv($out, rcptCsvRow($row), ',', '"', '');
    fclose($out);
    exit;
}

// ── Flash from the previous request ──────────────────────────────────────────
$msg = '';
if (!empty($_SESSION['flash_receipts'])) {
    [$fType, $fText] = $_SESSION['flash_receipts'];
    unset($_SESSION['flash_receipts']);
    $tone = in_array($fType, ['success', 'warning', 'error'], true) ? $fType : 'success';
    $msg  = '<p class="alert alert--' . $tone . '" role="' . ($tone === 'success' ? 'status' : 'alert') . '">' . h($fText) . '</p>';
}

$headerActions = '';
if ($tables) {
    // Say out loud when the receipts are not for real money (SIMULATOR / TEST), as Online Payments does.
    try {
        $payMode = payConfig()['mode'];
        if ($payMode === 'simulator' || $payMode === 'test') {
            $headerActions .= adminBadge('Payments: ' . strtoupper($payMode), $payMode === 'simulator' ? 'danger' : 'warning');
        }
    } catch (Throwable $e) {
        error_log('[payments] mode badge unavailable: ' . $e->getMessage());
    }
    $headerActions .= '<a href="/admin/payments.php?view=transactions" class="btn btn-ghost btn--sm">' . adminIcon('landmark') . 'Online Payments</a>';
}
adminHeader('Receipts', 'Finance', ['actions' => $headerActions, 'wide' => true]);
echo $msg;

if (!$tables) {
    echo adminEmpty(
        'clipboard',
        'Receipts are not available yet',
        'Receipts are issued for online payments. Apply database migration 010_payments.sql, then turn payments on in Admin → Payment Gateway; every paid donation and seva booking will be listed here with its receipt number.',
        adminCan('payments.settings') ? '<a href="/admin/payment_settings.php" class="btn btn-primary btn--sm">' . adminIcon('shield') . 'Payment Gateway</a>' : ''
    );
    adminFooter();
    exit;
}

$list       = adminPaginate($db, $listSql . rcptOrder($filters), $params, $page, RCPT_PER_PAGE);
$totals     = rcptTotals($db, $listSql, $params);
$hasFilters = $filters['q'] !== '' || $filters['month'] !== '' || $filters['type'] !== '' || $filters['status'] !== '';
$sortQuery  = ['q' => $filters['q'], 'month' => $filters['month'], 'type' => $filters['type'], 'status' => $filters['status'], 'sort' => $filters['sort'], 'dir' => $filters['dir']];

$inr    = $totals['INR'] ?? ['count' => 0, 'gross' => '0.00', 'refunded' => '0.00', 'net' => '0.00'];
$others = array_diff_key($totals, ['INR' => true]);
$count  = array_sum(array_column($totals, 'count'));
$otherWords = static function (string $key) use ($others): string {
    $parts = [];
    foreach ($others as $code => $t) $parts[] = payAdminMoney($t[$key], (string) $code);
    return $parts ? 'also ' . implode(', ', $parts) : '';
};

echo adminPageIntro(
    'Every receipt issued for an online payment — donations and seva bookings paid through CCAvenue — with the payment it belongs to and where the money stands now. Dates are IST; the totals are for the filtered set.',
    adminCan('export') ? '<a href="' . h(RCPT_ADMIN_BASE . adminQuery($sortQuery, ['export' => 'csv', 'page' => null])) . '" class="btn btn-primary btn--sm">' . adminIcon('download') . 'Export CSV</a>' : ''
);
?>

<form method="GET" action="<?= RCPT_ADMIN_BASE ?>" class="toolbar mt-4" role="search" aria-label="Filter receipts">
  <input type="hidden" name="sort" value="<?= h($filters['sort']) ?>" />
  <input type="hidden" name="dir" value="<?= h($filters['dir']) ?>" />
  <div class="toolbar__search">
    <?= adminIcon('search') ?>
    <label class="sr-only" for="f-q">Search receipts</label>
    <input id="f-q" type="search" name="q" value="<?= h($filters['q']) ?>" placeholder="Receipt number, donation ID, donor name, phone or email…" autocomplete="off" />
  </div>
  <div class="toolbar__group">
    <label for="f-month">Month <input id="f-month" type="month" name="month" value="<?= h($filters['month']) ?>" /></label>
    <label for="f-type">Type
      <select id="f-type" name="type">
        <option value="">Donations and sevas</option>
        <option value="donation"<?= $filters['type'] === 'donation' ? ' selected' : '' ?>>Donations</option>
        <option value="seva_booking"<?= $filters['type'] === 'seva_booking' ? ' selected' : '' ?>>Seva bookings</option>
      </select>
    </label>
    <label for="f-status">Status
      <select id="f-status" name="status">
        <option value="">Any status</option>
        <?php foreach (array_keys(RCPT_STATUSES) as $s): ?>
          <option value="<?= h($s) ?>"<?= $filters['status'] === $s ? ' selected' : '' ?>><?= h(rcptStatusLabel($s)) ?></option>
        <?php endforeach; ?>
      </select>
    </label>
    <button type="submit" class="btn btn--sm"><?= adminIcon('filter') ?> Apply</button>
    <?php if ($hasFilters): ?>
      <a href="<?= RCPT_ADMIN_BASE ?>" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Reset</a>
    <?php endif; ?>
  </div>
  <span class="toolbar__count" aria-live="polite"><?= (int) $list['total'] ?> receipt<?= (int) $list['total'] === 1 ? '' : 's' ?></span>
</form>

<?php
// Totals for the filtered set. Whole rupees on the cards (as the dashboard shows
// money); the paise are in the table and the CSV. Other currencies are listed
// beside the rupee figure, never converted.
$kpiMoney = static fn(string $amount): string => adminFmtMoney(payAmountCents($amount) / 100);
$amountSub = $inr['count'] . ' in rupees' . ($otherWords('gross') !== '' ? ' · ' . $otherWords('gross') : '');
echo adminKpi([
    ['label' => 'Receipts',      'value' => $count, 'icon' => 'clipboard', 'variant' => 'accent', 'sub' => $hasFilters ? 'in the filtered set' : 'issued so far'],
    ['label' => 'Amount (₹)',    'value' => $kpiMoney($inr['gross']),    'icon' => 'banknote', 'sub' => $amountSub],
    ['label' => 'Refunded (₹)',  'value' => $kpiMoney($inr['refunded']), 'icon' => 'undo',     'sub' => $otherWords('refunded') !== '' ? $otherWords('refunded') : 'given back'],
    ['label' => 'Net (₹)',       'value' => $kpiMoney($inr['net']),      'icon' => 'trending', 'sub' => $otherWords('net') !== '' ? $otherWords('net') : 'amount less refunds'],
]);
?>

<?php if ($list['rows']): ?>
<div class="table-wrap" tabindex="0" role="region" aria-label="Receipts">
  <table class="table" data-no-search>
    <thead>
      <tr>
        <?= adminSortLink('receipt', 'Receipt', $sortQuery) ?>
        <th scope="col">Payment</th>
        <?= adminSortLink('name', 'Donor', $sortQuery) ?>
        <th scope="col">Purpose</th>
        <?= adminSortLink('amount', 'Amount', $sortQuery) ?>
        <th scope="col">Currency</th>
        <th scope="col">Status</th>
        <?= adminSortLink('date', 'Issued (IST)', $sortQuery) ?>
        <th scope="col">Payment reference</th>
        <th scope="col"><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      <?php foreach ($list['rows'] as $row): $purpose = rcptPurpose($row); $status = rcptStatusOf($row['status']); $env = (string) ($row['receipt_env'] ?? ''); ?>
      <tr>
        <td><span class="cell-title tabular"><?= h($row['receipt_number']) ?></span>
            <span class="cell-sub"><?= $row['kind'] === 'donation' ? 'Donation' : 'Seva booking' ?><?= $env !== '' && $env !== 'production' ? ' · ' . adminBadge(strtoupper($env), $env === 'simulator' ? 'danger' : 'warning') : '' ?></span></td>
        <td><a class="tabular" href="<?= h('/admin/payments.php?number=' . rawurlencode((string) $row['number'])) ?>"><?= h($row['number']) ?></a></td>
        <td><span class="cell-title"><?= h($row['name']) ?></span>
            <span class="cell-sub"><?= h($row['phone']) ?><?= $row['email'] ? ' · ' . h($row['email']) : '' ?></span></td>
        <td><?= h($purpose['en']) ?>
            <?php if ($purpose['ta'] !== ''): ?><span class="cell-sub" lang="ta"><?= h($purpose['ta']) ?></span><?php endif; ?></td>
        <td class="cell-money"><?= h(payAdminMoney($row['amount'], $row['currency'])) ?>
            <?php if (payAmountCents((string) $row['amount_refunded']) > 0): ?><span class="cell-sub">−<?= h(payAdminMoney($row['amount_refunded'], $row['currency'])) ?> refunded</span><?php endif; ?></td>
        <td><?= h($row['currency']) ?></td>
        <td><?= adminBadge(rcptStatusLabel($status), payStatusTone($row['status'])) ?></td>
        <td class="cell-date"><?= rcptTimeTag($row['paid_at']) ?></td>
        <td><span class="tabular"><?= $row['receipt_tracking'] ? h($row['receipt_tracking']) : '—' ?></span>
            <?php if ($row['receipt_bank_ref']): ?><span class="cell-sub tabular"><?= h($row['receipt_bank_ref']) ?></span><?php endif; ?>
            <?php if ($row['receipt_mode']): ?><span class="cell-sub"><?= h($row['receipt_mode']) ?></span><?php endif; ?></td>
        <td class="cell-actions">
          <div class="cluster">
            <a class="btn btn-ghost btn--xs" href="<?= h(siteUrl(payReceiptPath((string) $row['number']))) ?>" target="_blank" rel="noopener"><?= adminIcon('external') ?> Receipt</a>
            <a class="btn btn-ghost btn--xs" href="<?= h('/admin/payments.php?number=' . rawurlencode((string) $row['number'])) ?>"><?= adminIcon('landmark') ?> Payment</a>
            <?php if ($canManage): ?>
            <form method="POST" action="<?= RCPT_ADMIN_BASE ?>">
              <?= csrfField() ?>
              <input type="hidden" name="action" value="resend_receipt" />
              <input type="hidden" name="number" value="<?= h($row['number']) ?>" />
              <button type="submit" class="btn btn-ghost btn--xs"
                      data-confirm="Send receipt <?= h($row['receipt_number']) ?> to <?= h($row['name']) ?> again?" data-confirm-label="Send receipt">
                <?= adminIcon('mail') ?> Resend
              </button>
            </form>
            <?php endif; ?>
          </div>
        </td>
      </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
</div>
<?= adminPagination($list['page'], $list['pages'], $sortQuery, $list['total'], RCPT_PER_PAGE) ?>
<?php elseif ($hasFilters): ?>
  <?= adminEmpty('search', 'No receipts match these filters', 'Try another month or status, or clear the search.',
      '<a href="' . RCPT_ADMIN_BASE . '" class="btn btn-primary btn--sm">' . adminIcon('x') . 'Clear filters</a>') ?>
<?php else: ?>
  <?= adminEmpty('clipboard', 'No receipts issued yet', 'A receipt is issued the moment a donation or seva booking is paid online; it will be listed here with its number.') ?>
<?php endif; ?>

<?php adminFooter(); ?>
