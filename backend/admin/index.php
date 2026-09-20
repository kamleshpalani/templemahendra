<?php
// backend/admin/index.php — Dashboard: KPIs, analytics, activity, quick actions
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/registration.php';
require_once __DIR__ . '/../includes/payments.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

// Online giving (migration 010, docs/payments/SPEC.md §10.6): a donation row is
// a pledge or money paid through CCAvenue. Only pledges and online donations
// that really succeeded count as money here, and always net of refunds — a
// failed or abandoned payment is not a donation. Each column is checked so a
// site that has not applied the migration shows the dashboard as before.
$hasPayCols = publicGuardHasColumn('donations', 'source')
    && publicGuardHasColumn('donations', 'status')
    && publicGuardHasColumn('donations', 'amount_refunded');
$countableSql = $hasPayCols ? "(source = 'pledge' OR status IN ('SUCCESS','PARTIALLY_REFUNDED'))" : '1';
$netAmountSql = $hasPayCols ? '(amount - amount_refunded)' : 'amount';

// Family registrations (migration 009). Guarded on its own: a site that has not
// applied the migration yet, or whose registration tables cannot be read, shows
// the rest of the dashboard as before, without these two figures.
$registrations = null;
try {
    if (registrationReady() && publicGuardHasColumn('devotees', 'duplicate_of')) {
        $registrations = $db->query(
            'SELECT COALESCE(SUM(is_active = 1), 0)                             AS families,
                    COALESCE(SUM(is_active = 1 AND duplicate_of IS NOT NULL), 0) AS duplicates,
                    (SELECT COUNT(*) FROM devotee_family_members m
                       JOIN devotees a ON a.id = m.devotee_id AND a.is_active = 1) AS members
               FROM devotees'
        )->fetch() ?: null;
    }
} catch (Throwable $e) {
    error_log('[dashboard] family registration figures: ' . $e->getMessage());
    $registrations = null;
}

// Live Darshan monitoring (Live phase 10). Guarded on its own: without
// migrations 011/012, or for a role without live.view, the card is not shown.
$liveHealth = null;
if (adminCan('live.view')) {
    try {
        require_once __DIR__ . '/../includes/live.php';
        if (liveTablesExist() && liveAutomationInstalled()) {
            $liveHealth = liveHealthSummary($db);
        }
    } catch (Throwable $e) {
        error_log('[dashboard] live health: ' . $e->getMessage());
        $liveHealth = null;
    }
}

// ── Counts ───────────────────────────────────────────────────────────────────
$counts = [];
foreach (['sevas', 'events', 'announcements', 'donations', 'gallery', 'seva_bookings', 'poojas', 'sponsors', 'homepage_widgets', 'contact_messages'] as $tbl) {
    $counts[$tbl] = (int) $db->query("SELECT COUNT(*) FROM `$tbl`")->fetchColumn();
}

$counts['donations'] = (int) $db->query("SELECT COUNT(*) FROM donations WHERE {$countableSql}")->fetchColumn();
$donations_total  = (float) $db->query("SELECT COALESCE(SUM({$netAmountSql}),0) FROM donations WHERE {$countableSql}")->fetchColumn();
$donations_month  = (float) $db->query("SELECT COALESCE(SUM({$netAmountSql}),0) FROM donations WHERE {$countableSql} AND created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')")->fetchColumn();
$donations_prev   = (float) $db->query("SELECT COALESCE(SUM({$netAmountSql}),0) FROM donations WHERE {$countableSql} AND created_at >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01') AND created_at < DATE_FORMAT(CURDATE(), '%Y-%m-01')")->fetchColumn();

