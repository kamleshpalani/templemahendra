<?php
// backend/admin/payments.php — Online Payments (docs/payments/SPEC.md §10.3):
// the overview, the transactions list and its CSV export, refunds,
// reconciliation, and the detail view of one payment with its audit trail.
//
// The page owns no payment logic. Every figure comes from
// backend/includes/payments/admin.php and every change goes through the payments
// library (payNotifyReceiptResend, payVerifyAttempt, payMarkReviewed,
// payRefundCreate, payCronRun, payReconcileCsv), so this page, the cron and the
// public site can never disagree about money.
//
// Permissions (auth.php): reading and exporting need payments.view (viewer);
// resending a receipt, checking an order with CCAvenue, marking an attempt
// reviewed and running reconciliation need payments.manage (editor); refunds
// need payments.refund (owner). requireAdminAuth() refuses a viewer's POST
// before this file's own handlers run; the explicit checks below keep each rule
// visible where its action lives.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/payments.php';
require_once __DIR__ . '/includes/admin_layout.php';

const PAY_ADMIN_BASE     = '/admin/payments.php';
const PAY_ADMIN_PER_PAGE = 25;
const PAY_ADMIN_VIEWS    = ['overview' => 'Overview', 'transactions' => 'Transactions', 'refunds' => 'Refunds', 'reconcile' => 'Reconciliation'];

$db        = getDB();
$tables    = payTablesExist();
$me        = currentAdmin() ?? [];
$actor     = (string) ($me['username'] ?? 'admin');
$canManage = adminCan('payments.manage');
$canRefund = adminCan('payments.refund');

/** Queue a flash for the page this request redirects to. */
function payFlash(string $type, string $text): void
{
    $_SESSION['flash_payments'] = [$type, $text];
}

/** Same-origin referer on this page only, so a POST lands back on the tab it came from. */
function payBackUrl(): string
{
    $ref = (string) ($_SERVER['HTTP_REFERER'] ?? '');
    $p   = $ref !== '' ? parse_url($ref) : false;
    if (!$p || empty($p['host'])) return PAY_ADMIN_BASE;
    $host = $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
    if (strcasecmp($host, (string) ($_SERVER['HTTP_HOST'] ?? '')) !== 0 || ($p['path'] ?? '') !== PAY_ADMIN_BASE) return PAY_ADMIN_BASE;
    return PAY_ADMIN_BASE . (!empty($p['query']) ? '?' . $p['query'] : '');
}

/** The detail URL of one payment number. */
function payDetailUrl(string $number, array $extra = []): string
{
    return PAY_ADMIN_BASE . '?' . http_build_query(['number' => $number] + $extra);
}

/** A UTC database time shown in IST, or an em dash. */
function payAdminTime(?string $utc, bool $withTime = true): string
{
    if ($utc === null || $utc === '') return '—';
    return payIstDate($utc, $withTime ? 'd M Y · H:i' : 'd M Y');
}

/** A `<time>` element carrying the UTC value and showing IST. */
function payAdminTimeTag(?string $utc, bool $withTime = true): string
{
    if ($utc === null || $utc === '') return '<span class="text-muted">—</span>';
    return '<time datetime="' . h(str_replace(' ', 'T', $utc) . 'Z') . '">' . h(payAdminTime($utc, $withTime)) . '</time>';
}

/** "also USD 120.00, GBP 40.00" for the non-INR part of a KPI block, or ''. */
function payAdminOthers(array $block): string
{
    $parts = [];
    foreach ($block['others'] ?? [] as $code => $amount) $parts[] = payAdminMoney($amount, (string) $code);
    return $parts ? 'also ' . implode(', ', $parts) : '';
}

/** "response_undecryptable" → "Response undecryptable". */
function payAdminEventLabel(string $event): string
{
    return ucfirst(str_replace('_', ' ', $event));
}

/** A status badge, with the "Review" badge beside it when an attempt is flagged. */
function payAdminStatusBadge(?string $status, bool $needsReview = false): string
{
    $out = adminBadge(payStatusLabel($status), payStatusTone($status));
    if ($needsReview) $out .= ' ' . adminBadge('Review', 'warning');
    return $out;
}

/** "email, WhatsApp and SMS" from a channel list. */
function payAdminChannelWords(array $channels): string
{
    $names = ['email' => 'email', 'whatsapp' => 'WhatsApp', 'sms' => 'SMS'];
    $items = array_map(static fn(string $c): string => $names[$c] ?? $c, $channels);
    if (count($items) <= 1) return (string) ($items[0] ?? '');
    $last = array_pop($items);
    return implode(', ', $items) . ' and ' . $last;
}

// ── POST actions (Post → Redirect → Get) ─────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action   = (string) ($_POST['action'] ?? '');
    $redirect = payBackUrl();
    $post     = static fn(string $k): string => is_scalar($_POST[$k] ?? null) ? trim((string) $_POST[$k]) : '';
    $number   = $post('number');
    if ($number !== '' && payParseNumber($number) !== null) $redirect = payDetailUrl(payParseNumber($number)['number']);

    if (adminCsrfGuard() !== '') {
        payFlash('error', 'Your session expired or the form was tampered with. Please reload and try again.');
    } elseif (!$tables) {
        payFlash('error', 'Online payments are not installed yet: apply database migration 010_payments.sql first.');
    } elseif ($action === 'resend_receipt') {
        requireAdminCan('payments.manage');
        $payable = payLoadPayable($db, $number);
        if ($payable === null) {
            payFlash('error', 'That payment no longer exists.');
        } else {
            $res = payNotifyReceiptResend($db, $payable, $actor);
            if ($res['ok']) {
                $queued  = [];
                $skipped = [];
                foreach ($res['result']['deliveries'] ?? [] as $channel => $d) {
                    $good = in_array($d['status'], ['queued', 'sending', 'sent', 'delivered', 'read'], true);
                    if ($good) $queued[] = $channel;
                    else $skipped[] = $channel . ' (' . ($d['reason'] ?? $d['status']) . ')';
                }
                $text = 'Receipt ' . ($payable['receipt_number'] ?? $payable['number']) . ' (send ' . $res['sequence'] . '): '
                    . ($queued ? 'queued for ' . payAdminChannelWords($queued) : 'no channel could take it') . '.';
                if ($skipped) $text .= ' Skipped: ' . implode(', ', $skipped) . '.';
                payFlash($queued ? 'success' : 'warning', $text);
                adminAudit('payment_receipt_resend', $payable['number'], 'send ' . $res['sequence'] . '; channels: ' . implode(', ', $res['channels']));
            } else {
                payFlash('error', $res['message'] !== '' ? $res['message'] : 'The receipt could not be sent.');
            }
        }
    } elseif ($action === 'check_now') {
        requireAdminCan('payments.manage');
        $payable = payLoadPayable($db, $number);
        if ($payable === null) {
            payFlash('error', 'That payment no longer exists.');
        } else {
            $lines   = [];
            $checked = 0;
            foreach ($payable['attempts'] as $a) {
                if ($a['status'] === 'SUCCESS' && in_array($a['verification'], ['status_api', 'manual'], true)) continue;
                $r = payVerifyAttempt($db, $a, $actor);
                $checked++;
                $lines[] = $a['order_id'] . ': ' . $r['outcome'] . ($r['changed'] ? " ({$r['from']} → {$r['to']})" : '');
            }
            adminAudit('payment_check_now', $payable['number'], $checked . ' attempt(s): ' . implode('; ', $lines));
            payFlash(
                $checked > 0 ? 'success' : 'warning',
                $checked > 0
                    ? 'Checked ' . $checked . ' attempt' . ($checked === 1 ? '' : 's') . ' with CCAvenue — ' . implode('; ', $lines) . '.'
                    : 'Nothing to check: every attempt of this payment is already confirmed by CCAvenue.'
            );
        }
    } elseif ($action === 'mark_reviewed') {
        requireAdminCan('payments.manage');
        $res = payMarkReviewed($db, (int) $post('transaction_id'), $post('note'), $actor);
        payFlash($res['ok'] ? 'success' : 'error', $res['message']);
    } elseif ($action === 'show_pan') {
        requireAdminCan('payments.manage');
        $payable = payLoadPayable($db, $number);
        if ($payable === null || ($payable['pan'] ?? '') === '') {
            payFlash('error', 'That payment has no PAN on file.');
        } else {
            adminAudit('payment_pan_viewed', $payable['number'], 'the donor\'s PAN was shown in the admin');
            // One-shot: the next render of this payment shows the PAN and forgets the flag,
            // so a reload or a shared URL never shows it again without a new audit line.
            $_SESSION['pay_show_pan'] = $payable['number'];
            $redirect = payDetailUrl($payable['number']);
        }
    } elseif ($action === 'refund') {
        requireAdminCan('payments.refund');
        $payable = payLoadPayable($db, $number);
        $attempt = $payable !== null ? payLoadAttempt($db, (int) $post('transaction_id')) : null;
        $method  = $post('method') === 'manual' ? 'manual' : 'gateway_api';
        if ($payable === null || $attempt === null) {
            payFlash('error', 'That payment or attempt no longer exists.');
        } elseif ($method === 'manual' && ($_POST['confirm_manual'] ?? '') !== '1') {
            payFlash('error', 'Tick the box confirming you have already refunded this in the CCAvenue dashboard.');
        } else {
            $res = payRefundCreate(
                $db,
                $payable,
                $attempt,
                $post('kind') === 'partial' ? 'partial' : 'full',
                $post('amount'),
                $post('reason'),
                $method,
                $post('gateway_reference') !== '' ? $post('gateway_reference') : null,
                $actor
            );
            payFlash($res['ok'] ? 'success' : 'error', $res['message']);
        }
    } elseif ($action === 'refund_check') {
        requireAdminCan('payments.refund');
        $res = payRefundCheckAgain($db, (int) $post('refund_id'), $actor);
        payFlash($res['ok'] ? 'success' : 'warning', $res['message']);
    } elseif ($action === 'refund_fail') {
        requireAdminCan('payments.refund');
        $res = payRefundMarkFailed($db, (int) $post('refund_id'), $post('reason'), $actor);
        payFlash($res['ok'] ? 'success' : 'error', $res['message']);
    } elseif ($action === 'run_checks') {
        requireAdminCan('payments.manage');
        $summary = payCronRun(['limit' => 20, 'actor' => $actor, 'trigger' => 'admin']);
        if (!empty($summary['locked'])) {
            payFlash('warning', 'A reconciliation run is already going on (the scheduled one). Try again in a minute.');
        } else {
            payFlash('success', 'Checked ' . $summary['checked'] . ' attempt' . ($summary['checked'] === 1 ? '' : 's') . ' with CCAvenue: '
                . $summary['changed'] . ' changed, ' . $summary['cancelled'] . ' closed, ' . $summary['expired'] . ' hold' . ($summary['expired'] === 1 ? '' : 's')
                . ' expired, ' . $summary['errors'] . ' error' . ($summary['errors'] === 1 ? '' : 's') . '.');
            adminAudit('payment_checks_run', 'reconciliation', 'checked ' . $summary['checked'] . ', changed ' . $summary['changed']);
        }
    } elseif ($action === 'reconcile_csv') {
        requireAdminCan('payments.manage');
        $file = $_FILES['report'] ?? null;
        if (!is_array($file) || ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file((string) $file['tmp_name'])) {
            payFlash('error', 'Choose the order report (.csv) exported from the CCAvenue dashboard. Files larger than 5 MB are refused.');
        } elseif ((int) $file['size'] > 5 * 1024 * 1024) {
            payFlash('error', 'That file is larger than 5 MB.');
        } elseif (!preg_match('/\.csv$/i', (string) $file['name'])) {
            payFlash('error', 'The report must be a .csv file.');
        } else {
            $result = payReconcileCsv($db, (string) $file['tmp_name'], $actor);
            if (!$result['ok']) {
                payFlash('error', (string) ($result['error'] ?? 'The report could not be read.'));
            } else {
                foreach (['mismatches', 'missing_here', 'missing_there', 'refunded_there', 'paid_there_not_here'] as $k) {
                    $result[$k] = array_slice($result[$k], 0, 200);
                }
                $result['file'] = mb_substr((string) $file['name'], 0, 120);
                $result['at']   = payUtcNow();
                $_SESSION['pay_csv'] = $result;
                payFlash('success', 'Compared ' . $result['rows'] . ' report row' . ($result['rows'] === 1 ? '' : 's') . ': '
                    . $result['matched'] . ' matched, ' . count($result['mismatches']) . ' difference' . (count($result['mismatches']) === 1 ? '' : 's') . '.');
                adminAudit('payment_reconcile_csv', $result['file'], $result['rows'] . ' rows, ' . count($result['mismatches']) . ' mismatches');
            }
            $redirect = PAY_ADMIN_BASE . '?view=reconcile';
        }
    } elseif ($action === 'clear_csv') {
        requireAdminCan('payments.manage');
        unset($_SESSION['pay_csv']);
        payFlash('success', 'The uploaded report comparison was cleared.');
        $redirect = PAY_ADMIN_BASE . '?view=reconcile';
    } else {
        payFlash('error', 'That action is not available on this page.');
    }
    header('Location: ' . $redirect, true, 303);
    exit;
}

