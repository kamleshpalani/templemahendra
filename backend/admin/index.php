<?php
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

$counts = [];
foreach (['sevas', 'events', 'announcements', 'donations', 'gallery', 'seva_bookings', 'poojas', 'sponsors', 'homepage_widgets', 'contact_messages'] as $tbl) {
    $counts[$tbl] = (int) $db->query("SELECT COUNT(*) FROM `$tbl`")->fetchColumn();
}

$donations_total   = (float) $db->query("SELECT COALESCE(SUM(amount),0) FROM donations")->fetchColumn();
$donations_month   = (float) $db->query("SELECT COALESCE(SUM(amount),0) FROM donations WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')")->fetchColumn();
$pending_bookings  = (int) $db->query("SELECT COUNT(*) FROM seva_bookings WHERE status = 'pending'")->fetchColumn();
$upcoming_events   = (int) $db->query("SELECT COUNT(*) FROM events WHERE is_active = 1 AND event_date >= CURDATE()")->fetchColumn();
$messages_week     = (int) $db->query("SELECT COUNT(*) FROM contact_messages WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)")->fetchColumn();

$recent_donations = $db->query(
    "SELECT name, amount, purpose, created_at FROM donations ORDER BY created_at DESC LIMIT 6"
)->fetchAll();
$recent_bookings = $db->query(
    "SELECT devotee_name, seva_name, preferred_date, status, created_at FROM seva_bookings ORDER BY created_at DESC LIMIT 6"
)->fetchAll();
$next_events = $db->query(
    "SELECT title_en, title_ta, event_date FROM events WHERE is_active = 1 AND event_date >= CURDATE() ORDER BY event_date ASC LIMIT 5"
)->fetchAll();

$statusBadge = ['pending' => 'warning', 'confirmed' => 'info', 'completed' => 'success', 'cancelled' => 'danger'];

adminHeader('Dashboard', 'Overview');
?>

<div class="stats-grid" aria-label="Key metrics">
  <?php $i = 0; foreach ([
    ['Total Donations',  '₹' . number_format($donations_total, 0), '💰', '/admin/donations.php',     'accent'],
    ['This Month',       '₹' . number_format($donations_month, 0), '📈', '/admin/donations.php',     ''],
    ['Pending Bookings', $pending_bookings,                          '⏳', '/admin/seva_bookings.php', ''],
    ['Upcoming Events',  $upcoming_events,                           '📅', '/admin/events.php',        ''],
    ['Messages (7d)',    $messages_week,                             '✉️', '/admin/contact_messages.php', ''],
    ['Sevas',            $counts['sevas'],                           '🙏', '/admin/sevas.php',         ''],
    ['Poojas',           $counts['poojas'],                          '🛕', '/admin/poojas.php',        ''],
    ['Sponsors',         $counts['sponsors'],                        '💛', '/admin/sponsors.php',      ''],
    ['Announcements',    $counts['announcements'],                   '📢', '/admin/announcements.php', ''],
    ['Gallery Photos',   $counts['gallery'],                         '🖼️', '/admin/gallery.php',       ''],
  ] as [$label, $val, $icon, $href, $variant]): ?>
  <a class="stat-card <?= $variant ? "stat-card--$variant" : '' ?>" href="<?= $href ?>" style="--i:<?= $i++ ?>">
    <span class="stat-card__icon" aria-hidden="true"><?= $icon ?></span>
    <div>
      <div class="stat-card__val"><?= htmlspecialchars((string) $val) ?></div>
      <div class="stat-card__label"><?= htmlspecialchars($label) ?></div>
    </div>
  </a>
  <?php endforeach; ?>
</div>

<div class="quick-actions" aria-label="Quick actions">
  <a href="/admin/events.php" class="btn btn-primary btn-sm">＋ New Event</a>
  <a href="/admin/announcements.php" class="btn btn-secondary btn-sm">＋ Announcement</a>
  <a href="/admin/sevas.php" class="btn btn-secondary btn-sm">＋ Seva</a>
  <a href="/admin/gallery.php" class="btn btn-secondary btn-sm">＋ Upload Photo</a>
  <a href="/admin/bulk_upload.php" class="btn btn-gold btn-sm">📤 Bulk Upload</a>
