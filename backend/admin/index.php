<?php
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

$counts = [];
foreach (['sevas', 'events', 'announcements', 'donations', 'gallery', 'seva_bookings', 'poojas', 'sponsors', 'homepage_widgets'] as $tbl) {
    $counts[$tbl] = (int) $db->query("SELECT COUNT(*) FROM $tbl")->fetchColumn();
}

$donations_total = (float) $db->query("SELECT COALESCE(SUM(amount),0) FROM donations")->fetchColumn();
$recent_donations = $db->query(
    "SELECT name, amount, purpose, created_at FROM donations ORDER BY created_at DESC LIMIT 5"
)->fetchAll();

adminHeader('Dashboard');
?>

<div class="stats-grid">
  <?php foreach ([
    ['Sevas',           $counts['sevas'],            '🙏'],
    ['Events',          $counts['events'],           '📅'],
    ['Announcements',   $counts['announcements'],    '📢'],
    ['Gallery Photos',  $counts['gallery'],          '🖼️'],
    ['Seva Bookings',   $counts['seva_bookings'],    '📋'],
    ['Poojas',          $counts['poojas'],           '🛕'],
    ['Sponsors',        $counts['sponsors'],         '💛'],
    ['Homepage Widgets',$counts['homepage_widgets'], '🏮'],
    ['Total Donations', '₹' . number_format($donations_total, 2), '💰'],
  ] as [$label, $val, $icon]): ?>
  <div class="stat-card">
    <span class="stat-card__icon"><?= $icon ?></span>
    <div class="stat-card__val"><?= htmlspecialchars((string)$val) ?></div>
    <div class="stat-card__label"><?= htmlspecialchars($label) ?></div>
  </div>
  <?php endforeach; ?>
</div>

<h2 style="margin-top:2rem">Recent Donations</h2>
<table class="admin-table">
  <thead>
    <tr><th>Name</th><th>Amount</th><th>Purpose</th><th>Date</th></tr>
  </thead>
  <tbody>
    <?php foreach ($recent_donations as $row): ?>
    <tr>
      <td><?= htmlspecialchars($row['name']) ?></td>
      <td>₹<?= number_format($row['amount'], 2) ?></td>
      <td><?= htmlspecialchars($row['purpose'] ?: '—') ?></td>
      <td><?= htmlspecialchars($row['created_at']) ?></td>
    </tr>
    <?php endforeach; ?>
  </tbody>
</table>

<?php adminFooter(); ?>
