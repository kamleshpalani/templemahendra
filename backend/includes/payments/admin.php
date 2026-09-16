<?php
/**
 * backend/includes/payments/admin.php — read models for Admin → Online
 * Payments (docs/payments/SPEC.md §10.3).
 *
 * The admin pages own the HTML, capability checks, CSRF and flashes; these
 * functions own the SQL and the money arithmetic so the pages, their tests and
 * the dashboard compute the same numbers. "Today / month / year" are IST
 * calendar periods turned into UTC ranges on paid_at. Money totals are INR;
 * other currencies are listed separately, never converted.
 */

/** Badge tone for a payable or attempt status (admin badge tones). */
function payStatusTone(?string $status): string
{
    return match ((string) $status) {
        'SUCCESS'              => 'success',
        'FAILED'               => 'danger',
        'INITIATED', 'PENDING' => 'warning',
        'REFUND_INITIATED'     => 'info',
        'PARTIALLY_REFUNDED'   => 'gold',
        default                => 'muted', // CANCELLED, REFUNDED, unknown
    };
}

/** "Refund initiated" for REFUND_INITIATED, and so on. */
function payStatusLabel(?string $status): string
{
    return match ((string) $status) {
        'INITIATED'          => 'Initiated',
        'PENDING'            => 'Pending',
        'SUCCESS'            => 'Success',
        'FAILED'             => 'Failed',
        'CANCELLED'          => 'Cancelled',
        'REFUND_INITIATED'   => 'Refund initiated',
        'PARTIALLY_REFUNDED' => 'Partially refunded',
        'REFUNDED'           => 'Refunded',
        default              => (string) $status,
    };
}

/** Admin money: "₹1,000.00" for INR, "USD 25.00" otherwise, "JPY 3,000" for whole-unit currencies. */
function payAdminMoney(string|int|float|null $amount, string $currency): string
{
    $currency = strtoupper($currency) ?: 'INR';
    $decimals = payCurrencyDecimals($currency);
    $value = number_format(payAmountCents((string) $amount) / 100, $decimals);
    return $currency === 'INR' ? '₹' . $value : $currency . ' ' . $value;
}

/** A CSV cell with spreadsheet formulas neutralised: a leading = + - @ tab or CR gets a ' prefix. */
function payCsvCell(mixed $value): string
{
    $s = $value === null ? '' : (is_bool($value) ? ($value ? '1' : '0') : (string) $value);
    return $s !== '' && preg_match('/^[=+\-@\t\r]/', $s) ? "'" . $s : $s;
}

/** The English name of an ISO-2 country code for admin screens; the code itself when unknown, '' for none. */
function payAdminCountryName(?string $iso2): string
{
    $code = strtoupper(trim((string) $iso2));
    if ($code === '') return '';
    return (string) (payCountryTable()[$code][0] ?? $code);
}

/**
 * SQL for one row per online payable (alias p): kind, id, number, name, phone,
 * email, country, purpose (category slug, NULL for sevas), purpose_en,
 * purpose_ta (category or seva name), amount, currency, status, receipt_number,
 * paid_at, amount_refunded, lang — joined with its attempts (alias a):
 * created_utc (first attempt), attempts, needs_review, success_tracking,
 * latest_tracking, success_mode, latest_mode, order_ids, trackings, gross_paid
 * (Σ amounts of its SUCCESS attempts — twice the amount for a double payment),
 * and refunded_success (Σ SUCCESS refunds against any of its attempts). Money
 * KPIs are gross_paid − refunded_success: what actually came in and stayed.
 */
