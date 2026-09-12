<?php
// backend/admin/index.php — Dashboard: KPIs, analytics, activity, quick actions
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

// ── Counts ───────────────────────────────────────────────────────────────────
$counts = [];
foreach (['sevas', 'events', 'announcements', 'donations', 'gallery', 'seva_bookings', 'poojas', 'sponsors', 'homepage_widgets', 'contact_messages'] as $tbl) {
    $counts[$tbl] = (int) $db->query("SELECT COUNT(*) FROM `$tbl`")->fetchColumn();
}

$donations_total  = (float) $db->query("SELECT COALESCE(SUM(amount),0) FROM donations")->fetchColumn();
$donations_month  = (float) $db->query("SELECT COALESCE(SUM(amount),0) FROM donations WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')")->fetchColumn();
$donations_prev   = (float) $db->query("SELECT COALESCE(SUM(amount),0) FROM donations WHERE created_at >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01') AND created_at < DATE_FORMAT(CURDATE(), '%Y-%m-01')")->fetchColumn();
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
$stmt = $db->query("SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, SUM(amount) AS total
                      FROM donations
                     WHERE created_at >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 11 MONTH)
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

$purposes = $db->query("SELECT COALESCE(NULLIF(purpose,''),'other') p, SUM(amount) total FROM donations GROUP BY p ORDER BY total DESC LIMIT 6")->fetchAll();
$purposeLabels = ['kumbabhishekam' => 'Kumbabhishekam', 'annadanam_hall' => 'Annadanam hall', 'annadanam' => 'Annadanam', 'abhishekam' => 'Abhishekam', 'festival' => 'Festival fund', 'maintenance' => 'Maintenance', 'other' => 'Other'];
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
    SELECT 'donation' AS kind, id, name AS who, COALESCE(purpose, '') AS what, '' AS extra, amount, created_at FROM donations
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

echo adminKpi([
    ['label' => 'Total donations',  'value' => adminFmtMoney($donations_total), 'icon' => 'banknote', 'href' => '/admin/donations.php', 'variant' => 'accent', 'sub' => $counts['donations'] . ' pledges recorded'],
    ['label' => 'This month',       'value' => adminFmtMoney($donations_month), 'icon' => 'trending', 'href' => '/admin/donations.php', 'delta' => $delta, 'deltaDown' => $deltaDown],
    ['label' => 'Pending bookings', 'value' => $pending_bookings,               'icon' => 'clipboard', 'href' => '/admin/seva_bookings.php?status=pending', 'sub' => $counts['seva_bookings'] . ' total'],
    ['label' => 'Upcoming events',  'value' => $upcoming_events,                'icon' => 'calendar',  'href' => '/admin/events.php', 'sub' => $counts['events'] . ' in total'],
    ['label' => 'Messages (7 days)','value' => $messages_week,                  'icon' => 'mail',      'href' => '/admin/contact_messages.php', 'sub' => $counts['contact_messages'] . ' all time'],
    ['label' => 'Sevas',            'value' => $counts['sevas'],                'icon' => 'sparkles',  'href' => '/admin/sevas.php'],
    ['label' => 'Poojas',           'value' => $counts['poojas'],               'icon' => 'flame',     'href' => '/admin/poojas.php'],
    ['label' => 'Sponsors',         'value' => $counts['sponsors'],             'icon' => 'heart-hands','href' => '/admin/sponsors.php'],
]);
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
    </div>
    <?php if ($feed): ?>
      <div class="feed">
        <?php foreach ($feed as $f): ?>
          <?php
            [$ico, $tone, $text, $href] = match ($f['kind']) {
                'booking'  => ['clipboard', 'info',    '<strong>' . h($f['who']) . '</strong> requested <strong>' . h($f['what']) . '</strong> ' . adminBadge(ucfirst($f['extra']), adminStatusTone($f['extra'])), '/admin/seva_bookings.php'],
                'donation' => ['banknote',  'gold',    '<strong>' . h($f['who']) . '</strong> pledged <strong>' . adminFmtMoney((float) $f['amount']) . '</strong>' . ($f['what'] ? ' for ' . h($purposeLabels[$f['what']] ?? $f['what']) : ''), '/admin/donations.php'],
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