// ── Filters and the view being shown ─────────────────────────────────────────
$str     = static fn(string $k): string => is_scalar($_GET[$k] ?? null) ? trim((string) $_GET[$k]) : '';
$view    = isset(PAY_ADMIN_VIEWS[$str('view')]) ? $str('view') : 'overview';
$number  = $str('number');
$filters = payAdminFilters($_GET);
$page    = max(1, (int) $str('page'));

// ── CSV export of the filtered transactions (viewers may export) ─────────────
if ($tables && $str('export') === 'csv' && adminCan('export')) {
    $rows = payAdminExportRows($db, $filters);
    adminAudit('payment_export', 'payments.csv', count($rows) . ' rows');
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="payments-' . date('Y-m-d') . '.csv"');
    header('Cache-Control: no-store');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF"); // BOM so Excel reads Tamil correctly
    // Empty escape string = strict RFC 4180, as the other admin exports use.
    fputcsv($out, payAdminCsvHeader(), ',', '"', '');
    foreach ($rows as $row) fputcsv($out, $row, ',', '"', '');
    fclose($out);
    exit;
}

// ── Flash from the previous request ──────────────────────────────────────────
$msg = '';
if (!empty($_SESSION['flash_payments'])) {
    [$fType, $fText] = $_SESSION['flash_payments'];
    unset($_SESSION['flash_payments']);
    $tone = in_array($fType, ['success', 'warning', 'error'], true) ? $fType : 'success';
    $msg  = '<p class="alert alert--' . $tone . '" role="' . ($tone === 'success' ? 'status' : 'alert') . '">' . h($fText) . '</p>';
}

$detail = null;
if ($tables && $number !== '') {
    $detail = payAdminDetail($db, $number);
    if ($detail === null) $msg .= '<p class="alert alert--warning" role="status">That payment number was not found.</p>';
}

$headerActions = '';
if ($tables && adminCan('payments.settings')) {
    $headerActions .= '<a href="/admin/payment_settings.php" class="btn btn-ghost btn--sm">' . adminIcon('shield') . 'Payment Gateway</a>';
}
adminHeader('Online Payments', 'Devotees', ['actions' => $headerActions, 'wide' => true]);
echo $msg;

if (!$tables) {
    echo adminEmpty(
        'landmark',
        'Online payments are not installed yet',
        'Apply database migration 010_payments.sql, then turn payments on in Admin → Payment Gateway. Until then donors can still pledge on the Donations page and pay at the temple.',
        adminCan('payments.settings') ? '<a href="/admin/payment_settings.php" class="btn btn-primary btn--sm">' . adminIcon('shield') . 'Payment Gateway</a>' : ''
    );
    adminFooter();
    exit;
}

$ready = payReady();

// ── Detail view ──────────────────────────────────────────────────────────────
if ($detail !== null):
    $p          = $detail['payable'];
    $isDonation = $p['type'] === 'donation';
    $showPan    = ($_SESSION['pay_show_pan'] ?? null) === $p['number'] && $canManage && ($p['pan'] ?? '') !== '';
    unset($_SESSION['pay_show_pan']);
    $startedAt  = $p['attempts'][0]['created_at'] ?? null;
    $purpose    = $isDonation ? (string) ($p['category']['en'] ?? $p['purpose'] ?? '—') : 'Seva: ' . (string) ($p['seva']['en'] ?? $p['seva_name'] ?? '');
    $addr       = array_filter([$p['address']['line'] ?? null, $p['address']['city'] ?? null, $p['address']['state'] ?? null, $p['address']['postcode'] ?? null]);
    $countryCode = (string) ($p['country'] ?? $p['phone_country'] ?? '');
    $receiptAttemptId = (int) ($p['receipt_attempt_id'] ?? 0);
    // Refunds by attempt: SUCCESS amounts and open requests, so each attempt row can say what was given back against it.
    $refundedByAttempt = [];
    $openRefundsByAttempt = [];
    foreach ($detail['refunds'] as $rf) {
        if ($rf['status'] === 'SUCCESS') $refundedByAttempt[$rf['transaction_id']] = ($refundedByAttempt[$rf['transaction_id']] ?? 0) + payAmountCents((string) $rf['amount']);
        if (in_array($rf['status'], ['REQUESTED', 'PROCESSING'], true)) $openRefundsByAttempt[$rf['transaction_id']] = ($openRefundsByAttempt[$rf['transaction_id']] ?? 0) + 1;
    }