function payAdminPayablesSql(): string
{
    return "SELECT p.*, a.created_utc, a.attempts, a.needs_review, a.success_tracking, a.latest_tracking,
                   a.success_mode, a.latest_mode, a.order_ids, a.trackings,
                   COALESCE(a.gross_paid, 0) AS gross_paid, COALESCE(rf.refunded, 0) AS refunded_success
              FROM (
                SELECT _utf8mb4'donation' COLLATE utf8mb4_unicode_ci AS kind, d.id, d.donation_number AS number, d.name,
                       d.phone, d.email, d.country, d.purpose, c.name_en AS purpose_en, c.name_ta AS purpose_ta,
                       d.amount, d.currency, d.status, d.receipt_number, d.paid_at, d.amount_refunded, d.lang
                  FROM donations d LEFT JOIN donation_categories c ON c.id = d.category_id
                 WHERE d.source = 'online' AND d.donation_number IS NOT NULL
                UNION ALL
                SELECT _utf8mb4'seva_booking' COLLATE utf8mb4_unicode_ci, b.id, b.order_number, b.devotee_name,
                       b.phone, b.email, b.phone_country, NULL, COALESCE(s.name_en, b.seva_name), COALESCE(s.name_ta, b.seva_name),
                       b.amount, COALESCE(b.currency, 'INR'), b.payment_status, b.receipt_number, b.paid_at, b.amount_refunded, b.lang
                  FROM seva_bookings b LEFT JOIN sevas s ON s.id = b.seva_id
                 WHERE b.payment_mode = 'online' AND b.order_number IS NOT NULL
              ) p
              LEFT JOIN (
                SELECT payable_type, payable_id, MIN(created_at) AS created_utc, MAX(attempt) AS attempts,
                       MAX(needs_review) AS needs_review,
                       SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN status = 'SUCCESS' THEN tracking_id END ORDER BY attempt), ',', 1) AS success_tracking,
                       SUBSTRING_INDEX(GROUP_CONCAT(tracking_id ORDER BY attempt DESC), ',', 1) AS latest_tracking,
                       SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN status = 'SUCCESS' THEN payment_mode END ORDER BY attempt SEPARATOR '|'), '|', 1) AS success_mode,
                       SUBSTRING_INDEX(GROUP_CONCAT(payment_mode ORDER BY attempt DESC SEPARATOR '|'), '|', 1) AS latest_mode,
                       GROUP_CONCAT(order_id) AS order_ids,
                       GROUP_CONCAT(tracking_id) AS trackings,
                       SUM(CASE WHEN status = 'SUCCESS' THEN amount ELSE 0 END) AS gross_paid
                  FROM payment_transactions GROUP BY payable_type, payable_id
              ) a ON a.payable_type = p.kind AND a.payable_id = p.id
              LEFT JOIN (
                SELECT t.payable_type, t.payable_id, SUM(r.amount) AS refunded
                  FROM payment_refunds r JOIN payment_transactions t ON t.id = r.transaction_id
                 WHERE r.status = 'SUCCESS' GROUP BY t.payable_type, t.payable_id
              ) rf ON rf.payable_type = p.kind AND rf.payable_id = p.id";
}

/** SQL for the money a received payable holds: every SUCCESS attempt's amount, less every SUCCESS refund (alias x). */
const PAY_ADMIN_NET_SQL = '(x.gross_paid - x.refunded_success)';

/** The status filter value that means "still open": INITIATED or PENDING, what the Pending KPI counts. */
const PAY_ADMIN_STATUS_OPEN = 'open';

/**
 * Whitelisted list filters from a query array: q, country, from, to (IST
 * Y-m-d), status (a payable status, or "open" = INITIATED|PENDING), purpose
 * (category slug or "seva"), currency, kind (donation | seva_booking), review
 * (bool), sort (date | amount | name), dir (asc | desc).
 */
