<?php
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db   = getDB();
$rows = $db->query('SELECT * FROM donations ORDER BY created_at DESC')->fetchAll();
$total = (float) $db->query('SELECT COALESCE(SUM(amount),0) FROM donations')->fetchColumn();
$month = (float) $db->query("SELECT COALESCE(SUM(amount),0) FROM donations WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')")->fetchColumn();

// CSV export (report)
if (isset($_GET['export']) && $_GET['export'] === 'csv') {
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="donations-' . date('Y-m-d') . '.csv"');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF"); // BOM so Excel reads Tamil correctly
    fputcsv($out, ['id', 'name', 'phone', 'amount', 'purpose', 'message', 'created_at']);
    foreach ($rows as $r) {
        fputcsv($out, [$r['id'], $r['name'], $r['phone'], $r['amount'], $r['purpose'], $r['message'], $r['created_at']]);
    }
    fclose($out);
    exit;
}

adminHeader('Donations', 'Devotees');
?>

<div class="stats-grid mb-4">
  <div class="stat-card stat-card--accent" style="--i:0">
    <span class="stat-card__icon" aria-hidden="true">💰</span>
    <div><div class="stat-card__val">₹<?= number_format($total, 0) ?></div><div class="stat-card__label">Total recorded</div></div>
  </div>
  <div class="stat-card" style="--i:1">
    <span class="stat-card__icon" aria-hidden="true">📈</span>
    <div><div class="stat-card__val">₹<?= number_format($month, 0) ?></div><div class="stat-card__label">This month</div></div>
  </div>
  <div class="stat-card" style="--i:2">
    <span class="stat-card__icon" aria-hidden="true">🧾</span>
    <div><div class="stat-card__val"><?= count($rows) ?></div><div class="stat-card__label">Pledges</div></div>
  </div>
</div>

<div class="cluster mb-4">
  <a href="?export=csv" class="btn btn-secondary btn-sm">⬇ Export CSV</a>
  <a href="/admin/bulk_upload.php?entity=donations" class="btn btn-ghost btn-sm">📤 Bulk import</a>
</div>

<div class="table-wrap">
<table class="admin-table">
  <thead>
    <tr><th>#</th><th>Name</th><th>Phone</th><th>Amount</th><th>Purpose</th><th>Message</th><th>Date</th></tr>
  </thead>
  <tbody>
    <?php foreach ($rows as $i => $row): ?>
    <tr>
      <td><?= $i + 1 ?></td>
      <td><strong><?= htmlspecialchars($row['name']) ?></strong></td>
      <td><a href="tel:<?= htmlspecialchars($row['phone']) ?>"><?= htmlspecialchars($row['phone']) ?></a></td>
      <td>₹<?= number_format($row['amount'], 2) ?></td>
      <td><?= $row['purpose'] ? '<span class="badge">' . htmlspecialchars($row['purpose']) . '</span>' : '—' ?></td>
      <td><small><?= htmlspecialchars(mb_substr((string) $row['message'], 0, 60)) ?></small></td>
      <td><small><?= htmlspecialchars($row['created_at']) ?></small></td>
    </tr>
    <?php endforeach; ?>
    <?php if (!$rows): ?><tr class="table-empty"><td colspan="7">No donations recorded yet.</td></tr><?php endif; ?>
  </tbody>
</table>
</div>

<?php adminFooter(); ?>