?>
<div class="pay-detail">
  <p class="pay-detail__back"><a href="<?= PAY_ADMIN_BASE ?>?view=transactions" class="btn btn-ghost btn--sm"><?= adminIcon('arrow-left') ?> All payments</a></p>

  <div class="dash-grid">
    <section class="card card--static" aria-labelledby="pay-money-title">
      <div class="card__head">
        <h2 id="pay-money-title"><?= adminIcon('banknote', 'ico--sm') ?> <?= h($p['number']) ?></h2>
        <?= payAdminStatusBadge($p['status']) ?>
      </div>
      <div class="card__body">
        <dl class="dl-grid">
          <dt>Amount</dt><dd class="cell-money"><?= h(payAdminMoney($p['amount'], $p['currency'])) ?></dd>
          <dt>Currency</dt><dd><?= h($p['currency']) ?></dd>
          <?php if (payAmountCents($p['amount_refunded']) > 0): ?>
            <dt>Refunded</dt><dd class="cell-money"><?= h(payAdminMoney($p['amount_refunded'], $p['currency'])) ?></dd>
          <?php endif; ?>
          <dt><?= $isDonation ? 'Purpose' : 'Seva' ?></dt><dd><?= h($purpose) ?></dd>
          <?php if (!$isDonation): ?>
            <dt>Preferred date</dt><dd><?= h($p['preferred_date'] ? adminFmtDate($p['preferred_date']) : 'To be confirmed') ?></dd>
            <dt>Booking status</dt><dd><?= adminBadge(ucfirst((string) $p['booking_status']), adminStatusTone((string) $p['booking_status'])) ?></dd>
          <?php endif; ?>
          <dt>Receipt number</dt><dd><?= $p['receipt_number'] ? h($p['receipt_number']) : '<span class="text-muted">Not issued yet</span>' ?></dd>
          <dt>Started</dt><dd><?= payAdminTimeTag($startedAt) ?></dd>
          <dt>Paid</dt><dd><?= payAdminTimeTag($p['paid_at']) ?></dd>
        </dl>
        <div class="cluster mt-4">
          <?php if (!empty($detail['links']['receipt'])): ?>
            <a class="btn btn--sm" href="<?= h($detail['links']['receipt']) ?>" target="_blank" rel="noopener"><?= adminIcon('external') ?> Open receipt</a>
          <?php endif; ?>
          <a class="btn btn-ghost btn--sm" href="<?= h($detail['links']['result']) ?>" target="_blank" rel="noopener"><?= adminIcon('external') ?> Open result page</a>
          <?php if (!$isDonation): ?>
            <a class="btn btn-ghost btn--sm" href="/admin/seva_bookings.php?q=<?= rawurlencode($p['number']) ?>"><?= adminIcon('clipboard') ?> Open booking</a>
          <?php endif; ?>
        </div>
        <?php if ($canManage && in_array($p['status'], PAY_PAID_STATUSES, true)): ?>
        <form method="POST" action="<?= PAY_ADMIN_BASE ?>" class="cluster mt-4">
          <?= csrfField() ?>
          <input type="hidden" name="action" value="resend_receipt" />
          <input type="hidden" name="number" value="<?= h($p['number']) ?>" />
          <button type="submit" class="btn btn--sm"
                  data-confirm="Send the receipt for <?= h($p['number']) ?> to <?= h($p['name']) ?> again?" data-confirm-label="Send receipt">
            <?= adminIcon('mail') ?> Resend receipt
          </button>
          <span class="field__hint">Goes out on the channels switched on in Payment Gateway.</span>
        </form>
        <?php endif; ?>
        <?php if ($p['status'] === 'REFUNDED' && !$isDonation && $p['booking_status'] !== 'cancelled'): ?>
          <p class="callout mt-4"><?= adminIcon('info') ?> This booking has been refunded in full. Also cancel the booking?
            <a href="/admin/seva_bookings.php?q=<?= rawurlencode($p['number']) ?>">Open it in Seva Bookings</a>.</p>
        <?php endif; ?>
      </div>
    </section>

    <section class="card card--static" aria-labelledby="pay-donor-title">
      <div class="card__head">
        <h2 id="pay-donor-title"><?= adminIcon('user', 'ico--sm') ?> Donor</h2>
        <?= adminBadge($isDonation ? 'Donation' : 'Seva booking', $isDonation ? 'gold' : 'info') ?>
      </div>
      <div class="card__body">
        <dl class="dl-grid">
          <dt>Name</dt><dd><?= h($p['name']) ?></dd>
          <dt>Phone</dt><dd><a href="tel:<?= h(preg_replace('/[^\d+]/', '', '+' . $p['phone'])) ?>"><?= h($p['phone']) ?></a></dd>
          <dt>Email</dt><dd><?= $p['email'] ? '<a href="mailto:' . h($p['email']) . '">' . h($p['email']) . '</a>' : '<span class="text-muted">—</span>' ?></dd>
          <dt>Country</dt><dd><?= $countryCode !== '' ? h(payAdminCountryName($countryCode)) . ' <span class="text-muted tabular">' . h($countryCode) . '</span>' : '<span class="text-muted">—</span>' ?></dd>
          <?php if ($addr): ?><dt>Address</dt><dd><?= h(implode(', ', $addr)) ?></dd><?php endif; ?>
          <?php if ($isDonation): ?>
          <dt>PAN</dt>
          <dd>
            <?php if (($p['pan'] ?? '') === ''): ?>
              <span class="text-muted">—</span>
            <?php elseif ($showPan): ?>
              <span class="tabular"><?= h($p['pan']) ?></span> <span class="field__hint">Shown once; the viewing is in the activity log.</span>
            <?php else: ?>
              <span class="tabular"><?= h(payMaskPan($p['pan'])) ?></span>
              <?php if ($canManage): ?>
                <form method="POST" action="<?= PAY_ADMIN_BASE ?>" class="cluster">
                  <?= csrfField() ?>
                  <input type="hidden" name="action" value="show_pan" />
                  <input type="hidden" name="number" value="<?= h($p['number']) ?>" />
                  <button type="submit" class="btn btn-ghost btn--xs"><?= adminIcon('eye') ?> Show</button>
                </form>
              <?php endif; ?>
            <?php endif; ?>
          </dd>
          <dt>Thank-you list</dt><dd><?= $p['show_name_publicly'] ? adminBadge('Shown', 'success') : adminBadge('Not shown', 'muted') ?></dd>
          <?php endif; ?>
          <dt>Language</dt><dd><?= $p['lang'] === 'ta' ? 'Tamil' : 'English' ?></dd>
          <?php if (trim((string) $p['message']) !== ''): ?><dt>Message</dt><dd><?= h($p['message']) ?></dd><?php endif; ?>
          <?php if (trim((string) ($p['notes'] ?? '')) !== ''): ?><dt>Note for the office</dt><dd><?= h($p['notes']) ?></dd><?php endif; ?>
        </dl>
      </div>
    </section>
  </div>

  <section class="card card--static mt-6" aria-labelledby="pay-attempts-title">
    <div class="card__head">
      <h2 id="pay-attempts-title"><?= adminIcon('repeat', 'ico--sm') ?> Attempts</h2>
      <?php if ($canManage): ?>
      <form method="POST" action="<?= PAY_ADMIN_BASE ?>">
        <?= csrfField() ?>
        <input type="hidden" name="action" value="check_now" />
        <input type="hidden" name="number" value="<?= h($p['number']) ?>" />
        <button type="submit" class="btn btn--sm"><?= adminIcon('refresh') ?> Check with CCAvenue now</button>
      </form>
      <?php endif; ?>
    </div>
    <div class="table-wrap table-wrap--flush" tabindex="0" role="region" aria-labelledby="pay-attempts-title">
      <table class="table" data-no-search>
        <thead>
          <tr>
            <th scope="col">Order ID</th><th scope="col">Mode</th><th scope="col" class="num">Amount</th>
            <th scope="col">Status</th><th scope="col">CCAvenue</th><th scope="col">Reference</th>
            <th scope="col">Method</th><th scope="col">Checked</th><th scope="col">Started</th>
            <?php if ($canManage): ?><th scope="col"><span class="sr-only">Actions</span></th><?php endif; ?>
          </tr>
        </thead>
        <tbody>
        <?php foreach ($p['attempts'] as $a): ?>
          <?php
            $isReceiptAttempt = $a['status'] === 'SUCCESS' && (int) $a['id'] === $receiptAttemptId;
            $isExtraPayment   = $a['status'] === 'SUCCESS' && !$isReceiptAttempt;
            $attemptRefunded  = (int) ($refundedByAttempt[$a['id']] ?? 0);
            $attemptOpen      = (int) ($openRefundsByAttempt[$a['id']] ?? 0);
          ?>
          <tr<?= $a['needs_review'] ? ' class="is-flagged"' : '' ?>>
            <td><span class="cell-title tabular"><?= h($a['order_id']) ?></span><span class="cell-sub">Attempt <?= (int) $a['attempt'] ?> · <?= h($a['verification']) ?><?= $isReceiptAttempt ? ' · the receipt' : ($isExtraPayment ? ' · extra payment' : '') ?></span></td>
            <td><?= adminBadge(strtoupper((string) $a['environment']), $a['environment'] === 'production' ? 'success' : ($a['environment'] === 'simulator' ? 'danger' : 'warning')) ?></td>
            <td class="num cell-money"><?= h(payAdminMoney($a['amount'], $a['currency'])) ?></td>
            <td><?= payAdminStatusBadge($a['status'], $a['needs_review']) ?>
                <?php if ($attemptRefunded > 0): ?><span class="cell-sub"><?= $attemptRefunded >= payAmountCents((string) $a['amount']) ? 'Refunded in full' : h(payAdminMoney(payCentsToAmount($attemptRefunded), $a['currency'])) . ' refunded' ?></span><?php endif; ?>
                <?php if ($attemptOpen > 0): ?><span class="cell-sub">Refund waiting for CCAvenue</span><?php endif; ?></td>
            <td><?= $a['gateway_status'] ? h($a['gateway_status']) : '<span class="text-muted">—</span>' ?>
                <?php if ($a['failure_message']): ?><span class="cell-sub"><?= h($a['failure_message']) ?></span><?php endif; ?></td>
            <td><span class="tabular"><?= $a['tracking_id'] ? h($a['tracking_id']) : '—' ?></span>
                <?php if ($a['bank_ref_no']): ?><span class="cell-sub tabular"><?= h($a['bank_ref_no']) ?></span><?php endif; ?></td>
            <td><?= $a['payment_mode'] ? h($a['payment_mode']) : '<span class="text-muted">—</span>' ?></td>
            <td class="cell-date"><?= payAdminTimeTag($a['last_checked_at']) ?><span class="cell-sub"><?= (int) $a['response_count'] ?> response<?= (int) $a['response_count'] === 1 ? '' : 's' ?></span></td>
            <td class="cell-date"><?= payAdminTimeTag($a['created_at']) ?></td>
            <?php if ($canManage): ?>
            <td class="cell-actions">
              <?php if ($a['needs_review']): ?>
              <form method="POST" action="<?= PAY_ADMIN_BASE ?>" class="pay-review">
                <?= csrfField() ?>
                <input type="hidden" name="action" value="mark_reviewed" />
                <input type="hidden" name="number" value="<?= h($p['number']) ?>" />
                <input type="hidden" name="transaction_id" value="<?= (int) $a['id'] ?>" />
                <label class="sr-only" for="note-<?= (int) $a['id'] ?>">What did you check on <?= h($a['order_id']) ?>?</label>
                <input id="note-<?= (int) $a['id'] ?>" type="text" name="note" maxlength="500" required aria-required="true" placeholder="What did you check?" />
                <button type="submit" class="btn btn--xs"><?= adminIcon('check') ?> Mark reviewed</button>
              </form>
              <?php else: ?>
                <span class="text-muted">—</span>
              <?php endif; ?>
            </td>
            <?php endif; ?>
          </tr>
        <?php endforeach; ?>
        </tbody>
      </table>
    </div>
  </section>

  <section class="card card--static mt-6" aria-labelledby="pay-refunds-title">
    <div class="card__head">
      <h2 id="pay-refunds-title"><?= adminIcon('undo', 'ico--sm') ?> Refunds</h2>
      <span class="text-xs text-muted"><?= count($detail['refunds']) ?> recorded</span>
    </div>
    <?php if ($detail['refunds']): ?>
    <div class="table-wrap table-wrap--flush" tabindex="0" role="region" aria-labelledby="pay-refunds-title">
      <table class="table" data-no-search>
        <thead><tr><th scope="col">Reference</th><th scope="col" class="num">Amount</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col">How</th><th scope="col">Reason</th><th scope="col">Requested</th><?php if ($canRefund): ?><th scope="col"><span class="sr-only">Actions</span></th><?php endif; ?></tr></thead>
        <tbody>
        <?php foreach ($detail['refunds'] as $r): $open = in_array($r['status'], ['REQUESTED', 'PROCESSING'], true); ?>
          <tr>
            <td><span class="cell-title tabular"><?= h($r['refund_reference']) ?></span><span class="cell-sub tabular"><?= h($r['order_id']) ?></span></td>
            <td class="num cell-money"><?= h(payAdminMoney($r['amount'], $r['currency'])) ?></td>
            <td><?= h(ucfirst((string) $r['kind'])) ?></td>
            <td><?= adminBadge(ucfirst(strtolower((string) $r['status'])), ['SUCCESS' => 'success', 'FAILED' => 'danger', 'PROCESSING' => 'info'][$r['status']] ?? 'warning') ?>
                <?php if ($r['gateway_message']): ?><span class="cell-sub"><?= h($r['gateway_message']) ?></span><?php endif; ?></td>
            <td><?= $r['method'] === 'manual' ? 'Recorded by the office' : 'Sent to CCAvenue' ?></td>
            <td><span class="cell-clip"><?= h($r['reason']) ?></span></td>
            <td class="cell-date"><?= payAdminTimeTag($r['created_at']) ?><span class="cell-sub"><?= h($r['requested_by']) ?></span></td>
            <?php if ($canRefund): ?>
            <td class="cell-actions">
              <?php if ($open && $r['method'] === 'gateway_api'): ?>
                <form method="POST" action="<?= PAY_ADMIN_BASE ?>" class="cluster">
                  <?= csrfField() ?>
                  <input type="hidden" name="action" value="refund_check" />
                  <input type="hidden" name="number" value="<?= h($p['number']) ?>" />
                  <input type="hidden" name="refund_id" value="<?= (int) $r['id'] ?>" />
                  <button type="submit" class="btn btn--xs"><?= adminIcon('refresh') ?> Check again</button>
                </form>
                <form method="POST" action="<?= PAY_ADMIN_BASE ?>" class="pay-review">
                  <?= csrfField() ?>
                  <input type="hidden" name="action" value="refund_fail" />
                  <input type="hidden" name="number" value="<?= h($p['number']) ?>" />
                  <input type="hidden" name="refund_id" value="<?= (int) $r['id'] ?>" />
                  <label class="sr-only" for="fail-<?= (int) $r['id'] ?>">Why did refund <?= h($r['refund_reference']) ?> fail?</label>
                  <input id="fail-<?= (int) $r['id'] ?>" type="text" name="reason" maxlength="255" required aria-required="true" placeholder="Why did it fail?" />
                  <button type="submit" class="btn btn-ghost btn--xs"
                          data-confirm="Mark refund <?= h($r['refund_reference']) ?> as failed? Do this only after checking the CCAvenue dashboard."
                          data-confirm-label="Mark as failed"><?= adminIcon('x') ?> Mark as failed</button>
                </form>
              <?php else: ?>
                <span class="text-muted">—</span>
              <?php endif; ?>
            </td>
            <?php endif; ?>
          </tr>
        <?php endforeach; ?>
        </tbody>
      </table>
    </div>
    <?php else: ?>
      <div class="card__body"><?= adminEmpty('undo', 'No refunds', 'Nothing has been given back for this payment.', '', true) ?></div>
    <?php endif; ?>

    <?php
    $refundable = array_filter($detail['refundable'], static fn(string $a): bool => payAmountCents($a) > 0);
    if ($canRefund && $refundable):
        // The receipt attempt first; a double payment's extra attempt(s) after it.
        uksort($refundable, static fn(int $x, int $y): int => ($x === $receiptAttemptId ? 0 : 1) <=> ($y === $receiptAttemptId ? 0 : 1) ?: $x <=> $y);
        $attemptId  = (int) array_key_first($refundable);
        $left       = $refundable[$attemptId];
        $viaApi     = !empty($detail['api_refund'][$attemptId]);
        $confirmSum = payAdminMoney($left, $p['currency']);
        $byId       = array_column($p['attempts'], null, 'id');
    ?>
    <div class="card__body pay-refund-form">
      <h3 class="subhead"><?= adminIcon('undo', 'ico--sm') ?> Refund this payment</h3>
      <form method="POST" action="<?= PAY_ADMIN_BASE ?>" data-number="<?= h($p['number']) ?>" data-donor="<?= h($p['name']) ?>" data-currency="<?= h($p['currency']) ?>">
        <?= csrfField() ?>
        <input type="hidden" name="action" value="refund" />
        <input type="hidden" name="number" value="<?= h($p['number']) ?>" />
        <?php if (count($refundable) > 1): ?>
          <label for="refund-attempt">
            <span class="field__label">Which payment</span>
            <select id="refund-attempt" name="transaction_id">
              <?php foreach ($refundable as $id => $amount): $isReceipt = (int) $id === $receiptAttemptId; ?>
                <option value="<?= (int) $id ?>" data-left="<?= h($amount) ?>"><?= h((string) ($byId[$id]['order_id'] ?? $id)) ?> — <?= h(payAdminMoney($amount, $p['currency'])) ?> left · <?= $isReceipt ? 'the receipt' : 'extra payment' ?></option>
              <?php endforeach; ?>
            </select>
            <span class="field__hint">This was paid more than once. Refund the extra payment; the receipt's own payment is refunded only if the gift itself is being returned.</span>
          </label>
        <?php else: ?>
          <input type="hidden" name="transaction_id" value="<?= $attemptId ?>" data-left="<?= h($left) ?>" />
        <?php endif; ?>
        <p class="field__hint"><span id="refund-left"><?= h(payAdminMoney($left, $p['currency'])) ?></span> of <?= h(payAdminMoney($p['amount'], $p['currency'])) ?> can still be given back.</p>

        <fieldset>
          <legend class="field__label">How much</legend>
          <label class="choice"><input type="radio" name="kind" value="full" checked /> <span>Full — <span id="refund-full-amount"><?= h(payAdminMoney($left, $p['currency'])) ?></span></span></label>
          <label class="choice"><input type="radio" name="kind" value="partial" /> <span>Part of it</span></label>
          <label for="refund-amount">
            <span class="field__label">Partial amount</span>
            <input id="refund-amount" type="text" name="amount" inputmode="decimal" maxlength="13" autocomplete="off" placeholder="e.g. 250.50" />
            <span class="field__hint">Typing an amount chooses “Part of it”. Never more than <span id="refund-max"><?= h(payAdminMoney($left, $p['currency'])) ?></span>.</span>
          </label>
        </fieldset>

        <label for="refund-reason">
          <span class="field__label">Reason <span class="field__required" aria-hidden="true">*</span></span>
          <textarea id="refund-reason" name="reason" rows="2" minlength="5" maxlength="500" required aria-required="true" data-counter placeholder="Why is this money being returned?"></textarea>
        </label>

        <input type="hidden" name="method" value="<?= $viaApi ? 'gateway_api' : 'manual' ?>" />
        <?php if ($viaApi): ?>
          <p class="callout"><?= adminIcon('info') ?> Sent to CCAvenue automatically. The money returns to the donor's original payment method, usually in 5–7 working days.</p>
        <?php else: ?>
          <p class="callout"><?= adminIcon('alert') ?> Record a refund you have already made in the CCAvenue dashboard. This site cannot send it: the CCAvenue API is not configured for this payment's environment, or the payment has no CCAvenue reference.</p>
          <label for="refund-gref">
            <span class="field__label">CCAvenue refund reference <span class="field__optional">optional</span></span>
            <input id="refund-gref" type="text" name="gateway_reference" maxlength="60" autocomplete="off" />
          </label>
          <label class="switch">
            <input type="checkbox" name="confirm_manual" value="1" required aria-required="true" />
            <span class="switch__track" aria-hidden="true"></span>
            <span class="switch__label"><strong>I have already refunded this in the CCAvenue dashboard</strong><span class="switch__desc">Recording it here does not move any money.</span></span>
          </label>
        <?php endif; ?>

        <div class="form-actions">
          <button type="submit" class="btn btn-danger"
                  data-confirm="Refund <?= h($confirmSum) ?> of <?= h($p['number']) ?> to <?= h($p['name']) ?>? This cannot be undone."
                  data-confirm-label="Refund"><?= adminIcon('undo') ?> Refund</button>
        </div>
      </form>
    </div>
    <script>
    // The confirmation sentence says exactly what will be refunded: the chosen
    // attempt's remaining amount for "Full", the typed amount for "Part of it".
    // Typing an amount chooses "Part of it", so a figure is never silently
    // ignored in favour of a full refund. admin.js reads data-confirm when the
    // button is pressed, and the browser's own validation runs before the dialog.
    (function () {
      var form = document.querySelector('.pay-refund-form form');
      if (!form) return;
      var btn = form.querySelector('button[type="submit"][data-confirm]');
      var amount = form.querySelector('#refund-amount');
      var partial = form.querySelector('input[name="kind"][value="partial"]');
      var currency = form.dataset.currency || 'INR';
      var decimals = currency === 'JPY' ? 0 : 2;
      function chosen() {
        var t = form.querySelector('[name="transaction_id"]');
        if (!t) return '';
        var el = t.tagName === 'SELECT' ? t.options[t.selectedIndex] : t;
        return el && el.dataset.left ? el.dataset.left : '';
      }
      function money(v) {
        var text = String(v).trim();
        var n = Number(text);
        if (text === '' || !isFinite(n)) return text === '' ? 'the amount' : text;
        var s = n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
        return currency === 'INR' ? '₹' + s : currency + ' ' + s;
      }
      function update() {
        var kind = (form.querySelector('input[name="kind"]:checked') || {}).value;
        var left = chosen();
        ['refund-full-amount', 'refund-left', 'refund-max'].forEach(function (id) {
          var el = document.getElementById(id);
          if (el) el.textContent = money(left);
        });
        amount.required = kind === 'partial';
        btn.dataset.confirm = 'Refund ' + money(kind === 'partial' ? amount.value : left) + ' of ' + form.dataset.number + ' to ' + form.dataset.donor + '? This cannot be undone.';
      }
      amount.addEventListener('input', function () {
        if (amount.value.trim() !== '' && partial && !partial.checked) partial.checked = true;
        update();
      });
      form.querySelectorAll('input[name="kind"], [name="transaction_id"]').forEach(function (el) { el.addEventListener('change', update); });
      btn.addEventListener('click', function (e) {
        update();
        if (!form.reportValidity()) { e.preventDefault(); e.stopImmediatePropagation(); }
      });
      update();
    })();
    </script>
    <?php elseif ($canRefund && in_array($p['status'], PAY_REFUNDABLE_STATUSES, true)): ?>
      <div class="card__body"><p class="field__hint">Nothing is left to refund on this payment.</p></div>
    <?php endif; ?>
  </section>

  <section class="card card--static mt-6" aria-labelledby="pay-audit-title">
    <div class="card__head">
      <h2 id="pay-audit-title"><?= adminIcon('history', 'ico--sm') ?> History</h2>
      <span class="text-xs text-muted"><?= count($detail['audit']) ?> entries · newest first</span>
    </div>
    <div class="table-wrap table-wrap--flush" tabindex="0" role="region" aria-labelledby="pay-audit-title">
      <table class="table" data-no-search>
        <thead><tr><th scope="col">Time (IST)</th><th scope="col">Event</th><th scope="col">What happened</th><th scope="col">By</th></tr></thead>
        <tbody>
        <?php foreach ($detail['audit'] as $row): ?>
          <tr>
            <td class="cell-date"><?= payAdminTimeTag($row['created_at']) ?></td>
            <td><?= adminBadge(payAdminEventLabel((string) $row['event']), str_contains((string) $row['event'], 'refund') ? 'info' : (str_contains((string) $row['event'], 'mismatch') || str_contains((string) $row['event'], 'error') ? 'danger' : 'muted')) ?></td>
            <td><?= h((string) ($row['detail'] ?? '')) ?></td>
            <td><span class="cell-sub"><?= h((string) $row['actor']) ?></span></td>
          </tr>
        <?php endforeach; ?>
        </tbody>
      </table>
    </div>
  </section>