function payAdminFilters(array $query): array
{
    $str = static fn(string $k): string => is_scalar($query[$k] ?? null) ? trim((string) $query[$k]) : '';
    $f = [
        'q'        => mb_substr($str('q'), 0, 100),
        'country'  => preg_match('/^[A-Z]{2}$/D', strtoupper($str('country'))) ? strtoupper($str('country')) : '',
        'from'     => isValidDate($str('from')) ? $str('from') : '',
        'to'       => isValidDate($str('to')) ? $str('to') : '',
        'status'   => in_array($str('status'), PAY_PAYABLE_STATUSES, true) || $str('status') === PAY_ADMIN_STATUS_OPEN ? $str('status') : '',
        'purpose'  => $str('purpose') === 'seva' || preg_match('/^[a-z0-9_]{2,40}$/D', $str('purpose')) ? $str('purpose') : '',
        'currency' => isset(PAY_SUPPORTED_CURRENCIES[strtoupper($str('currency'))]) ? strtoupper($str('currency')) : '',
        'kind'     => in_array($str('kind'), ['donation', 'seva_booking'], true) ? $str('kind') : '',
        'review'   => $str('review') === '1',
        'sort'     => in_array($str('sort'), ['date', 'amount', 'name'], true) ? $str('sort') : 'date',
        'dir'      => strtolower($str('dir')) === 'asc' ? 'asc' : 'desc',
    ];
    if ($f['from'] !== '' && $f['to'] !== '' && $f['to'] < $f['from']) [$f['from'], $f['to']] = [$f['to'], $f['from']];
    return $f;
}

/** WHERE clause and params for payAdminFilters() output, on payAdminPayablesSql() (aliases p, a). */
function payAdminWhere(array $f): array
{
    $where = [];
    $params = [];
    if ($f['q'] !== '') {
        $like = '%' . addcslashes($f['q'], '%_\\') . '%';
        $parts = ['p.number LIKE :q1', 'a.order_ids LIKE :q2', 'a.trackings LIKE :q3', 'p.name LIKE :q4', 'p.email LIKE :q5'];
        $params += [':q1' => $like, ':q2' => $like, ':q3' => $like, ':q4' => $like, ':q5' => $like];
        $digits = preg_replace('/\D+/', '', $f['q']) ?? '';
        if (strlen($digits) >= 4) {
            $parts[] = 'p.phone LIKE :q6';
            $params[':q6'] = '%' . $digits . '%';
        }
        $where[] = '(' . implode(' OR ', $parts) . ')';
    }
    if ($f['country'] !== '') {
        $where[] = 'p.country = :country';
        $params[':country'] = $f['country'];
    }
    if ($f['from'] !== '') {
        $where[] = 'a.created_utc >= :from';
        $params[':from'] = payIstRangeUtc($f['from'])['from'];
    }
    if ($f['to'] !== '') {
        $where[] = 'a.created_utc < :to';
        $params[':to'] = payIstRangeUtc($f['to'])['to'];
    }
    if ($f['status'] === PAY_ADMIN_STATUS_OPEN) {
        $where[] = "p.status IN ('INITIATED','PENDING')";
    } elseif ($f['status'] !== '') {
        $where[] = 'p.status = :status';
        $params[':status'] = $f['status'];
    }
    if ($f['purpose'] === 'seva') {
        $where[] = "p.kind = 'seva_booking'";
    } elseif ($f['purpose'] !== '') {
        $where[] = 'p.purpose = :purpose';
        $params[':purpose'] = $f['purpose'];
    }
    if ($f['currency'] !== '') {
        $where[] = 'p.currency = :currency';
        $params[':currency'] = $f['currency'];
    }
    if ($f['kind'] !== '') {
        $where[] = 'p.kind = :kind';
        $params[':kind'] = $f['kind'];
    }
    if ($f['review']) $where[] = 'a.needs_review = 1';
    return [$where ? ' WHERE ' . implode(' AND ', $where) : '', $params];
}

