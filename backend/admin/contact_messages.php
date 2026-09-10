<?php
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db   = getDB();
$rows = $db->query('SELECT * FROM contact_messages ORDER BY created_at DESC')->fetchAll();

adminHeader('Contact Messages', 'Devotees');
?>

<div class="table-wrap">
<table class="admin-table">
  <thead>
    <tr><th>#</th><th>Name</th><th>Phone</th><th>Message</th><th>Date</th></tr>
  </thead>
  <tbody>
    <?php foreach ($rows as $i => $row): ?>
    <tr>
      <td><?= $i + 1 ?></td>
      <td><strong><?= htmlspecialchars($row['name']) ?></strong></td>
      <td><a href="tel:<?= htmlspecialchars($row['phone']) ?>"><?= htmlspecialchars($row['phone']) ?></a></td>
      <td style="white-space:normal;max-width:420px"><?= nl2br(htmlspecialchars($row['message'])) ?></td>
      <td><small><?= htmlspecialchars($row['created_at']) ?></small></td>
    </tr>
    <?php endforeach; ?>
    <?php if (!$rows): ?><tr class="table-empty"><td colspan="5">No messages yet. Enquiries from the contact form appear here.</td></tr><?php endif; ?>
  </tbody>
</table>
</div>

<?php adminFooter(); ?>