</div>
<?php
    adminFooter();
    exit;
endif;

// ── Tabs ─────────────────────────────────────────────────────────────────────
$tabQuery = array_filter([
    'q' => $filters['q'], 'country' => $filters['country'], 'status' => $filters['status'], 'purpose' => $filters['purpose'],
    'currency' => $filters['currency'], 'kind' => $filters['kind'], 'review' => $filters['review'] ? '1' : '',
    'from' => $filters['from'], 'to' => $filters['to'], 'sort' => $filters['sort'], 'dir' => $filters['dir'],
], static fn($v): bool => $v !== '' && $v !== null);

echo adminPageIntro(
    'Every donation and seva booking paid online through CCAvenue: what came in, what failed, what was given back, and what still needs looking at. Money figures are IST calendar periods and are net of refunds.',
    ($ready['ok'] ? adminBadge('Payments are live', 'success') : adminBadge('Not taking payments', 'muted'))
    . (adminCan('export') ? '<a href="' . h(PAY_ADMIN_BASE . adminQuery($tabQuery, ['export' => 'csv', 'view' => null, 'page' => null])) . '" class="btn btn-primary btn--sm">' . adminIcon('download') . 'Export CSV</a>' : '')
);
if (!$ready['ok']) {
    echo '<p class="alert alert--warning" role="status" data-keep>' . h($ready['reason'])
        . (adminCan('payments.settings') ? ' <a href="/admin/payment_settings.php">Open Payment Gateway</a>' : '') . '</p>';
}
?>