/** One list row in display shape. */
function payAdminRowShape(array $r): array
{
    return [
        'kind'            => $r['kind'],
        'id'              => (int) $r['id'],
        'number'          => $r['number'],
        'transaction_id'  => $r['success_tracking'] ?: ($r['latest_tracking'] ?: null),
        'name'            => $r['name'],
        'phone'           => $r['phone'],
        'email'           => $r['email'],
        'country'         => $r['country'],
        'purpose'         => $r['kind'] === 'seva_booking' ? 'Seva: ' . $r['purpose_en'] : ($r['purpose_en'] ?? $r['purpose']),
        'purpose_slug'    => $r['purpose'],
        'amount'          => payAmountFormat((string) $r['amount'], 'INR'),
        'currency'        => $r['currency'],
        'status'          => $r['status'],
        'needs_review'    => (int) ($r['needs_review'] ?? 0) === 1,
        'payment_method'  => $r['success_mode'] ?: ($r['latest_mode'] ?: null),
        'receipt_number'  => $r['receipt_number'],
        'amount_refunded' => payAmountFormat((string) $r['amount_refunded'], 'INR'),
        'created_at'      => $r['created_utc'],
        'paid_at'         => $r['paid_at'],
        'attempts'        => (int) ($r['attempts'] ?? 0),
        'order_ids'       => $r['order_ids'],
    ];
}

/**
 * The Transactions tab: one row per payable, filtered, sorted, paginated.
 * $filters is payAdminFilters() output.
 *
 * @return array{rows:array, total:int, pages:int, page:int, per_page:int}
 */
function payAdminList(PDO $db, array $filters, int $page = 1, int $perPage = 25): array
{
    $perPage = max(1, min(200, $perPage));
    [$where, $params] = payAdminWhere($filters);
    $base = payAdminPayablesSql();
    $stmt = $db->prepare("SELECT COUNT(*) FROM ({$base}{$where}) x");
    $stmt->execute($params);
    $total = (int) $stmt->fetchColumn();
    $pages = max(1, (int) ceil($total / $perPage));
    $page = max(1, min($page, $pages));
    $order = match ($filters['sort'] ?? 'date') {
        'amount' => 'p.amount',
        'name'   => 'p.name',
        default  => 'a.created_utc',
    };
    $dir = ($filters['dir'] ?? 'desc') === 'asc' ? 'ASC' : 'DESC';
    $offset = ($page - 1) * $perPage;
    $stmt = $db->prepare("{$base}{$where} ORDER BY {$order} {$dir}, p.id {$dir} LIMIT {$perPage} OFFSET {$offset}");
    $stmt->execute($params);
    return [
        'rows'     => array_map('payAdminRowShape', $stmt->fetchAll(PDO::FETCH_ASSOC)),
        'total'    => $total,
        'pages'    => $pages,
        'page'     => $page,
        'per_page' => $perPage,
    ];
}

/** The CSV header for the payments export (§10.3). */
function payAdminCsvHeader(): array
{
    return ['number', 'kind', 'order_id', 'tracking_id', 'bank_ref_no', 'name', 'phone', 'email', 'country', 'purpose', 'amount', 'currency', 'status', 'payment_mode', 'receipt_number', 'amount_refunded', 'created_at_ist', 'paid_at_ist'];
}

/**
 * Export rows for the filtered set, each already passed through payCsvCell()
 * and in payAdminCsvHeader() order (one row per payable; order_id, tracking_id
 * and bank_ref_no are the SUCCESS attempt's, else the latest attempt's).
 */
