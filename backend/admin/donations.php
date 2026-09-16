<?php
// backend/admin/donations.php — Donations report: KPIs, filters, sortable list,
// purpose breakdown and a filter-aware CSV export.
//
// "Send receipt" (a row action, editors and owners) sends the donation.receipt
// notification once the committee has the money in hand. Sending it again is a
// deliberate act — a lost email, a corrected address — so each send is its own
// numbered receipt (sequence = receipts already sent + 1) rather than a
// duplicate the dedupe key would swallow.
//
// "Thank-you list" (migration 008) says whether a donor's name may appear on the
// public thank-you list on the homepage. Donors who ticked the box on the
// Donations page are shown automatically; everyone else is hidden until the
// committee shows them, which it should do only with the donor's permission.
// Editors and owners can change the flag one row at a time or for the selected
// rows; every change is written to the activity log so it can be accounted for
// if a donor asks why their name was published. Before migration 008 the
// column, the filter and the actions are simply not offered.
//
// Online giving (migration 010): a donation is either a pledge (`source =
// 'pledge'`, the promise made on the website or imported from a book) or money
// actually paid through CCAvenue (`source = 'online'`). Both are listed here,
// but only pledges and online donations that really succeeded are counted in
// the KPIs and the purpose shares, and always net of anything refunded — an
// abandoned or failed payment is not money. An online row is opened in Online
// Payments, which owns its receipt, its attempts and its refunds. Before
// migration 010 the columns, the filter and the column are simply not offered.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/devotee_notify.php';
require_once __DIR__ . '/../includes/public_guard.php';
require_once __DIR__ . '/../includes/payments.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db      = getDB();
$perPage = 25;

// Whether the consent column exists, and whether this account may change it.
// Viewers see the flag but can only read and export.
$hasListFlag = publicGuardHasColumn('donations', 'show_name_publicly');
$canList     = $hasListFlag && adminCan('content.edit');

// Whether online payments are installed (every new column checked, so a
// half-applied migration cannot break the page).
$hasPayCols = publicGuardHasColumn('donations', 'source')
    && publicGuardHasColumn('donations', 'status')
    && publicGuardHasColumn('donations', 'donation_number')
    && publicGuardHasColumn('donations', 'amount_refunded')
    && publicGuardHasColumn('donations', 'currency');
$canPayments = $hasPayCols && adminCan('payments.view');