<nav class="filter-chips" aria-label="Payment views">
  <?php foreach (PAY_ADMIN_VIEWS as $key => $label): ?>
    <a class="chip" href="<?= h(PAY_ADMIN_BASE . adminQuery($tabQuery, ['view' => $key === 'overview' ? null : $key, 'page' => null])) ?>"<?= $view === $key ? ' aria-current="page"' : '' ?>><?= h($label) ?></a>
  <?php endforeach; ?>
</nav>

<?php
// ── Overview ─────────────────────────────────────────────────────────────────
if ($view === 'overview'):
    $k = payAdminKpis($db, ['kind' => $filters['kind']]);
    $kindLabels = ['' => 'All', 'donation' => 'Donations', 'seva_booking' => 'Seva bookings'];
?>
<nav class="filter-chips mt-4" aria-label="What to count">
  <?php foreach ($kindLabels as $key => $label): ?>
    <a class="chip" href="<?= h(PAY_ADMIN_BASE . adminQuery($tabQuery, ['kind' => $key === '' ? null : $key, 'view' => null, 'page' => null])) ?>"<?= $filters['kind'] === $key ? ' aria-current="page"' : '' ?>><?= h($label) ?></a>
  <?php endforeach; ?>
</nav>

<?php
/** "3 payments · also USD 120.00" under a money KPI. */
$countSub = static function (array $block, string $noun = 'payment'): string {
    $n    = (int) $block['count'];
    $line = $n . ' ' . $noun . ($n === 1 ? '' : 's');
    $more = payAdminOthers($block);
    return $more !== '' ? $line . ' · ' . $more : $line;
};
// KPI money is whole rupees (as the dashboard and Donations show it) so a big
// figure still fits its card; the paise are in the tables and the CSV.
$kpiMoney = static fn(string $amount): string => adminFmtMoney(payAmountCents($amount) / 100);
echo adminKpi([
    ['label' => 'Received (all time)', 'value' => $kpiMoney($k['received']['total']['inr']), 'icon' => 'banknote', 'variant' => 'accent', 'sub' => $countSub($k['received']['total'])],
    ['label' => 'Today',      'value' => $kpiMoney($k['received']['today']['inr']), 'icon' => 'clock',    'sub' => $countSub($k['received']['today'])],
    ['label' => 'This month', 'value' => $kpiMoney($k['received']['month']['inr']), 'icon' => 'trending', 'sub' => $countSub($k['received']['month'])],
    ['label' => 'This year',  'value' => $kpiMoney($k['received']['year']['inr']),  'icon' => 'calendar', 'sub' => $countSub($k['received']['year'])],
]);
echo adminKpi([
    ['label' => 'Successful', 'value' => $k['successful'], 'icon' => 'check-circle', 'href' => PAY_ADMIN_BASE . adminQuery($tabQuery, ['view' => 'transactions', 'status' => 'SUCCESS']), 'sub' => 'Receipts issued'],
    ['label' => 'Failed',     'value' => $k['failed'],     'icon' => 'x-circle',     'href' => PAY_ADMIN_BASE . adminQuery($tabQuery, ['view' => 'transactions', 'status' => 'FAILED']),  'sub' => 'Payments that did not complete'],
    ['label' => 'Pending',    'value' => $k['pending'],    'icon' => 'clock',        'href' => PAY_ADMIN_BASE . adminQuery($tabQuery, ['view' => 'transactions', 'status' => PAY_ADMIN_STATUS_OPEN]), 'sub' => 'Started or awaiting the bank'],
    ['label' => 'Refunded',   'value' => $kpiMoney($k['refunded']['inr']), 'icon' => 'undo', 'href' => PAY_ADMIN_BASE . adminQuery($tabQuery, ['view' => 'refunds']), 'sub' => $countSub($k['refunded'], 'refund')],
    ['label' => 'Domestic',      'value' => $kpiMoney($k['domestic']['inr']),      'icon' => 'house', 'sub' => $k['domestic']['count'] . ' from India'],
    ['label' => 'International', 'value' => $kpiMoney($k['international']['inr']), 'icon' => 'globe', 'sub' => $k['international']['count'] . ' from abroad'],
]);
$series = array_map(static fn(array $m): array => [
    'label' => substr($m['label'], 0, 3),
    'value' => (float) $m['inr'],
    'hint'  => $m['label'] . ' · ' . payAdminMoney($m['inr'], 'INR'),
], $k['monthly']);
$shareTones = ['gold', 'maroon', 'moon', 'sage', 'info', 'warning', 'danger'];
$shares = [];
foreach ($k['shares'] as $i => $s) {
    $shares[] = ['label' => $s['label'], 'value' => (float) $s['inr'], 'hint' => payAdminMoney($s['inr'], 'INR'), 'tone' => $shareTones[$i % count($shareTones)]];
}
$attention = $k['attention'];
?>