function payAdminExportRows(PDO $db, array $filters, int $max = 50000): array
{
    [$where, $params] = payAdminWhere($filters);
    $order = match ($filters['sort'] ?? 'date') { 'amount' => 'p.amount', 'name' => 'p.name', default => 'a.created_utc' };
    $dir = ($filters['dir'] ?? 'desc') === 'asc' ? 'ASC' : 'DESC';
    $stmt = $db->prepare(payAdminPayablesSql() . "{$where} ORDER BY {$order} {$dir}, p.id {$dir} LIMIT " . max(1, $max));
    $stmt->execute($params);
    $rows = [];
    $attemptStmt = $db->prepare(
        "SELECT order_id, tracking_id, bank_ref_no FROM payment_transactions
          WHERE payable_type = :t AND payable_id = :id ORDER BY (status = 'SUCCESS') DESC, attempt DESC LIMIT 1"
    );
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $attemptStmt->execute([':t' => $r['kind'], ':id' => $r['id']]);
        $att = $attemptStmt->fetch(PDO::FETCH_ASSOC) ?: [];
        $shape = payAdminRowShape($r);
        $rows[] = array_map('payCsvCell', [
            $shape['number'], $shape['kind'], $att['order_id'] ?? '', $att['tracking_id'] ?? '', $att['bank_ref_no'] ?? '',
            $shape['name'], $shape['phone'], $shape['email'], $shape['country'], $shape['purpose'],
            $shape['amount'], $shape['currency'], $shape['status'], $shape['payment_method'], $shape['receipt_number'],
            $shape['amount_refunded'],
            $shape['created_at'] ? payIstDate($shape['created_at'], 'Y-m-d H:i:s') : '',
            $shape['paid_at'] ? payIstDate($shape['paid_at'], 'Y-m-d H:i:s') : '',
        ]);
    }
    return $rows;
}

/** ISO-2 countries that appear on online payables, for the country filter. */
function payAdminCountries(PDO $db): array
{
    $stmt = $db->query('SELECT DISTINCT x.country FROM (' . payAdminPayablesSql() . ') x WHERE x.country IS NOT NULL ORDER BY x.country');
    return $stmt->fetchAll(PDO::FETCH_COLUMN);
}

/**
 * Overview KPIs (§10.3). $opts: kind (all | donation | seva_booking), now (UTC
 * "Y-m-d H:i:s", for tests).
 *
 * received.{total,today,month,year}: {count, inr ("0.00"), others: {CUR: amount}}
 *   over SUCCESS + PARTIALLY_REFUNDED payables by paid_at. Money = every SUCCESS
 *   attempt's amount (a double payment counts twice until its extra attempt is
 *   refunded) less every SUCCESS refund, from the transaction and refund tables.
 * successful: count of payables ever paid (receipt issued).
 * failed / pending: counts of FAILED and INITIATED+PENDING payables.
 * refunded: {count, inr, others} of SUCCESS refunds.
 * domestic / international: {count, inr} of received payables (country IN or none / other).
 * monthly: 12 IST months ending this month [{label "Sep 2026", month "2026-09", inr}].
 * shares: received INR by purpose [{label, inr}], largest first.
 * attention: {needs_review, stale_open, refunds_waiting}.
 */