// Money that really arrived: every pledge, plus online donations that succeeded,
// counted net of refunds. Used by the KPIs, the filtered total and the shares.
$countableSql = $hasPayCols ? "(source = 'pledge' OR status IN ('SUCCESS','PARTIALLY_REFUNDED'))" : '1';
$netAmountSql = $hasPayCols ? '(amount - amount_refunded)' : 'amount';

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
// Donation categories (migration 010) name the purposes now; the map above
// still labels pledges given to a purpose that no category covers.
if ($hasPayCols) {
    try {
        $categoryLabels = [];
        foreach ($db->query('SELECT slug, name_en FROM donation_categories ORDER BY sort_order, id')->fetchAll() as $c) {
            $categoryLabels[(string) $c['slug']] = (string) $c['name_en'];
        }
        if ($categoryLabels) $purposeLabels = $categoryLabels + $purposeLabels;
    } catch (Throwable $e) {
        error_log('[donations] donation categories unavailable: ' . $e->getMessage());
    }
}
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
    $stmt = $db->prepare('SELECT * FROM donations WHERE id = :id');
    $stmt->execute([':id' => $id]);
    $d = $stmt->fetch();
    if (!$d) return ['error', "Donation #$id no longer exists."];
    // An online donation has its own receipt number, its own tokenised receipt
    // page and its own resend button in Online Payments; the pledge receipt
    // would give the donor a second, different number for the same money.
    if (($d['source'] ?? 'pledge') === 'online') {
        return ['error', 'This donation was paid online. Open it in Online Payments to send its receipt again.'];
    }

    $receipt  = devoteeReceiptNumber($id);
    $sequence = (donationsReceiptCounts($db, [$id])[$id] ?? 0) + 1;
    $who      = trim((string) $d['name']);
    // The receipt goes to the phone number given with the pledge, in the language
    // the Donations form was sent in (a pledge made before migration 009 has none
    // and is Tamil). A donation is not linked to a family registration.
    $phone = devoteeIntlPhone((string) $d['phone'], $d['phone_country'] ?? null);
    if (strlen($phone) < 7) return ['error', "Receipt $receipt was not sent: the donation has no usable phone number."];
    $lang = devoteeLangFromInput($d['lang'] ?? 'ta');
    $l    = devoteeCopyLang($lang);

    $r = devoteeNotifyEvent('donation.receipt', [
        'entity_id' => $id,
        'sequence'  => $sequence,
        'actor'     => $actor,
        'to_phone'  => $phone,
        'name'      => $who,
        'lang'      => $lang,
        'vars'      => [
            'receiptNumber'   => $receipt,
            'donationAmount'  => devoteeMoneyLabel((float) $d['amount']),
            'donationPurpose' => devoteeDonationPurposeLabel($d['purpose'], $l),
            'donationDate'    => notifyFormatDate(substr((string) $d['created_at'], 0, 10), $l),
        ],
    ]);
    if ($r === null || ($r['id'] === null && empty($r['deduped']))) {
        return ['error', "Receipt $receipt could not be sent (" . ($r['skipped'] ?? 'the notification service failed') . '). Please try again.'];
    }
    if (!empty($r['deduped'])) {
        return ['warning', "Receipt $receipt number $sequence was already sent a moment ago, so nothing new was sent."];
    }

    $names   = ['email' => 'email', 'whatsapp' => 'WhatsApp', 'sms' => 'SMS'];
    $queued  = [];
    $skipped = [];
    foreach ($r['deliveries'] as $channel => $delivery) {
        $ok = in_array($delivery['status'], ['queued', 'sending', 'sent', 'delivered', 'read'], true);
        if ($ok) $queued[] = $names[$channel] ?? $channel;
        else $skipped[] = ($names[$channel] ?? $channel) . ' (' . ($delivery['reason'] ?? $delivery['status']) . ')';
    }

    $text = "Receipt $receipt (receipt $sequence)" . ($who !== '' ? " for $who" : '') . ': '
        . ($queued ? 'queued for ' . donationsJoin($queued) : 'no channel could take it') . '.';
    if ($skipped) $text .= ' Skipped: ' . implode(', ', $skipped) . '.';

    adminAudit('donation_receipt', $receipt, "receipt $sequence; language $lang; queued: " . ($queued ? implode(', ', $queued) : 'none') . '; skipped: ' . ($skipped ? implode(', ', $skipped) : 'none'));
    return [$queued ? 'success' : 'warning', $text];
}

/**
 * Show or hide donations on the public thank-you list. Only rows whose flag
 * really changes are written and logged, one activity entry per donation, so
 * the log says exactly whose name was published or withdrawn and by whom.
 * Returns [flash type, flash text].
 */
function donationsSetListed(PDO $db, array $ids, bool $show): array
{
    if (!$ids) return ['error', 'Select at least one donation first.'];

    $marks = implode(',', array_fill(0, count($ids), '?'));
    $stmt  = $db->prepare("SELECT id, name, show_name_publicly FROM donations WHERE id IN ($marks)");
    $stmt->execute($ids);
    $found = [];
    foreach ($stmt->fetchAll() as $r) $found[(int) $r['id']] = $r;

    $want     = $show ? 1 : 0;
    $toChange = array_filter($found, static fn(array $r): bool => (int) $r['show_name_publicly'] !== $want);
    if ($toChange) {
        $changeIds = array_keys($toChange);
        $cmarks    = implode(',', array_fill(0, count($changeIds), '?'));
        $db->prepare("UPDATE donations SET show_name_publicly = ? WHERE id IN ($cmarks)")
           ->execute(array_merge([$want], $changeIds));
        foreach ($toChange as $id => $r) {
            adminAudit(
                $show ? 'donation_list_show' : 'donation_list_hide',
                devoteeReceiptNumber($id),
                ($show ? 'shown on' : 'hidden from') . ' the public thank-you list: ' . trim((string) $r['name'])
            );
        }
    }

    $n       = count($toChange);
    $same    = count($found) - $n;
    $missing = count($ids) - count($found);
    $where   = $show ? 'shown on the thank-you list' : 'hidden from the thank-you list';

    if (count($ids) === 1 && $found) {
        $r    = reset($found);
        $what = devoteeReceiptNumber((int) $r['id']) . (trim((string) $r['name']) !== '' ? ' (' . trim((string) $r['name']) . ')' : '');
        return ['success', $n > 0 ? "$what is now $where." : "$what was already $where; nothing changed."];
    }
    if (!$found) {
        return ['error', count($ids) === 1 ? 'That donation no longer exists.' : 'None of the selected donations exist any more.'];
    }
    $text = $n > 0
        ? "$n donation" . ($n === 1 ? ' is' : 's are') . " now $where."
        : 'No donations changed: the selected donation' . (count($found) === 1 ? ' was' : 's were') . " already $where.";
    if ($n > 0 && $same > 0) $text .= " $same already " . ($same === 1 ? 'was' : 'were') . '.';
    if ($missing > 0) $text .= " $missing no longer exist" . ($missing === 1 ? 's' : '') . '.';
    return ['success', $text];
}

