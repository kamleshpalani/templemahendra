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

// Status badge variants
$badge = [
    'pending'   => 'warning',
    'confirmed' => 'info',
    'completed' => 'success',
    'cancelled' => 'danger',
];

adminHeader('Seva Bookings', 'Devotees');
?>

<div class="table-toolbar">
  <nav class="stepper" style="margin:0" aria-label="Filter by status">
    <?php foreach (['', 'pending', 'confirmed', 'completed', 'cancelled'] as $s): ?>
    <a href="?status=<?= urlencode($s) ?>" class="step <?= $filterStatus === $s ? 'step--active' : '' ?>" <?= $filterStatus === $s ? 'aria-current="page"' : '' ?>>
      <?= $s === '' ? 'All' : ucfirst($s) ?>
    </a>
    <?php endforeach; ?>
  </nav>
  <span class="table-toolbar__count"><?= count($rows) ?> record(s)</span>
</div>

<div class="table-wrap">
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
    <tr class="table-empty"><td colspan="9">No bookings found.</td></tr>
    <?php else: ?>
    <?php foreach ($rows as $i => $row): ?>
    <tr>
      <td><?= $i + 1 ?></td>
      <td><strong><?= htmlspecialchars($row['devotee_name']) ?></strong></td>
      <td>
        <a href="tel:<?= htmlspecialchars($row['phone']) ?>">
          <?= htmlspecialchars($row['phone']) ?>
        </a>
      </td>
      <td><?= htmlspecialchars($row['seva_name']) ?></td>
      <td><?= htmlspecialchars($row['preferred_date'] ?? '—') ?></td>
      <td style="max-width:220px;white-space:normal;"><small><?= htmlspecialchars($row['message'] ?? '') ?></small></td>
      <td style="white-space:nowrap;"><small><?= htmlspecialchars($row['created_at']) ?></small></td>
      <td>
        <span class="badge badge--<?= $badge[$row['status']] ?? 'muted' ?>">
          <?= htmlspecialchars(ucfirst($row['status'])) ?>
        </span>
      </td>
      <td>
        <form method="POST">
          <input type="hidden" name="id" value="<?= (int)$row['id'] ?>">
          <label class="sr-only" for="st-<?= (int)$row['id'] ?>">Change status</label>
          <select id="st-<?= (int)$row['id'] ?>" name="status" onchange="this.form.submit()" style="min-height:34px;padding:.25rem 2rem .25rem .6rem;font-size:.8rem;">
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