function payAdminKpis(PDO $db, array $opts = []): array
{
    $kind = in_array($opts['kind'] ?? 'all', ['donation', 'seva_booking'], true) ? $opts['kind'] : 'all';
    $now = is_string($opts['now'] ?? null) ? $opts['now'] : null;
    $base = payAdminPayablesSql();
    $kindSql = $kind !== 'all' ? ' AND x.kind = :kind' : '';
    $kindParam = $kind !== 'all' ? [':kind' => $kind] : [];
    $received = "x.status IN ('SUCCESS','PARTIALLY_REFUNDED')";
    $net = PAY_ADMIN_NET_SQL;

    $sum = static function (string $extraWhere, array $params) use ($db, $base, $kindSql, $kindParam, $received, $net): array {
        $stmt = $db->prepare("SELECT x.currency, COUNT(*) AS n, SUM({$net}) AS net
                                FROM ({$base}) x WHERE {$received}{$kindSql}{$extraWhere} GROUP BY x.currency");
        $stmt->execute($params + $kindParam);
        $out = ['count' => 0, 'inr' => '0.00', 'others' => []];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $out['count'] += (int) $r['n'];
            if ($r['currency'] === 'INR') {
                $out['inr'] = payAmountFormat((string) $r['net'], 'INR');
            } else {
                $out['others'][$r['currency']] = payAmountFormat((string) $r['net'], 'INR');
            }
        }
        return $out;
    };

    $kpis = ['kind' => $kind, 'received' => []];
    $kpis['received']['total'] = $sum('', []);
    foreach (['today', 'month', 'year'] as $period) {
        $r = payIstPeriodUtc($period, $now);
        $kpis['received'][$period] = $sum(' AND x.paid_at >= :f AND x.paid_at < :t', [':f' => $r['from'], ':t' => $r['to']]);
    }

    $count = static function (string $where) use ($db, $base, $kindSql, $kindParam): int {
        $stmt = $db->prepare("SELECT COUNT(*) FROM ({$base}) x WHERE {$where}{$kindSql}");
        $stmt->execute($kindParam);
        return (int) $stmt->fetchColumn();
    };
    $kpis['successful'] = $count('x.receipt_number IS NOT NULL');
    $kpis['failed'] = $count("x.status = 'FAILED'");
    $kpis['pending'] = $count("x.status IN ('INITIATED','PENDING')");

    $stmt = $db->prepare(
        "SELECT r.currency, COUNT(*) AS n, SUM(r.amount) AS total FROM payment_refunds r
           JOIN payment_transactions t ON t.id = r.transaction_id
          WHERE r.status = 'SUCCESS'" . ($kind !== 'all' ? ' AND t.payable_type = :kind' : '') . ' GROUP BY r.currency'
    );
    $stmt->execute($kindParam);
    $kpis['refunded'] = ['count' => 0, 'inr' => '0.00', 'others' => []];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $kpis['refunded']['count'] += (int) $r['n'];
        if ($r['currency'] === 'INR') $kpis['refunded']['inr'] = payAmountFormat((string) $r['total'], 'INR');
        else $kpis['refunded']['others'][$r['currency']] = payAmountFormat((string) $r['total'], 'INR');
    }

    $stmt = $db->prepare(
        "SELECT CASE WHEN x.country IS NULL OR x.country = 'IN' THEN 'domestic' ELSE 'international' END AS region,
                COUNT(*) AS n, SUM(CASE WHEN x.currency = 'INR' THEN {$net} ELSE 0 END) AS inr
           FROM ({$base}) x WHERE {$received}{$kindSql} GROUP BY region"
    );
    $stmt->execute($kindParam);
    $kpis['domestic'] = ['count' => 0, 'inr' => '0.00'];
    $kpis['international'] = ['count' => 0, 'inr' => '0.00'];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $kpis[$r['region']] = ['count' => (int) $r['n'], 'inr' => payAmountFormat((string) $r['inr'], 'INR')];
    }

    // IST is a fixed +05:30 with no daylight saving, so the month is paid_at + 330 minutes.
    $nowIst = (new DateTimeImmutable($now ?? 'now', new DateTimeZone('UTC')))->setTimezone(payIstZone());
    $firstMonth = $nowIst->modify('first day of this month')->modify('-11 months');
    $range = payIstRangeUtc($firstMonth->format('Y-m-01'), $nowIst->format('Y-m-t'));
    $stmt = $db->prepare(
        "SELECT DATE_FORMAT(x.paid_at + INTERVAL 330 MINUTE, '%Y-%m') AS ym, SUM({$net}) AS inr
           FROM ({$base}) x WHERE {$received} AND x.currency = 'INR' AND x.paid_at >= :f AND x.paid_at < :t{$kindSql}
          GROUP BY ym"
    );
    $stmt->execute([':f' => $range['from'], ':t' => $range['to']] + $kindParam);
    $byMonth = $stmt->fetchAll(PDO::FETCH_KEY_PAIR);
    $kpis['monthly'] = [];
    for ($i = 0; $i < 12; $i++) {
        $m = $firstMonth->modify("+{$i} months");
        $kpis['monthly'][] = ['label' => $m->format('M Y'), 'month' => $m->format('Y-m'), 'inr' => payAmountFormat((string) ($byMonth[$m->format('Y-m')] ?? '0'), 'INR')];
    }

    $stmt = $db->prepare(
        "SELECT CASE WHEN x.kind = 'seva_booking' THEN CONCAT('Seva: ', x.purpose_en) ELSE COALESCE(x.purpose_en, x.purpose, 'Other') END AS label,
                SUM({$net}) AS inr
           FROM ({$base}) x WHERE {$received} AND x.currency = 'INR'{$kindSql}
          GROUP BY label ORDER BY inr DESC LIMIT 12"
    );
    $stmt->execute($kindParam);
    $kpis['shares'] = array_map(static fn(array $r): array => ['label' => (string) $r['label'], 'inr' => payAmountFormat((string) $r['inr'], 'INR')], $stmt->fetchAll(PDO::FETCH_ASSOC));

    $kpis['attention'] = payAdminNeedsAttention($db);
    return $kpis;
}