<div class="dash-grid">
  <section class="card card--static" aria-labelledby="pay-chart-title">
    <div class="card__head"><h2 id="pay-chart-title"><?= adminIcon('trending', 'ico--sm') ?> Received · last 12 months (₹)</h2></div>
    <div class="card__body">
      <?php if ($k['received']['total']['count'] > 0): ?>
        <?= adminBars($series, 'Online payments received by month') ?>
      <?php else: ?>
        <?= adminEmpty('banknote', 'No online payments yet', 'Once a devotee pays on the website, the money shows here by month.', '', true) ?>
      <?php endif; ?>
    </div>
  </section>

  <div class="stack stack--lg">
    <section class="card card--static" aria-labelledby="pay-attention-title">
      <div class="card__head"><h2 id="pay-attention-title"><?= adminIcon('alert', 'ico--sm') ?> Needs attention</h2></div>
      <div class="card__body">
        <dl class="dl-grid">
          <dt>Flagged for review</dt>
          <dd><a href="<?= h(PAY_ADMIN_BASE . '?view=reconcile') ?>"><?= (int) $attention['needs_review'] ?></a></dd>
          <dt>Open longer than 3 hours</dt>
          <dd><a href="<?= h(PAY_ADMIN_BASE . '?view=reconcile') ?>"><?= (int) $attention['stale_open'] ?></a></dd>
          <dt>Refunds waiting</dt>
          <dd><a href="<?= h(PAY_ADMIN_BASE . '?view=refunds') ?>"><?= (int) $attention['refunds_waiting'] ?></a></dd>
        </dl>
        <?php if (array_sum(array_map('intval', $attention)) === 0): ?>
          <p class="field__hint mt-2">Nothing needs looking at.</p>
        <?php endif; ?>
      </div>
    </section>

    <?php if ($shares): ?>
    <section class="card card--static" aria-labelledby="pay-shares-title">
      <div class="card__head"><h2 id="pay-shares-title"><?= adminIcon('banknote', 'ico--sm') ?> Received by purpose (₹)</h2></div>
      <div class="card__body"><?= adminShares($shares, 'Online payments by purpose') ?></div>
    </section>
    <?php endif; ?>
  </div>
</div>

<?php
// ── Transactions ─────────────────────────────────────────────────────────────
elseif ($view === 'transactions'):
    $list       = payAdminList($db, $filters, $page, PAY_ADMIN_PER_PAGE);
    $countries  = payAdminCountries($db);
    $categories = payCategoriesAll($db);
    $sortQuery  = $tabQuery + ['view' => 'transactions'];
    $hasFilters = $filters['q'] !== '' || $filters['country'] !== '' || $filters['from'] !== '' || $filters['to'] !== ''
        || $filters['status'] !== '' || $filters['purpose'] !== '' || $filters['currency'] !== '' || $filters['kind'] !== '' || $filters['review'];
?>
<form method="GET" action="<?= PAY_ADMIN_BASE ?>" class="toolbar mt-4" role="search" aria-label="Filter payments">
  <input type="hidden" name="view" value="transactions" />
  <input type="hidden" name="sort" value="<?= h($filters['sort']) ?>" />
  <input type="hidden" name="dir" value="<?= h($filters['dir']) ?>" />
  <div class="toolbar__search">
    <?= adminIcon('search') ?>
    <label class="sr-only" for="f-q">Search payments</label>
    <input id="f-q" type="search" name="q" value="<?= h($filters['q']) ?>" placeholder="Donation ID, CCAvenue reference, name, phone or email…" autocomplete="off" />
  </div>
  <div class="toolbar__group">
    <label for="f-status">Status
      <select id="f-status" name="status">
        <option value="">Any status</option>
        <option value="<?= h(PAY_ADMIN_STATUS_OPEN) ?>"<?= $filters['status'] === PAY_ADMIN_STATUS_OPEN ? ' selected' : '' ?>>Open (initiated or pending)</option>
        <?php foreach (PAY_PAYABLE_STATUSES as $s): ?>
          <option value="<?= h($s) ?>"<?= $filters['status'] === $s ? ' selected' : '' ?>><?= h(payStatusLabel($s)) ?></option>
        <?php endforeach; ?>
      </select>
    </label>
    <label for="f-purpose">Purpose
      <select id="f-purpose" name="purpose">
        <option value="">Any purpose</option>
        <option value="seva"<?= $filters['purpose'] === 'seva' ? ' selected' : '' ?>>Seva bookings</option>
        <?php foreach ($categories as $c): ?>
          <option value="<?= h($c['slug']) ?>"<?= $filters['purpose'] === $c['slug'] ? ' selected' : '' ?>><?= h($c['name']['en']) ?></option>
        <?php endforeach; ?>
      </select>
    </label>
    <label for="f-country">Country
      <select id="f-country" name="country">
        <option value="">Any country</option>
        <?php foreach ($countries as $code): ?>
          <option value="<?= h($code) ?>"<?= $filters['country'] === $code ? ' selected' : '' ?>><?= h(payAdminCountryName($code)) ?> (<?= h($code) ?>)</option>
        <?php endforeach; ?>
      </select>
    </label>
    <label for="f-currency">Currency
      <select id="f-currency" name="currency">
        <option value="">Any currency</option>
        <?php foreach (paySupportedCurrencies() as $code => $meta): ?>
          <option value="<?= h($code) ?>"<?= $filters['currency'] === $code ? ' selected' : '' ?>><?= h($code) ?></option>
        <?php endforeach; ?>
      </select>
    </label>
    <label for="f-kind">Kind
      <select id="f-kind" name="kind">
        <option value="">Donations and sevas</option>
        <option value="donation"<?= $filters['kind'] === 'donation' ? ' selected' : '' ?>>Donations</option>
        <option value="seva_booking"<?= $filters['kind'] === 'seva_booking' ? ' selected' : '' ?>>Seva bookings</option>
      </select>
    </label>
    <label for="f-from">From <input id="f-from" type="date" name="from" value="<?= h($filters['from']) ?>" /></label>
    <label for="f-to">To <input id="f-to" type="date" name="to" value="<?= h($filters['to']) ?>" /></label>
    <label class="toolbar__check" for="f-review">
      <input id="f-review" type="checkbox" name="review" value="1"<?= $filters['review'] ? ' checked' : '' ?> /> Needs review
    </label>
    <button type="submit" class="btn btn--sm"><?= adminIcon('filter') ?> Apply</button>
    <?php if ($hasFilters): ?>
      <a href="<?= PAY_ADMIN_BASE ?>?view=transactions" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Reset</a>
    <?php endif; ?>
  </div>
  <span class="toolbar__count" aria-live="polite"><?= (int) $list['total'] ?> record<?= (int) $list['total'] === 1 ? '' : 's' ?></span>
