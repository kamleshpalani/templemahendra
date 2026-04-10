<?php
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db   = getDB();
$rows = $db->query('SELECT * FROM contact_messages ORDER BY created_at DESC')->fetchAll();

adminHeader('Contact Messages');
?>

<table class="admin-table">
  <thead>
    <tr><th>#</th><th>Name</th><th>Phone</th><th>Message</th><th>Date</th></tr>
  </thead>
  <tbody>
    <?php foreach ($rows as $i => $row): ?>
    <tr>
      <td><?= $i + 1 ?></td>
      <td><?= htmlspecialchars($row['name']) ?></td>
      <td><?= htmlspecialchars($row['phone']) ?></td>
      <td><?= htmlspecialchars($row['message']) ?></td>
      <td><?= htmlspecialchars($row['created_at']) ?></td>
    </tr>
    <?php endforeach; ?>
  </tbody>
</table>

<?php adminFooter(); ?>