/** Counts for the "Needs attention" card: needs_review attempts, open attempts older than 3 hours, refunds waiting. */
function payAdminNeedsAttention(PDO $db): array
{
    $one = static fn(string $sql): int => (int) $db->query($sql)->fetchColumn();
    return [
        'needs_review'    => $one('SELECT COUNT(*) FROM payment_transactions WHERE needs_review = 1'),
        'stale_open'      => $one("SELECT COUNT(*) FROM payment_transactions WHERE status IN ('INITIATED','PENDING') AND created_at < UTC_TIMESTAMP() - INTERVAL 3 HOUR"),
        'refunds_waiting' => $one("SELECT COUNT(*) FROM payment_refunds WHERE status IN ('REQUESTED','PROCESSING')"),
    ];
}

/**
 * Everything the detail view shows for one number, or null.
 *
 * payable (payLoadPayable shape incl. attempts), refunds (newest first), audit
 * (newest first, max 500 rows: id, transaction_id, event, detail, data (array),
 * actor, ip, created_at UTC), refundable (attempt id => "amount" for SUCCESS
 * attempts), api_refund (attempt id => bool: ccavApiConfigured and a tracking
 * id), links {receipt (absolute, tokenised; paid only), result (absolute,
 * tokenised)}, can_retry, public (payPublicView).
 */
function payAdminDetail(PDO $db, string $number): ?array
{
    $payable = payLoadPayable($db, $number);
    if ($payable === null) return null;
    $stmt = $db->prepare(
        'SELECT id, transaction_id, event, detail, data, actor, ip, created_at FROM payment_audit_log
          WHERE payable_type = :t AND payable_id = :id
             OR transaction_id IN (SELECT id FROM payment_transactions WHERE payable_type = :t2 AND payable_id = :id2)
          ORDER BY created_at DESC, id DESC LIMIT 500'
    );
    $stmt->execute([':t' => $payable['type'], ':id' => $payable['id'], ':t2' => $payable['type'], ':id2' => $payable['id']]);
    $audit = array_map(static function (array $r): array {
        $d = is_string($r['data']) ? json_decode($r['data'], true) : null;
        $r['data'] = is_array($d) ? $d : null;
        $r['id'] = (int) $r['id'];
        return $r;
    }, $stmt->fetchAll(PDO::FETCH_ASSOC));

    $refundable = [];
    $apiRefund = [];
    foreach ($payable['attempts'] as $a) {
        if ($a['status'] !== 'SUCCESS') continue;
        $refundable[$a['id']] = payRefundableAmount($db, $payable, $a);
        $apiRefund[$a['id']] = ccavApiConfigured((string) $a['environment']) && !empty($a['tracking_id']);
    }
    $paid = in_array($payable['status'], PAY_PAID_STATUSES, true);
    return [
        'payable'    => $payable,
        'refunds'    => payRefundsFor($db, $payable['type'], $payable['id']),
        'audit'      => $audit,
        'refundable' => $refundable,
        'api_refund' => $apiRefund,
        'links'      => [
            'receipt' => $paid ? siteUrl(payReceiptPath($payable['number'])) : null,
            'result'  => siteUrl(payResultPath($payable['number'])),
        ],
        'can_retry'  => payCanRetry($payable),
        'public'     => payPublicView($db, $payable, $paid),
    ];
}