</form>

<?php if ($list['rows']): ?>
<div class="table-wrap" tabindex="0" role="region" aria-label="Online payments">
  <table class="table" data-no-search>
    <thead>
      <tr>
        <th scope="col">Donation ID</th>
        <th scope="col">Transaction ID</th>
        <?= adminSortLink('name', 'Donor', $sortQuery) ?>
        <th scope="col">Country</th>
        <th scope="col">Purpose</th>
        <?= adminSortLink('amount', 'Amount', $sortQuery) ?>
        <th scope="col">Currency</th>
        <th scope="col">Payment status</th>
        <th scope="col">Payment method</th>
        <?= adminSortLink('date', 'Date', $sortQuery) ?>
      </tr>
    </thead>
    <tbody>
      <?php foreach ($list['rows'] as $row): ?>
      <tr<?= $row['needs_review'] ? ' class="is-flagged"' : '' ?>>
        <td><a class="cell-title tabular" href="<?= h(payDetailUrl($row['number'])) ?>"><?= h($row['number']) ?></a>
            <span class="cell-sub"><?= $row['kind'] === 'donation' ? 'Donation' : 'Seva booking' ?><?= $row['attempts'] > 1 ? ' · ' . (int) $row['attempts'] . ' attempts' : '' ?></span></td>
        <td><span class="tabular"><?= $row['transaction_id'] ? h($row['transaction_id']) : '—' ?></span></td>
        <td><span class="cell-title"><?= h($row['name']) ?></span>
            <span class="cell-sub"><?= h($row['phone']) ?></span></td>
        <td><?= $row['country'] ? '<span title="' . h($row['country']) . '">' . h(payAdminCountryName($row['country'])) . '</span>' : '<span class="text-muted">—</span>' ?></td>
        <td><?= h($row['purpose'] ?? '—') ?></td>
        <td class="cell-money"><?= h(payAdminMoney($row['amount'], $row['currency'])) ?>
            <?php if (payAmountCents($row['amount_refunded']) > 0): ?><span class="cell-sub">−<?= h(payAdminMoney($row['amount_refunded'], $row['currency'])) ?> refunded</span><?php endif; ?></td>
        <td><?= h($row['currency']) ?></td>
        <td><?= payAdminStatusBadge($row['status'], $row['needs_review']) ?></td>
        <td><?= $row['payment_method'] ? h($row['payment_method']) : '<span class="text-muted">—</span>' ?></td>
        <td class="cell-date"><?= payAdminTimeTag($row['created_at']) ?>
            <?php if ($row['paid_at'] && substr((string) $row['paid_at'], 0, 10) !== substr((string) $row['created_at'], 0, 10)): ?>
              <span class="cell-sub">paid <?= h(payAdminTime($row['paid_at'], false)) ?></span>
            <?php endif; ?></td>
      </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
</div>
<?= adminPagination($list['page'], $list['pages'], $sortQuery, $list['total'], PAY_ADMIN_PER_PAGE) ?>
<?php elseif ($hasFilters): ?>
  <?= adminEmpty('search', 'No payments match these filters', 'Try a wider date range, another status, or clear the search.',
      '<a href="' . PAY_ADMIN_BASE . '?view=transactions" class="btn btn-primary btn--sm">' . adminIcon('x') . 'Clear filters</a>') ?>
<?php else: ?>
  <?= adminEmpty('landmark', 'No online payments yet', 'Donations and seva bookings paid on the website appear here as soon as a devotee pays.') ?>
<?php endif; ?>

<?php
// ── Refunds ──────────────────────────────────────────────────────────────────
elseif ($view === 'refunds'):
    $refundStatuses = ['REQUESTED', 'PROCESSING', 'SUCCESS', 'FAILED'];
    $rStatus = in_array($str('rstatus'), $refundStatuses, true) ? $str('rstatus') : '';
    $rWhere  = $rStatus !== '' ? ' WHERE r.status = :s' : '';
    $rParams = $rStatus !== '' ? [':s' => $rStatus] : [];
    $rSql = "SELECT r.id, r.refund_reference, r.amount, r.currency, r.kind, r.reason, r.method, r.status,
                    r.gateway_message, r.requested_by, r.created_at, r.processed_at,
                    t.order_id, t.payable_type, t.payable_id,
                    COALESCE(d.donation_number, b.order_number) AS number,
                    COALESCE(d.name, b.devotee_name) AS name
               FROM payment_refunds r
               JOIN payment_transactions t ON t.id = r.transaction_id
               LEFT JOIN donations d ON t.payable_type = 'donation' AND d.id = t.payable_id
               LEFT JOIN seva_bookings b ON t.payable_type = 'seva_booking' AND b.id = t.payable_id"
          . $rWhere . ' ORDER BY r.created_at DESC, r.id DESC';
    $refunds = adminPaginate($db, $rSql, $rParams, $page, PAY_ADMIN_PER_PAGE);
    $rQuery  = ['view' => 'refunds', 'rstatus' => $rStatus];
?>
<nav class="filter-chips mt-4" aria-label="Filter refunds">
  <?php foreach (array_merge([''], $refundStatuses) as $s): ?>
    <a class="chip" href="<?= h(PAY_ADMIN_BASE . adminQuery(['view' => 'refunds'], ['rstatus' => $s === '' ? null : $s])) ?>"<?= $rStatus === $s ? ' aria-current="page"' : '' ?>><?= $s === '' ? 'All' : h(ucfirst(strtolower($s))) ?></a>
  <?php endforeach; ?>
</nav>

<?php if ($refunds['rows']): ?>
<div class="table-wrap" tabindex="0" role="region" aria-label="Refunds">
  <table class="table" data-no-search>
    <thead><tr><th scope="col">Refund</th><th scope="col">Payment</th><th scope="col">Donor</th><th scope="col" class="num">Amount</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col">How</th><th scope="col">Requested</th><th scope="col">Settled</th></tr></thead>
    <tbody>
      <?php foreach ($refunds['rows'] as $r): ?>
      <tr>
        <td><span class="cell-title tabular"><?= h($r['refund_reference']) ?></span><span class="cell-clip cell-sub"><?= h($r['reason']) ?></span></td>
        <td><?= $r['number'] ? '<a class="tabular" href="' . h(payDetailUrl((string) $r['number'])) . '">' . h($r['number']) . '</a>' : '<span class="tabular">' . h($r['order_id']) . '</span>' ?></td>
        <td><?= h((string) $r['name']) ?></td>
        <td class="num cell-money"><?= h(payAdminMoney($r['amount'], (string) $r['currency'])) ?></td>
        <td><?= h(ucfirst((string) $r['kind'])) ?></td>
        <td><?= adminBadge(ucfirst(strtolower((string) $r['status'])), ['SUCCESS' => 'success', 'FAILED' => 'danger', 'PROCESSING' => 'info'][$r['status']] ?? 'warning') ?>
            <?php if ($r['gateway_message']): ?><span class="cell-sub"><?= h((string) $r['gateway_message']) ?></span><?php endif; ?></td>
        <td><?= $r['method'] === 'manual' ? 'Office' : 'CCAvenue' ?></td>
        <td class="cell-date"><?= payAdminTimeTag($r['created_at']) ?><span class="cell-sub"><?= h((string) $r['requested_by']) ?></span></td>
        <td class="cell-date"><?= payAdminTimeTag($r['processed_at']) ?></td>
      </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
</div>
<?= adminPagination($refunds['page'], $refunds['pages'], $rQuery, $refunds['total'], PAY_ADMIN_PER_PAGE) ?>
<?php else: ?>
  <?= adminEmpty('undo', 'No refunds recorded', 'Refunds are started from a payment\'s own page, and every one is kept here with its reason.') ?>