</div>

<div class="admin-two-col" style="grid-template-columns: minmax(0,1.4fr) minmax(0,1fr)">
  <section class="card">
    <div class="card__head">
      <h3>Recent Seva Bookings</h3>
      <a href="/admin/seva_bookings.php" class="btn btn-ghost btn-sm">View all →</a>
    </div>
    <?php if ($recent_bookings): ?>
    <table class="admin-table" data-no-search>
      <thead><tr><th>Devotee</th><th>Seva</th><th>Preferred</th><th>Status</th></tr></thead>
      <tbody>
        <?php foreach ($recent_bookings as $b): ?>
        <tr>
          <td><strong><?= htmlspecialchars($b['devotee_name']) ?></strong></td>
          <td><?= htmlspecialchars($b['seva_name']) ?></td>
          <td><?= htmlspecialchars($b['preferred_date'] ?: '—') ?></td>
          <td><span class="badge badge--<?= $statusBadge[$b['status']] ?? 'muted' ?>"><?= htmlspecialchars(ucfirst($b['status'])) ?></span></td>
        </tr>
        <?php endforeach; ?>
      </tbody>
    </table>
    <?php else: ?>
      <div class="card__body"><div class="empty-state"><span class="empty-state__icon">📋</span><h3>No bookings yet</h3><p class="muted">Online seva requests will appear here.</p></div></div>
    <?php endif; ?>
  </section>

  <section class="card">
    <div class="card__head">
      <h3>Upcoming Events</h3>
      <a href="/admin/events.php" class="btn btn-ghost btn-sm">Manage →</a>
    </div>
    <div class="card__body" style="display:flex;flex-direction:column;gap:.6rem">
      <?php if ($next_events): foreach ($next_events as $ev): $d = new DateTime($ev['event_date']); ?>
        <div style="display:flex;align-items:center;gap:.85rem">
          <div style="min-width:52px;text-align:center;padding:.35rem .4rem;border-radius:10px;background:linear-gradient(160deg,var(--maroon),var(--maroon-deep));color:#fff;box-shadow:0 4px 12px rgba(153,27,27,.3)">
            <div style="font-size:1.15rem;font-weight:800;line-height:1"><?= $d->format('d') ?></div>
            <div style="font-size:.6rem;letter-spacing:.08em;text-transform:uppercase;color:var(--gold-bright)"><?= $d->format('M') ?></div>
          </div>
          <div style="min-width:0">
            <div style="font-weight:700;color:var(--text-1)"><?= htmlspecialchars($ev['title_en']) ?></div>
            <div class="muted" style="font-family:var(--font-tamil)"><?= htmlspecialchars($ev['title_ta']) ?></div>
          </div>
        </div>
      <?php endforeach; else: ?>
        <div class="empty-state"><span class="empty-state__icon">📅</span><h3>Nothing scheduled</h3><p class="muted">Add an event to show it on the website.</p></div>
      <?php endif; ?>
    </div>
  </section>
</div>

<section class="card mt-6">
  <div class="card__head">
    <h3>Recent Donations</h3>
    <a href="/admin/donations.php" class="btn btn-ghost btn-sm">View all →</a>
  </div>
  <?php if ($recent_donations): ?>
  <table class="admin-table" data-no-search>
    <thead><tr><th>Name</th><th>Amount</th><th>Purpose</th><th>Date</th></tr></thead>
    <tbody>
      <?php foreach ($recent_donations as $row): ?>
      <tr>
        <td><strong><?= htmlspecialchars($row['name']) ?></strong></td>
        <td>₹<?= number_format($row['amount'], 2) ?></td>
        <td><?= htmlspecialchars($row['purpose'] ?: '—') ?></td>
        <td><?= htmlspecialchars($row['created_at']) ?></td>
      </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
  <?php else: ?>
    <div class="card__body"><div class="empty-state"><span class="empty-state__icon">💰</span><h3>No donations recorded</h3></div></div>
  <?php endif; ?>
</section>

<?php adminFooter(); ?>
