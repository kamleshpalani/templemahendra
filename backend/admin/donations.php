<?php
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db   = getDB();
$rows = $db->query('SELECT * FROM donations ORDER BY created_at DESC')->fetchAll();
$total = (float) $db->query('SELECT COALESCE(SUM(amount),0) FROM donations')->fetchColumn();

adminHeader('Donations');
?>

<p><strong>Total Donations:</strong> ₹<?= number_format($total, 2) ?></p>

<table class="admin-table" style="margin-top:1rem">
  <thead>
    <tr><th>#</th><th>Name</th><th>Phone</th><th>Amount</th><th>Purpose</th><th>Message</th><th>Date</th></tr>
  </thead>
  <tbody>
    <?php foreach ($rows as $i => $row): ?>
    <tr>
      <td><?= $i + 1 ?></td>
      <td><?= htmlspecialchars($row['name']) ?></td>
      <td><?= htmlspecialchars($row['phone']) ?></td>
      <td>₹<?= number_format($row['amount'], 2) ?></td>
      <td><?= htmlspecialchars($row['purpose'] ?: '—') ?></td>
      <td><?= htmlspecialchars(mb_substr($row['message'], 0, 60)) ?></td>
      <td><?= htmlspecialchars($row['created_at']) ?></td>
    </tr>
    <?php endforeach; ?>
  </tbody>
</table>

<?php adminFooter(); ?>