// Money received through CCAvenue this IST month (donations and sevas, INR,
// net of refunds). Guarded on its own: without migration 010 the KPI is not shown.
$onlineMonth = null;
try {
    if (payTablesExist() && adminCan('payments.view')) {
        $period = payIstPeriodUtc('month');
        $stmt = $db->prepare(
            "SELECT COUNT(*) c, COALESCE(SUM(net),0) total FROM (
                SELECT amount - amount_refunded AS net FROM donations
                 WHERE source = 'online' AND status IN ('SUCCESS','PARTIALLY_REFUNDED') AND currency = 'INR' AND paid_at >= :f1 AND paid_at < :t1
                UNION ALL
                SELECT amount - amount_refunded FROM seva_bookings
                 WHERE payment_mode = 'online' AND payment_status IN ('SUCCESS','PARTIALLY_REFUNDED') AND COALESCE(currency, 'INR') = 'INR' AND paid_at >= :f2 AND paid_at < :t2
             ) x"
        );
        $stmt->execute([':f1' => $period['from'], ':t1' => $period['to'], ':f2' => $period['from'], ':t2' => $period['to']]);
        $onlineMonth = $stmt->fetch() ?: null;
    }
} catch (Throwable $e) {
    error_log('[dashboard] online payment figures: ' . $e->getMessage());
    $onlineMonth = null;
}
$pending_bookings = (int) $db->query("SELECT COUNT(*) FROM seva_bookings WHERE status = 'pending'")->fetchColumn();
$upcoming_events  = (int) $db->query("SELECT COUNT(*) FROM events WHERE is_active = 1 AND event_date >= CURDATE()")->fetchColumn();
$messages_week    = (int) $db->query("SELECT COUNT(*) FROM contact_messages WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)")->fetchColumn();
$active_widgets   = (int) $db->query("SELECT COUNT(*) FROM homepage_widgets WHERE is_active = 1")->fetchColumn();

$delta = null;
$deltaDown = false;
if ($donations_prev > 0) {
    $pct       = ($donations_month - $donations_prev) / $donations_prev * 100;
    $deltaDown = $pct < 0;
    $delta     = ($pct >= 0 ? '+' : '') . number_format($pct, 0) . '% vs last month';
} elseif ($donations_month > 0) {
    $delta = 'First pledges this month';
}

// ── Donations by month (last 12 months, zero-filled) ─────────────────────────
$byMonth = [];
$stmt = $db->query("SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, SUM({$netAmountSql}) AS total
                      FROM donations
                     WHERE {$countableSql} AND created_at >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 11 MONTH)
                  GROUP BY ym");
foreach ($stmt->fetchAll() as $r) $byMonth[$r['ym']] = (float) $r['total'];
$series = [];
for ($i = 11; $i >= 0; $i--) {
    $d  = new DateTime("first day of -$i month");
    $ym = $d->format('Y-m');
    $v  = $byMonth[$ym] ?? 0.0;
    $series[] = ['label' => $d->format('M'), 'value' => $v, 'hint' => $d->format('M Y') . ' · ' . adminFmtMoney($v)];
}

// ── Bookings by status + donation purposes ───────────────────────────────────
$statusCounts = ['pending' => 0, 'confirmed' => 0, 'completed' => 0, 'cancelled' => 0];
foreach ($db->query("SELECT status, COUNT(*) c FROM seva_bookings GROUP BY status")->fetchAll() as $r) {
    $statusCounts[$r['status']] = (int) $r['c'];
}
$statusTones = ['pending' => 'warning', 'confirmed' => 'info', 'completed' => 'sage', 'cancelled' => 'danger'];
$shares = [];
foreach ($statusCounts as $s => $c) $shares[] = ['label' => ucfirst($s), 'value' => $c, 'tone' => $statusTones[$s]];

$purposes = $db->query("SELECT COALESCE(NULLIF(purpose,''),'other') p, SUM({$netAmountSql}) total FROM donations WHERE {$countableSql} GROUP BY p ORDER BY total DESC LIMIT 6")->fetchAll();
$purposeLabels = ['kumbabhishekam' => 'Kumbabhishekam', 'annadanam_hall' => 'Annadanam hall', 'annadanam' => 'Annadanam', 'abhishekam' => 'Abhishekam', 'festival' => 'Festival fund', 'maintenance' => 'Maintenance', 'other' => 'Other'];
// Donation categories (migration 010) name the purposes now; the map above still labels the old keys.
try {
    if (payTablesExist()) {
        foreach (payCategoryNames($db) as $slug => $names) $purposeLabels[$slug] = (string) $names['en'];
    }
} catch (Throwable $e) {
    error_log('[dashboard] donation categories unavailable: ' . $e->getMessage());
}
$purposeShares = [];
$purposeTones  = ['gold', 'maroon', 'moon', 'sage', 'info', 'warning'];
foreach ($purposes as $i => $p) {
    $purposeShares[] = ['label' => $purposeLabels[$p['p']] ?? ucfirst($p['p']), 'value' => (float) $p['total'], 'hint' => adminFmtMoney((float) $p['total']), 'tone' => $purposeTones[$i % count($purposeTones)]];
}