<?php endif; ?>

<?php
// ── Reconciliation ───────────────────────────────────────────────────────────
else:
    $csv    = is_array($_SESSION['pay_csv'] ?? null) ? $_SESSION['pay_csv'] : null;
    $report = payReconcileReport($db, ['from' => $filters['from'], 'to' => $filters['to'], 'kind' => $filters['kind'], 'csv' => $csv]);
    $range  = $report['range'];
?>
<form method="GET" action="<?= PAY_ADMIN_BASE ?>" class="toolbar mt-4" role="search" aria-label="Reconciliation range">
  <input type="hidden" name="view" value="reconcile" />
  <div class="toolbar__group">
    <label for="r-from">From <input id="r-from" type="date" name="from" value="<?= h($filters['from'] !== '' ? $filters['from'] : $range['fromYmd']) ?>" /></label>
    <label for="r-to">To <input id="r-to" type="date" name="to" value="<?= h($filters['to'] !== '' ? $filters['to'] : $range['toYmd']) ?>" /></label>
    <label for="r-kind">Kind
      <select id="r-kind" name="kind">
        <option value="">Donations and sevas</option>
        <option value="donation"<?= $filters['kind'] === 'donation' ? ' selected' : '' ?>>Donations</option>
        <option value="seva_booking"<?= $filters['kind'] === 'seva_booking' ? ' selected' : '' ?>>Seva bookings</option>
      </select>
    </label>
    <button type="submit" class="btn btn--sm"><?= adminIcon('filter') ?> Apply</button>
  </div>
  <span class="toolbar__count"><?= h($range['fromYmd']) ?> – <?= h($range['toYmd']) ?> (IST)</span>
</form>

<?php if ($canManage): ?>
<div class="dash-grid mt-4">
  <section class="card card--static" aria-labelledby="r-check-title">
    <div class="card__head"><h2 id="r-check-title"><?= adminIcon('refresh', 'ico--sm') ?> Ask CCAvenue</h2></div>
    <div class="card__body">
      <p class="muted">Checks the oldest open and unconfirmed attempts against CCAvenue's status API, closes attempts that never reached the gateway, and cancels expired seva holds. The scheduled job does this every ten minutes; this button does up to 20 now.</p>
      <form method="POST" action="<?= PAY_ADMIN_BASE ?>">
        <?= csrfField() ?>
        <input type="hidden" name="action" value="run_checks" />
        <button type="submit" class="btn btn-primary btn--sm"><?= adminIcon('refresh') ?> Run checks now</button>
      </form>
    </div>
  </section>

  <section class="card card--static" aria-labelledby="r-csv-title">
    <div class="card__head"><h2 id="r-csv-title"><?= adminIcon('spreadsheet', 'ico--sm') ?> Compare a CCAvenue report</h2></div>
    <div class="card__body">
      <p class="muted">Export the order report from the CCAvenue dashboard and upload it here (.csv, up to 5 MB). It is compared in memory and never stored; differences are listed below and written to each payment's history.</p>
      <form method="POST" action="<?= PAY_ADMIN_BASE ?>" enctype="multipart/form-data">
        <?= csrfField() ?>
        <input type="hidden" name="action" value="reconcile_csv" />
        <label for="r-file">
          <span class="field__label">Order report</span>
          <input id="r-file" type="file" name="report" accept=".csv,text/csv" required aria-required="true" />
          <span class="field__hint">Needs at least an order number, an amount and a status column.</span>
        </label>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary btn--sm"><?= adminIcon('upload') ?> Compare report</button>
        </div>
      </form>
      <?php if ($csv !== null): ?>
        <p class="callout mt-4"><?= adminIcon('info') ?>
          <?= h((string) ($csv['file'] ?? 'report.csv')) ?>: <?= (int) $csv['rows'] ?> rows, <?= (int) $csv['matched'] ?> matched,
          <?= count($csv['mismatches']) ?> difference<?= count($csv['mismatches']) === 1 ? '' : 's' ?>, uploaded <?= h(payAdminTime($csv['at'] ?? null)) ?>.
        </p>
        <form method="POST" action="<?= PAY_ADMIN_BASE ?>">
          <?= csrfField() ?>
          <input type="hidden" name="action" value="clear_csv" />
          <button type="submit" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Clear this comparison</button>
        </form>
      <?php endif; ?>
    </div>
  </section>
</div>
<?php endif; ?>

<?php if ($csv !== null && $csv['mismatches']): ?>
<section class="card card--static mt-6" aria-labelledby="r-diff-title">
  <div class="card__head">
    <h2 id="r-diff-title"><?= adminIcon('alert', 'ico--sm') ?> Differences with the uploaded report</h2>
    <span class="text-xs text-muted"><?= count($csv['mismatches']) ?> row<?= count($csv['mismatches']) === 1 ? '' : 's' ?></span>
  </div>
  <div class="table-wrap table-wrap--flush" tabindex="0" role="region" aria-labelledby="r-diff-title">
    <table class="table" data-no-search>
      <thead><tr><th scope="col">Order ID</th><th scope="col">Field</th><th scope="col">Here</th><th scope="col">In the report</th></tr></thead>
      <tbody>
      <?php foreach ($csv['mismatches'] as $m): ?>
        <tr>
          <td><span class="tabular"><?= h((string) $m['order_id']) ?></span></td>
          <td><?= h((string) $m['field']) ?></td>
          <td><?= h((string) $m['ours']) ?></td>
          <td><?= h((string) $m['theirs']) ?></td>
        </tr>
      <?php endforeach; ?>
      </tbody>
    </table>
  </div>
</section>
<?php endif; ?>

<?php foreach ($report['sections'] as $key => $section): ?>
<section class="card card--static mt-6" aria-labelledby="sec-<?= h($key) ?>">
  <div class="card__head">
    <h2 id="sec-<?= h($key) ?>"><?= adminIcon($key === 'needs_review' ? 'alert' : ($key === 'stale_open' ? 'clock' : 'list-checks'), 'ico--sm') ?> <?= h($section['title']) ?></h2>
    <?= adminBadge((string) count($section['rows']), count($section['rows']) > 0 ? 'warning' : 'success') ?>
  </div>
  <?php if (!$section['rows']): ?>
    <div class="card__body"><p class="field__hint">Nothing here — good.</p></div>
  <?php else: ?>
  <div class="table-wrap table-wrap--flush" tabindex="0" role="region" aria-labelledby="sec-<?= h($key) ?>">
    <table class="table" data-no-search>
      <thead>
        <tr>
          <th scope="col">Order ID</th><th scope="col">Payment</th><th scope="col">Donor</th>
          <th scope="col" class="num">Amount</th><th scope="col">Status</th><th scope="col">What it means</th>
          <?php if ($canManage && $key === 'needs_review'): ?><th scope="col"><span class="sr-only">Actions</span></th><?php endif; ?>
        </tr>
      </thead>
      <tbody>
      <?php foreach ($section['rows'] as $row): ?>
        <tr>
          <td><span class="tabular"><?= h((string) ($row['order_id'] ?? '—')) ?></span></td>
          <td><?= !empty($row['number']) ? '<a class="tabular" href="' . h(payDetailUrl((string) $row['number'])) . '">' . h((string) $row['number']) . '</a>' : '<span class="text-muted">—</span>' ?></td>
          <td><?= h((string) ($row['name'] ?? '—')) ?></td>
          <td class="num cell-money"><?= isset($row['amount']) ? h(payAdminMoney((string) $row['amount'], (string) ($row['currency'] ?? 'INR'))) : '—' ?></td>
          <td><?= isset($row['status']) ? payAdminStatusBadge((string) $row['status'], !empty($row['needs_review'])) : (isset($row['payable_status']) ? payAdminStatusBadge((string) $row['payable_status']) : '<span class="text-muted">—</span>') ?></td>
          <td><?= h((string) ($row['detail'] ?? '')) ?></td>
          <?php if ($canManage && $key === 'needs_review'): ?>
          <td class="cell-actions">
            <?php if (!empty($row['transaction_id'])): ?>
            <form method="POST" action="<?= PAY_ADMIN_BASE ?>" class="pay-review">
              <?= csrfField() ?>
              <input type="hidden" name="action" value="mark_reviewed" />
              <input type="hidden" name="transaction_id" value="<?= (int) $row['transaction_id'] ?>" />
              <label class="sr-only" for="rnote-<?= (int) $row['transaction_id'] ?>">What did you check on <?= h((string) $row['order_id']) ?>?</label>
              <input id="rnote-<?= (int) $row['transaction_id'] ?>" type="text" name="note" maxlength="500" required aria-required="true" placeholder="What did you check?" />
              <button type="submit" class="btn btn--xs"><?= adminIcon('check') ?> Mark reviewed</button>
            </form>
            <?php endif; ?>
          </td>
          <?php endif; ?>
        </tr>
      <?php endforeach; ?>
      </tbody>
    </table>
  </div>
  <?php endif; ?>
</section>
<?php endforeach; ?>

<?php endif; ?>

<?php adminFooter(); ?>