// ── POST actions (Post → Redirect → Get) ─────────────────────────────────────
// requireAdminAuth() has already refused a viewer's POST (devotees.edit); the
// explicit checks keep each rule visible where its action lives.
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = (string) ($_POST['action'] ?? '');
    if (adminCsrfGuard() !== '') {
        donationsFlash('error', 'Your session expired or the form was tampered with. Please reload and try again.');
    } elseif ($action === 'send_receipt') {
        requireAdminCan('devotees.edit');
        [$fType, $fText] = donationsSendReceipt($db, (int) ($_POST['id'] ?? 0), (string) (currentAdmin()['username'] ?? 'admin'));
        donationsFlash($fType, $fText);
    } elseif ($action === 'set_listed' || $action === 'bulk_listed') {
        // Publishing a donor's name is a content decision, so it needs content.edit.
        requireAdminCan('content.edit');
        if (!$hasListFlag) {
            donationsFlash('error', 'The thank-you list setting is not available yet: apply database migration 008 first.');
        } else {
            $raw = $action === 'set_listed' ? [$_POST['id'] ?? 0] : (array) ($_POST['ids'] ?? []);
            // Whole positive ids only, and a sane ceiling: the page shows 25 rows.
            $ids = array_slice(array_values(array_unique(array_filter(
                array_map(static fn($v): int => is_scalar($v) ? (int) $v : 0, $raw),
                static fn(int $i): bool => $i > 0
            ))), 0, 200);
            [$fType, $fText] = donationsSetListed($db, $ids, (string) ($_POST['show'] ?? '') === '1');
            donationsFlash($fType, $fText);
        }
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

$listedLabels = ['shown' => 'Shown', 'hidden' => 'Not shown'];
$sourceLabels = ['pledge' => 'Pledges', 'online' => 'Paid online'];

$q       = $str('q');
$purpose = $str('purpose');
if (!isset($purposeLabels[$purpose])) $purpose = '';
$listed  = $hasListFlag && isset($listedLabels[$str('listed')]) ? $str('listed') : '';
$source  = $hasPayCols && isset($sourceLabels[$str('source')]) ? $str('source') : '';
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

$query      = ['q' => $q, 'purpose' => $purpose, 'listed' => $listed, 'source' => $source, 'from' => $from, 'to' => $to, 'sort' => $sort, 'dir' => $dir];
$hasFilters = $q !== '' || $purpose !== '' || $listed !== '' || $source !== '' || $from !== '' || $to !== '';

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
if ($listed !== '') {
    $where[] = 'show_name_publicly = ' . ($listed === 'shown' ? '1' : '0');
}
if ($source !== '') {
    $where[] = 'source = :source';
    $params[':source'] = $source;
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
$listCol  = $hasListFlag ? ', show_name_publicly' : '';
$payCols  = $hasPayCols ? ', source, status, donation_number, currency, category_id, amount_refunded' : '';

// ── CSV export (report) — respects the active filters and sort ──────────────
if ($str('export') === 'csv') {
    $stmt = $db->prepare('SELECT id, name, phone, amount, purpose, message' . $listCol . ', created_at' . $payCols . ' FROM donations' . $whereSql . $orderSql);
    $stmt->execute($params);
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="donations-' . date('Y-m-d') . '.csv"');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF"); // BOM so Excel reads Tamil correctly
    // Empty escape string = strict RFC 4180 (quotes doubled, no backslash special
    // case) so a message containing \" is not mis-parsed by Excel / pandas.
    // The online columns are appended after the existing ones, so a spreadsheet
    // or script that reads this export by position keeps working.
    $head = ['id', 'name', 'phone', 'amount', 'purpose', 'message'];
    if ($hasListFlag) $head[] = 'show_name_publicly';
    $head[] = 'created_at';
    if ($hasPayCols) array_push($head, 'source', 'status', 'donation_number', 'currency', 'category');
    fputcsv($out, $head, ',', '"', '');
    while ($r = $stmt->fetch()) {
        $line = [$r['id'], $r['name'], $r['phone'], $r['amount'], $r['purpose'], $r['message']];
        if ($hasListFlag) $line[] = (int) $r['show_name_publicly'];
        $line[] = $r['created_at'];
        if ($hasPayCols) {
            array_push(
                $line,
                (string) $r['source'],
                (string) ($r['status'] ?? ''),
                (string) ($r['donation_number'] ?? ''),
                (string) ($r['currency'] ?? ''),
                (string) ($purposeLabels[(string) ($r['purpose'] ?? '')] ?? '')
            );
        }
        fputcsv($out, array_map('payCsvCell', $line), ',', '"', '');
    }
    fclose($out);
    exit;
}

// ── KPIs (all time; only money that really arrived) ──────────────────────────
$agg = $db->query("SELECT COUNT(*) c, COALESCE(SUM({$netAmountSql}),0) total, COALESCE(AVG({$netAmountSql}),0) avg_amt,
                          COALESCE(MAX({$netAmountSql}),0) max_amt, MIN(created_at) first_at
                     FROM donations WHERE {$countableSql}")->fetch();
$countAll = (int) $agg['c'];
$totalAll = (float) $agg['total'];
$avgAll   = (float) $agg['avg_amt'];
$maxAll   = (float) $agg['max_amt'];
$monthRow = $db->query("SELECT COUNT(*) c, COALESCE(SUM({$netAmountSql}),0) total FROM donations
                         WHERE {$countableSql} AND created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')")->fetch();
$monthSum = (float) $monthRow['total'];
$monthCnt = (int) $monthRow['c'];
$prevSum  = (float) $db->query("SELECT COALESCE(SUM({$netAmountSql}),0) FROM donations
                                 WHERE {$countableSql} AND created_at >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
                                   AND created_at < DATE_FORMAT(CURDATE(), '%Y-%m-01')")->fetchColumn();

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
// The count is every row the filters match; the money is only what arrived.
$fstmt = $db->prepare("SELECT COUNT(*) c, COALESCE(SUM(CASE WHEN {$countableSql} THEN {$netAmountSql} ELSE 0 END),0) total FROM donations" . $whereSql);
$fstmt->execute($params);
$filtered      = $fstmt->fetch();
$filteredCount = (int) $filtered['c'];
$filteredSum   = (float) $filtered['total'];

$result = adminPaginate($db, 'SELECT id, name, phone, amount, purpose, message' . $listCol . ', created_at' . $payCols . ' FROM donations' . $whereSql . $orderSql, $params, $page, $perPage);
$rows   = $result['rows'];

// Receipts already sent for the rows on this page, so the action can say so.
$canReceipt   = adminCan('devotees.edit') && devoteeNotifyReady();
$receiptsSent = $canReceipt ? donationsReceiptCounts($db, array_map(static fn(array $r): int => (int) $r['id'], $rows)) : [];

// Donations by purpose over the same filtered set (money that arrived only)
$pstmt = $db->prepare("SELECT COALESCE(NULLIF(purpose,''),'other') p, SUM({$netAmountSql}) total, COUNT(*) c FROM donations"
    . ($whereSql !== '' ? $whereSql . " AND {$countableSql}" : " WHERE {$countableSql}") . ' GROUP BY p ORDER BY total DESC');
$pstmt->execute($params);
$purposeShares = [];
foreach ($pstmt->fetchAll() as $i => $p) {
    $purposeShares[] = [
        'label' => $purposeLabels[$p['p']] ?? ucfirst((string) $p['p']),
        'value' => (float) $p['total'],
        'hint'  => adminFmtMoney((float) $p['total']) . ' · ' . (int) $p['c'] . ' donation' . ((int) $p['c'] === 1 ? '' : 's'),
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
    $hasPayCols
        ? 'Pledges from the public Donations page and bulk imports, together with donations paid online through CCAvenue. The figures count pledges and successful online payments only, net of refunds — a failed or abandoned payment is not money.'
        : 'Pledges submitted through the public Donations page and bulk imports. Search, filter by purpose or date, sort the columns, and export exactly what you see as CSV.',
    '<a href="' . h($exportHref) . '" class="btn btn-primary btn--sm">' . adminIcon('download') . ($hasFilters ? 'Export filtered CSV' : 'Export CSV') . '</a>'
    . ($canPayments ? '<a href="/admin/payments.php" class="btn btn--sm">' . adminIcon('landmark') . 'Online Payments</a>' : '')
);

$noun = $hasPayCols ? 'donation' : 'pledge';
echo adminKpi([
    ['label' => 'Total recorded', 'value' => adminFmtMoney($totalAll), 'icon' => 'banknote', 'variant' => 'accent', 'sub' => $countAll . ' ' . $noun . ($countAll === 1 ? '' : 's') . ' all time'],
    ['label' => 'This month',     'value' => adminFmtMoney($monthSum), 'icon' => 'trending', 'delta' => $delta, 'deltaDown' => $deltaDown, 'sub' => $monthCnt . ' ' . $noun . ($monthCnt === 1 ? '' : 's') . ' this month'],
    ['label' => ucfirst($noun) . 's', 'value' => $countAll,             'icon' => 'clipboard', 'sub' => $agg['first_at'] ? 'Since ' . adminFmtDate($agg['first_at']) : 'None recorded yet'],
    ['label' => 'Average ' . $noun, 'value' => adminFmtMoney($avgAll),  'icon' => 'activity', 'sub' => $maxAll > 0 ? 'Largest ' . adminFmtMoney($maxAll) : 'None recorded yet'],
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
    <?php if ($hasPayCols): ?>
    <label for="f-source">Source
      <select id="f-source" name="source">
        <option value="">Pledges and online</option>
        <?php foreach ($sourceLabels as $val => $label): ?>
          <option value="<?= h($val) ?>"<?= $source === $val ? ' selected' : '' ?>><?= h($label) ?></option>
        <?php endforeach; ?>
      </select>
    </label>
    <?php endif; ?>
    <?php if ($hasListFlag): ?>
    <label for="f-listed">Thank-you list
      <select id="f-listed" name="listed">
        <option value="">Shown or not</option>
        <?php foreach ($listedLabels as $val => $label): ?>
          <option value="<?= h($val) ?>"<?= $listed === $val ? ' selected' : '' ?>><?= h($label) ?></option>
        <?php endforeach; ?>
      </select>
    </label>
    <?php endif; ?>
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
  <span class="toolbar__count"><?= $filteredCount ?> record<?= $filteredCount === 1 ? '' : 's' ?> · <?= adminFmtMoney($filteredSum) ?><?= $hasPayCols ? ' received' : '' ?></span>
</form>

<nav class="filter-chips mb-4" aria-label="Quick date ranges">
  <?php foreach ($ranges as $label => $r): $current = $from === $r['from'] && $to === $r['to']; ?>
    <a class="chip" href="<?= h('donations.php' . adminQuery($query, ['from' => $r['from'], 'to' => $r['to'], 'page' => null])) ?>"<?= $current ? ' aria-current="page"' : '' ?>><?= h($label) ?></a>
  <?php endforeach; ?>
</nav>

<?php if ($hasListFlag): ?>
<p class="text-sm text-muted mb-4" id="thanks-list-note">Thank-you list: donors who ticked “show my name” on the website appear on the homepage list automatically for 30 days. Show anyone else only after the donor has given permission.</p>
<?php endif; ?>

<?php if ($rows): ?>
<div class="table-wrap">
  <table class="table"<?= $canList ? ' data-bulk="bulk-form"' : '' ?> data-no-search>
    <thead>
      <tr>
        <?php if ($canList): ?><th scope="col" class="cell-select"><input type="checkbox" data-select-all aria-label="Select all donations on this page" /></th><?php endif; ?>
        <th scope="col">#</th>
        <?= adminSortLink('name', 'Devotee', $query) ?>
        <?= adminSortLink('amount', 'Amount', $query) ?>
        <th scope="col">Purpose</th>
        <?php if ($hasPayCols): ?><th scope="col">Payment</th><?php endif; ?>
        <th scope="col">Message</th>
        <?php if ($hasListFlag): ?><th scope="col">Thank-you list</th><?php endif; ?>
        <?= adminSortLink('created_at', 'Date', $query) ?>
        <th scope="col"><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      <?php foreach ($rows as $i => $row):
        $id      = (int) $row['id'];
        $n       = ($result['page'] - 1) * $perPage + $i + 1;
        $tel     = preg_replace('/[^\d+]/', '', (string) $row['phone']) ?? '';
        $wa      = donationsWaNumber((string) $row['phone']);
        $pKey    = (string) ($row['purpose'] ?? '');
        $pLabel  = $pKey !== '' ? ($purposeLabels[$pKey] ?? $pKey) : '';
        $message = (string) ($row['message'] ?? '');
        $shown   = $hasListFlag && (int) $row['show_name_publicly'] === 1;
        $isOnline = $hasPayCols && (string) ($row['source'] ?? 'pledge') === 'online';
        $payNumber = $isOnline ? (string) ($row['donation_number'] ?? '') : '';
        $greet   = 'வணக்கம் ' . $row['name'] . ', நன்றி! Thank you for your donation pledge of ' . adminFmtMoney((float) $row['amount'], 2)
                 . ($pLabel !== '' ? ' towards ' . $pLabel : '') . ' to Dhabbalavaar Renuka Devi Temple.';
        $menu    = [];
        if ($tel !== '') $menu[] = ['label' => 'Call', 'href' => 'tel:' . $tel, 'icon' => 'phone'];
        if ($wa !== '')  $menu[] = ['label' => 'WhatsApp', 'href' => 'https://wa.me/' . $wa . '?text=' . rawurlencode($greet), 'icon' => 'external'];
        // An online donation's receipt, attempts and refunds live in Online
        // Payments; this page never sends a second receipt number for it.
        if ($isOnline && $canPayments && $payNumber !== '') {
            if ($menu) $menu[] = 'divider';
            $menu[] = ['label' => 'Open payment', 'icon' => 'landmark', 'href' => '/admin/payments.php?number=' . rawurlencode($payNumber)];
        }
        if ($canReceipt && !$isOnline) {
            $sentCount = $receiptsSent[$id] ?? 0;
            if ($menu) $menu[] = 'divider';
            $menu[] = [
                'label'        => $sentCount > 0 ? 'Send receipt again (' . $sentCount . ' sent)' : 'Send receipt',
                'icon'         => 'clipboard',
                'form'         => ['action' => 'send_receipt', 'id' => $id],
                'confirm'      => 'Send receipt ' . devoteeReceiptNumber($id) . ' for ' . adminFmtMoney((float) $row['amount'], 2) . ' to ' . $row['name'] . '?'
                                . ($sentCount > 0 ? ' ' . $sentCount . ' receipt' . ($sentCount === 1 ? ' has' : 's have') . ' already been sent.' : ''),
                'confirmLabel' => 'Send receipt',
            ];
        }
        if ($canList) {
            if ($menu) $menu[] = 'divider';
            $menu[] = $shown
                ? ['label' => 'Hide from thank-you list', 'icon' => 'x', 'form' => ['action' => 'set_listed', 'id' => $id, 'show' => 0]]
                : [
                    'label'        => 'Show on thank-you list',
                    'icon'         => 'check',
                    'form'         => ['action' => 'set_listed', 'id' => $id, 'show' => 1],
                    'confirm'      => 'Show ' . $row['name'] . ' on the public thank-you list? Do this only if the donor has agreed to have their name published.',
                    'confirmLabel' => 'Confirm and show',
                ];
        }
      ?>
      <tr>
        <?php if ($canList): ?><td class="cell-select"><input type="checkbox" name="ids[]" value="<?= $id ?>" aria-label="Select donation <?= h(devoteeReceiptNumber($id)) ?> from <?= h($row['name']) ?>" /></td><?php endif; ?>
        <td class="cell-muted tabular"><?= $n ?></td>
        <td>
          <span class="cell-title"><?= h($row['name']) ?></span>
          <?php if ($tel !== ''): ?><a class="cell-sub" href="tel:<?= h($tel) ?>"><?= h($row['phone']) ?></a><?php else: ?><span class="cell-sub"><?= h($row['phone']) ?></span><?php endif; ?>
        </td>
        <td class="cell-money"><?= adminFmtMoney((float) $row['amount'], 2) ?></td>
        <td><?= $pLabel !== '' ? adminBadge($pLabel, 'gold') : '<span class="text-muted">—</span>' ?></td>
        <?php if ($hasPayCols): ?>
        <td>
          <?php if ($isOnline): ?>
            <?= adminBadge('Online', 'gold') ?> <?= adminBadge(payStatusLabel((string) $row['status']), payStatusTone((string) $row['status'])) ?>
            <?php if ($payNumber !== ''): ?>
              <?php if ($canPayments): ?>
                <a class="cell-sub tabular" href="/admin/payments.php?number=<?= rawurlencode($payNumber) ?>"><?= h($payNumber) ?></a>
              <?php else: ?>
                <span class="cell-sub tabular"><?= h($payNumber) ?></span>
              <?php endif; ?>
            <?php endif; ?>
            <?php if ((float) ($row['amount_refunded'] ?? 0) > 0): ?>
              <span class="cell-sub">−<?= adminFmtMoney((float) $row['amount_refunded'], 2) ?> refunded</span>
            <?php endif; ?>
          <?php else: ?>
            <?= adminBadge('Pledge', 'muted') ?>
          <?php endif; ?>
        </td>
        <?php endif; ?>
        <td><?= $message !== '' ? '<span class="cell-clip">' . h($message) . '</span>' : '<span class="text-muted">—</span>' ?></td>
        <?php if ($hasListFlag): ?><td><?= $shown ? adminBadge('Shown', 'success') : adminBadge('Not shown', 'muted') ?></td><?php endif; ?>
        <td class="cell-date"><time datetime="<?= h($row['created_at']) ?>"><?= adminFmtDate($row['created_at'], true) ?></time></td>
        <td class="cell-actions"><?= $menu ? adminMenu($menu, 'Actions for ' . $row['name']) : '' ?></td>
      </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
</div>

<?php if ($canList): ?>
<form method="POST" action="/admin/donations.php" id="bulk-form" class="bulk-bar" hidden aria-label="Bulk actions">
  <?= csrfField() ?>
  <input type="hidden" name="action" value="bulk_listed" />
  <span class="bulk-bar__count" aria-live="polite">0 selected</span>
  <button type="submit" name="show" value="1" class="btn btn-gold btn--sm" data-confirm="Show the selected donors on the public thank-you list? Do this only for donors who have agreed to have their names published." data-confirm-label="Confirm and show"><?= adminIcon('check') ?> Show on thank-you list</button>
  <button type="submit" name="show" value="0" class="btn btn--sm"><?= adminIcon('x') ?> Hide from thank-you list</button>
  <button type="button" class="btn btn-ghost btn--sm" data-bulk-clear><?= adminIcon('x') ?> Clear selection</button>
</form>
<?php endif; ?>

<?= adminPagination($result['page'], $result['pages'], $query, $result['total'], $perPage) ?>
<?php elseif ($hasFilters): ?>
  <?= adminEmpty('search', 'No donations match these filters', 'Try a wider date range, a different purpose or thank-you list setting, or clear the search.', '<a href="donations.php" class="btn btn-primary btn--sm">' . adminIcon('x') . 'Clear filters</a>') ?>
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