// ── Recent lists ─────────────────────────────────────────────────────────────
$recent_bookings = $db->query("SELECT id, devotee_name, seva_name, preferred_date, status, created_at FROM seva_bookings ORDER BY created_at DESC LIMIT 6")->fetchAll();
$next_events     = $db->query("SELECT title_en, title_ta, event_date FROM events WHERE is_active = 1 AND event_date >= CURDATE() ORDER BY event_date ASC LIMIT 5")->fetchAll();

// Activity feed: union of the three devotee-facing streams
// (amount is carried in its own numeric column — casting it to CHAR inside the
//  UNION would pick the connection collation and fail with "illegal mix of collations")
$feed = $db->query("
    SELECT 'booking'  AS kind, id, devotee_name AS who, seva_name AS what, status AS extra, NULL AS amount, created_at FROM seva_bookings
    UNION ALL
    SELECT 'donation' AS kind, id, name AS who, COALESCE(purpose, '') AS what, " . ($hasPayCols ? "COALESCE(source, 'pledge')" : "'pledge'") . " AS extra, {$netAmountSql} AS amount, created_at FROM donations WHERE {$countableSql}
    UNION ALL
    SELECT 'message'  AS kind, id, name AS who, LEFT(message, 90) AS what, '' AS extra, NULL AS amount, created_at FROM contact_messages
    ORDER BY created_at DESC LIMIT 12
")->fetchAll();

$settings = [];
try {
    foreach ($db->query("SELECT key_name, val FROM homepage_settings")->fetchAll() as $r) $settings[$r['key_name']] = $r['val'] === '1';
} catch (Throwable) {
    // table optional
}

$actions = '<a href="/admin/bulk_upload.php" class="btn btn-gold btn--sm">' . adminIcon('upload') . 'Bulk upload</a>';
adminHeader('Dashboard', 'Overview', ['actions' => $actions]);

$today = new DateTime('now', new DateTimeZone('Asia/Kolkata'));
echo adminPageIntro(
    'Namaskaram, ' . h((string) ($_SESSION['admin_user'] ?? 'admin')) . '. ' . $today->format('l, d F Y') . ' · ' . $pending_bookings . ' booking' . ($pending_bookings === 1 ? '' : 's') . ' awaiting confirmation.',
    '<a href="/admin/events.php#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . 'New event</a>' .
    '<a href="/admin/announcements.php#new" class="btn btn--sm">' . adminIcon('megaphone') . 'Announcement</a>' .
    '<a href="/admin/sevas.php#new" class="btn btn--sm">' . adminIcon('sparkles') . 'Seva</a>' .
    '<a href="/admin/gallery.php#new" class="btn btn--sm">' . adminIcon('image') . 'Photo</a>'
);

$kpis = [
    ['label' => 'Total donations',  'value' => adminFmtMoney($donations_total), 'icon' => 'banknote', 'href' => '/admin/donations.php', 'variant' => 'accent', 'sub' => $counts['donations'] . ($hasPayCols ? ' donation' : ' pledge') . ($counts['donations'] === 1 ? '' : 's') . ' recorded'],
    ['label' => 'This month',       'value' => adminFmtMoney($donations_month), 'icon' => 'trending', 'href' => '/admin/donations.php', 'delta' => $delta, 'deltaDown' => $deltaDown],
];
if ($onlineMonth !== null) {
    $onlineCount = (int) $onlineMonth['c'];
    $kpis[] = ['label' => 'Online payments this month', 'value' => adminFmtMoney((float) $onlineMonth['total']), 'icon' => 'landmark', 'href' => '/admin/payments.php',
               'sub' => $onlineCount . ' payment' . ($onlineCount === 1 ? '' : 's') . ' through CCAvenue'];
}
array_push($kpis,
    ['label' => 'Pending bookings', 'value' => $pending_bookings,               'icon' => 'clipboard', 'href' => '/admin/seva_bookings.php?status=pending', 'sub' => $counts['seva_bookings'] . ' total'],
    ['label' => 'Upcoming events',  'value' => $upcoming_events,                'icon' => 'calendar',  'href' => '/admin/events.php', 'sub' => $counts['events'] . ' in total'],
    ['label' => 'Messages (7 days)','value' => $messages_week,                  'icon' => 'mail',      'href' => '/admin/contact_messages.php', 'sub' => $counts['contact_messages'] . ' all time'],
);
if ($registrations !== null) {
    $familyMembers = (int) $registrations['members'];
    $kpis[] = ['label' => 'Registered families', 'value' => (int) $registrations['families'], 'icon' => 'users', 'href' => '/admin/devotees.php',
               'sub' => $familyMembers . ' family member' . ($familyMembers === 1 ? '' : 's')];
    $kpis[] = ['label' => 'Possible duplicates', 'value' => (int) $registrations['duplicates'], 'icon' => 'alert', 'href' => '/admin/devotees.php?status=duplicates',
               'sub' => 'Registrations sharing a phone'];
}
$kpis[] = ['label' => 'Sevas',    'value' => $counts['sevas'],    'icon' => 'sparkles',   'href' => '/admin/sevas.php'];
$kpis[] = ['label' => 'Poojas',   'value' => $counts['poojas'],   'icon' => 'flame',      'href' => '/admin/poojas.php'];
$kpis[] = ['label' => 'Sponsors', 'value' => $counts['sponsors'], 'icon' => 'heart-hands','href' => '/admin/sponsors.php'];
echo adminKpi($kpis);
?>

<div class="dash-grid">
  <section class="card card--static">
    <div class="card__head">
      <h2><?= adminIcon('trending', 'ico--sm') ?> Donations · last 12 months</h2>
      <a href="/admin/donations.php?export=csv" class="btn btn-ghost btn--sm"><?= adminIcon('download') ?> CSV</a>
    </div>
    <div class="card__body">
      <?php if ($donations_total > 0): ?>
        <?= adminBars($series, 'Donations by month') ?>
      <?php else: ?>
        <?= adminEmpty('banknote', 'No donations recorded yet', 'Pledges submitted on the public Donations page and bulk imports will chart here.', '<a href="/admin/bulk_upload.php?entity=donations" class="btn btn--sm">' . adminIcon('upload') . 'Import past donations</a>', true) ?>
      <?php endif; ?>
    </div>
  </section>

  <section class="card card--static">
    <div class="card__head">
      <h2><?= adminIcon('clipboard', 'ico--sm') ?> Bookings by status</h2>
      <a href="/admin/seva_bookings.php" class="btn btn-ghost btn--sm">Manage <?= adminIcon('arrow-right', 'ico--sm') ?></a>
    </div>
    <div class="card__body">
      <?php if ($counts['seva_bookings'] > 0): ?>
        <?= adminShares($shares, 'Seva bookings by status') ?>
      <?php else: ?>
        <?= adminEmpty('clipboard', 'No bookings yet', 'Online seva requests from the public site will appear here.', '', true) ?>
      <?php endif; ?>
      <?php if ($purposeShares): ?>
        <h3 class="subhead">Donations by purpose</h3>
        <?= adminShares($purposeShares, 'Donations by purpose') ?>
      <?php endif; ?>
    </div>
  </section>
</div>

<div class="dash-grid dash-grid--3">
  <section class="card card--static">
    <div class="card__head">
      <h2><?= adminIcon('activity', 'ico--sm') ?> Recent activity</h2>
      <?php if (adminCan('audit.view')): ?>
        <a href="/admin/audit_log.php" class="btn btn-ghost btn--sm">CMS audit log <?= adminIcon('arrow-right', 'ico--sm') ?></a>
      <?php endif; ?>
    </div>
    <?php if ($feed): ?>
      <div class="feed">
        <?php foreach ($feed as $f): ?>
          <?php
            [$ico, $tone, $text, $href] = match ($f['kind']) {
                'booking'  => ['clipboard', 'info',    '<strong>' . h($f['who']) . '</strong> requested <strong>' . h($f['what']) . '</strong> ' . adminBadge(ucfirst($f['extra']), adminStatusTone($f['extra'])), '/admin/seva_bookings.php'],
                'donation' => ['banknote',  'gold',    '<strong>' . h($f['who']) . '</strong> ' . ($f['extra'] === 'online' ? 'gave' : 'pledged') . ' <strong>' . adminFmtMoney((float) $f['amount']) . '</strong>' . ($f['what'] ? ' for ' . h($purposeLabels[$f['what']] ?? $f['what']) : '') . ($f['extra'] === 'online' ? ' ' . adminBadge('Online', 'gold') : ''), $f['extra'] === 'online' ? '/admin/payments.php' : '/admin/donations.php'],
                default    => ['mail',      'success', '<strong>' . h($f['who']) . '</strong> wrote: “' . h($f['what']) . (mb_strlen($f['what']) >= 90 ? '…' : '') . '”', '/admin/contact_messages.php'],
            };
          ?>
          <a class="feed__item" href="<?= $href ?>">
            <span class="feed__icon feed__icon--<?= $tone ?>"><?= adminIcon($ico) ?></span>
            <span class="feed__body"><?= $text ?></span>
            <time class="feed__time" datetime="<?= h($f['created_at']) ?>"><?= adminAgo($f['created_at']) ?></time>
          </a>
        <?php endforeach; ?>
      </div>
    <?php else: ?>
      <div class="card__body"><?= adminEmpty('activity', 'Nothing yet', 'Bookings, pledges and messages will stream in here.', '', true) ?></div>
    <?php endif; ?>
  </section>

  <section class="card card--static">
    <div class="card__head">
      <h2><?= adminIcon('calendar', 'ico--sm') ?> Upcoming events</h2>
      <a href="/admin/events.php" class="btn btn-ghost btn--sm">Manage <?= adminIcon('arrow-right', 'ico--sm') ?></a>
    </div>
    <?php if ($next_events): ?>
      <div class="mini-list">
        <?php foreach ($next_events as $ev): $d = new DateTime($ev['event_date']); ?>
          <div class="mini-list__item">
            <div class="date-tile"><div class="date-tile__day"><?= $d->format('d') ?></div><div class="date-tile__month"><?= $d->format('M') ?></div></div>
            <div>
              <div class="mini-list__title"><?= h($ev['title_en']) ?></div>
              <div class="mini-list__sub" lang="ta"><?= h($ev['title_ta']) ?></div>
            </div>
          </div>
        <?php endforeach; ?>
      </div>
    <?php else: ?>
      <div class="card__body"><?= adminEmpty('calendar', 'Nothing scheduled', 'Add an event to show it on the website.', '<a href="/admin/events.php#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . 'New event</a>', true) ?></div>
    <?php endif; ?>
  </section>

  <section class="card card--static">
    <div class="card__head">
      <h2><?= adminIcon('house', 'ico--sm') ?> Homepage health</h2>
      <a href="/admin/settings.php" class="btn btn-ghost btn--sm">Settings <?= adminIcon('arrow-right', 'ico--sm') ?></a>
    </div>
    <div class="card__body">
      <dl class="dl-grid">
        <dt>Active widgets</dt><dd><?= $active_widgets ?> of <?= $counts['homepage_widgets'] ?> <a class="text-xs" href="/admin/homepage_widgets.php">manage</a></dd>
        <dt>Announcements</dt><dd><?= $counts['announcements'] ?></dd>
        <dt>Gallery photos</dt><dd><?= $counts['gallery'] ?></dd>
        <dt>Pournami section</dt><dd><?= adminBadge(($settings['show_pournami_section'] ?? true) ? 'Visible' : 'Hidden', ($settings['show_pournami_section'] ?? true) ? 'success' : 'muted') ?></dd>
        <dt>Nalla Neram strip</dt><dd><?= adminBadge(($settings['show_nalla_strip'] ?? true) ? 'Visible' : 'Hidden', ($settings['show_nalla_strip'] ?? true) ? 'success' : 'muted') ?></dd>
        <dt>Donor ticker</dt><dd><?= adminBadge(($settings['show_donor_ticker'] ?? true) ? 'Visible' : 'Hidden', ($settings['show_donor_ticker'] ?? true) ? 'success' : 'muted') ?></dd>
      </dl>
      <div class="cluster mt-4">
        <a href="/" target="_blank" rel="noopener" class="btn btn--sm"><?= adminIcon('external') ?> Preview site</a>
      </div>
    </div>
  </section>
</div>

<?php if ($liveHealth !== null): ?>
<?php
  $lh = $liveHealth;
  $lhIssues = array_sum(array_intersect_key($lh['counts'], array_flip(LIVE_HEALTH_ISSUE_LEVELS)));
  $lhTitle = static fn(array $s): string => $s['title_en'] !== '' ? $s['title_en'] : $s['title_ta'];
  $lhAgo = static fn(?string $iso): string => $iso ? adminAgo($iso) : 'never';
  $lhTone = $lh['automation']['ready'] ? ($lhIssues > 0 ? 'warning' : 'success') : 'muted';
?>
<section class="card card--static" id="live-health">
  <div class="card__head">
    <h2><?= adminIcon('activity', 'ico--sm') ?> Live Darshan</h2>
    <div class="cluster">
      <a href="/admin/live_streams.php?f=live" class="btn btn-ghost btn--sm">Streams <?= adminIcon('arrow-right', 'ico--sm') ?></a>
      <?php if (adminCan('live.provider')): ?>
        <a href="/admin/live_settings.php" class="btn btn-ghost btn--sm">YouTube automation <?= adminIcon('arrow-right', 'ico--sm') ?></a>
      <?php endif; ?>
    </div>
  </div>
  <div class="card__body">
    <div class="cluster live-health__summary">
      <?= adminBadge($lh['automation']['ready'] ? 'Automation on' : 'Automation off', $lhTone) ?>
      <?= adminBadge($lhIssues === 0 ? 'No issues' : $lhIssues . ' need' . ($lhIssues === 1 ? 's' : '') . ' attention', $lhIssues === 0 ? 'success' : 'warning') ?>
      <?php if ($lh['automation']['quota_blocked_until']): ?><?= adminBadge('YouTube quota used up', 'danger') ?><?php endif; ?>
      <?php if ($lh['automation']['oauth_revoked_at']): ?><?= adminBadge('OAuth switched off', 'danger') ?><?php endif; ?>
      <span class="text-muted text-xs">Last YouTube check: <?= h($lhAgo($lh['last_check_at'])) ?> · <?= (int) $lh['errors_24h'] ?> sync error<?= $lh['errors_24h'] === 1 ? '' : 's' ?> in 24 h</span>
    </div>
    <?php if (!$lh['automation']['ready'] && $lh['automation']['reason'] !== ''): ?>
      <p class="text-muted text-sm mt-2"><?= h($lh['automation']['reason']) ?></p>
    <?php endif; ?>
    <?php if ($lh['automation']['provider_notice'] !== ''): ?>
      <p class="text-sm mt-2 live-health__notice"><?= h($lh['automation']['provider_notice']) ?></p>
    <?php endif; ?>

    <?php if ($lh['now']): ?>
      <div class="table-wrap mt-4">
        <table class="table table--compact">
          <thead><tr><th>Broadcast</th><th>Status</th><th>Provider</th><th>Started</th><th>Viewers</th><th>Last check</th><th>Health</th></tr></thead>
          <tbody>
          <?php foreach ($lh['now'] as $s): ?>
            <tr>
              <td data-label="Broadcast"><a href="/admin/live_streams.php?edit=<?= (int) $s['id'] ?>"><?= h($lhTitle($s)) ?></a></td>
              <td data-label="Status"><?= adminBadge(liveStatusLabel($s['status']), liveStatusTone($s['status']), liveStatusIsLive($s['status'])) ?></td>
              <td data-label="Provider"><?= h(ucfirst($s['provider'])) ?></td>
              <td data-label="Started"><?= $s['actual_start_at'] ? '<time datetime="' . h($s['actual_start_at']) . '">' . h(adminAgo($s['actual_start_at'])) . '</time>' : '<span class="text-muted">—</span>' ?></td>
              <td data-label="Viewers"><?= $s['viewer_count'] !== null ? number_format($s['viewer_count']) . ($s['viewers'] === null ? ' <span class="text-muted text-xs">(' . h($lhAgo($s['viewer_count_at'])) . ')</span>' : '') : '<span class="text-muted">—</span>' ?></td>
              <td data-label="Last check"><?= h($lhAgo($s['sync']['checked_at'])) ?></td>
              <td data-label="Health"><?= adminBadge($s['health']['label'], $s['health']['tone']) ?><?php if ($s['health']['reason'] !== ''): ?><span class="cell-sub"><?= h($s['health']['reason']) ?></span><?php endif; ?></td>
            </tr>
          <?php endforeach; ?>
          </tbody>
        </table>
      </div>
    <?php else: ?>
      <p class="text-muted text-sm mt-4">Nothing is live right now.
        <?php if ($lh['next']): ?>
          Next: <a href="/admin/live_streams.php?edit=<?= (int) $lh['next']['id'] ?>"><?= h($lhTitle($lh['next'])) ?></a>
          <?php if ($lh['next']['local']['date']): ?>on <?= h($lh['next']['local']['date']) ?> at <?= h((string) $lh['next']['local']['start_time']) ?> <?php endif; ?>
          <?= adminBadge($lh['next']['health']['label'], $lh['next']['health']['tone']) ?>
        <?php else: ?>
          No broadcast is scheduled.
        <?php endif; ?>
      </p>
    <?php endif; ?>

    <?php if ($lh['issues']): ?>
      <h3 class="subhead">Needs a person</h3>
      <ul class="live-health__issues">
        <?php foreach ($lh['issues'] as $s): ?>
          <li>
            <?= adminBadge($s['health']['label'], $s['health']['tone']) ?>
            <a href="/admin/live_streams.php?edit=<?= (int) $s['id'] ?>"><?= h($lhTitle($s)) ?></a>
            <span class="text-muted">(<?= h(liveStatusLabel($s['status'])) ?>)</span>
            <?php if ($s['health']['reason'] !== ''): ?> — <?= h($s['health']['reason']) ?><?php endif; ?>
          </li>
        <?php endforeach; ?>
      </ul>
    <?php endif; ?>
  </div>
</section>
<?php endif; ?>

<section class="card card--static">
  <div class="card__head">
    <h2><?= adminIcon('clipboard', 'ico--sm') ?> Recent seva bookings</h2>
    <a href="/admin/seva_bookings.php" class="btn btn-ghost btn--sm">View all <?= adminIcon('arrow-right', 'ico--sm') ?></a>
  </div>
  <?php if ($recent_bookings): ?>
  <div class="table-wrap table-wrap--flush">
    <table class="table" data-no-search>
      <thead><tr><th scope="col">Devotee</th><th scope="col">Seva</th><th scope="col">Preferred</th><th scope="col">Received</th><th scope="col">Status</th></tr></thead>
      <tbody>
        <?php foreach ($recent_bookings as $b): ?>
        <tr>
          <td><span class="cell-title"><?= h($b['devotee_name']) ?></span></td>
          <td><?= h($b['seva_name']) ?></td>
          <td class="cell-date"><?= adminFmtDate($b['preferred_date']) ?></td>
          <td class="cell-date"><?= adminAgo($b['created_at']) ?></td>
          <td><?= adminBadge(ucfirst($b['status']), adminStatusTone($b['status'])) ?></td>
        </tr>
        <?php endforeach; ?>
      </tbody>
    </table>
  </div>
  <?php else: ?>
    <div class="card__body"><?= adminEmpty('clipboard', 'No bookings yet', 'Online seva requests will appear here.', '', true) ?></div>
  <?php endif; ?>
</section>

<?php adminFooter(); ?>
