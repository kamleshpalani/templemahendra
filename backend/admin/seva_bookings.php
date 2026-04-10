<?php
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

// ── Status update action ────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['id'], $_POST['status'])) {
    $allowed = ['pending', 'confirmed', 'completed', 'cancelled'];
    $newStatus = in_array($_POST['status'], $allowed, true) ? $_POST['status'] : 'pending';
    $stmt = $db->prepare('UPDATE seva_bookings SET status = :s WHERE id = :id');
    $stmt->execute([':s' => $newStatus, ':id' => (int) $_POST['id']]);
    header('Location: /admin/seva_bookings.php');
    exit;
}

// ── Filters ─────────────────────────────────────────────────────────────────
$filterStatus = in_array($_GET['status'] ?? '', ['pending','confirmed','completed','cancelled'])
    ? $_GET['status'] : '';

$sql = 'SELECT * FROM seva_bookings';
$params = [];
if ($filterStatus !== '') {
    $sql .= ' WHERE status = :status';
    $params[':status'] = $filterStatus;
}
$sql .= ' ORDER BY created_at DESC LIMIT 200';

$stmt = $db->prepare($sql);
$stmt->execute($params);
$rows = $stmt->fetchAll();

// Status badge colours
$badge = [
    'pending'   => 'background:#fef3c7;color:#92400e;',
    'confirmed' => 'background:#d1fae5;color:#065f46;',
    'completed' => 'background:#dbeafe;color:#1e40af;',
    'cancelled' => 'background:#fee2e2;color:#991b1b;',
];

adminHeader('Seva Bookings');
?>

<div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1.25rem;">
  <strong>Filter:</strong>
  <?php foreach (['', 'pending', 'confirmed', 'completed', 'cancelled'] as $s): ?>
  <a href="?status=<?= urlencode($s) ?>"
     style="padding:.3rem .8rem;border-radius:50px;text-decoration:none;font-size:.82rem;font-weight:600;
            <?= $filterStatus === $s ? 'background:var(--maroon,#991b1b);color:#fff;' : 'background:#f3f4f6;color:#374151;' ?>">
    <?= $s === '' ? 'All' : ucfirst($s) ?>
  </a>
  <?php endforeach; ?>
  <span style="margin-left:auto;color:#6b7280;font-size:.82rem;"><?= count($rows) ?> record(s)</span>
</div>

<div style="overflow-x:auto;">
<table class="admin-table">
  <thead>
    <tr>
      <th>#</th>
      <th>Name</th>
      <th>Phone</th>
      <th>Seva</th>
      <th>Preferred Date</th>
      <th>Note</th>
      <th>Received</th>
      <th>Status</th>
      <th>Action</th>
    </tr>
  </thead>
  <tbody>
    <?php if (empty($rows)): ?>
    <tr><td colspan="9" style="text-align:center;padding:2rem;color:#6b7280;">No bookings found.</td></tr>
    <?php else: ?>
    <?php foreach ($rows as $i => $row): ?>
    <tr>
      <td><?= $i + 1 ?></td>
      <td><?= htmlspecialchars($row['devotee_name']) ?></td>
      <td>
        <a href="tel:<?= htmlspecialchars($row['phone']) ?>" style="text-decoration:none;color:inherit;">
          <?= htmlspecialchars($row['phone']) ?>
        </a>
      </td>
      <td><?= htmlspecialchars($row['seva_name']) ?></td>
      <td><?= htmlspecialchars($row['preferred_date'] ?? '—') ?></td>
      <td style="max-width:200px;white-space:normal;font-size:.82rem;">
        <?= htmlspecialchars($row['message'] ?? '') ?>
      </td>
      <td style="white-space:nowrap;font-size:.82rem;"><?= htmlspecialchars($row['created_at']) ?></td>
      <td>
        <span style="padding:.25rem .65rem;border-radius:50px;font-size:.75rem;font-weight:700;
                     <?= $badge[$row['status']] ?? '' ?>">
          <?= htmlspecialchars(ucfirst($row['status'])) ?>
        </span>
      </td>
      <td>
        <form method="POST" style="display:inline">
          <input type="hidden" name="id" value="<?= (int)$row['id'] ?>">
          <select name="status" onchange="this.form.submit()"
                  style="font-size:.8rem;padding:.25rem .4rem;border-radius:.4rem;border:1px solid #d1d5db;cursor:pointer;">
            <?php foreach (['pending','confirmed','completed','cancelled'] as $s): ?>
            <option value="<?= $s ?>" <?= $row['status'] === $s ? 'selected' : '' ?>>
              <?= ucfirst($s) ?>
            </option>
            <?php endforeach; ?>
          </select>
        </form>
      </td>
    </tr>
    <?php endforeach; ?>
    <?php endif; ?>
  </tbody>
</table>
</div>

<?php adminFooter(); ?>
