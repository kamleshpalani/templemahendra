<?php
// backend/admin/sponsors.php — Sponsor Manager
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db  = getDB();
$msg = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? '';

    if ($action === 'save') {
        $name      = sanitizeText($_POST['name']      ?? '');
        $phone     = sanitizeText($_POST['phone']     ?? '', 30);
        $note      = sanitizeText($_POST['note']      ?? '', 1000);
        $pooja_id  = ((int)($_POST['pooja_id'] ?? 0)) ?: null;
        $is_active = isset($_POST['is_active']) ? 1 : 0;
        $id        = (int)($_POST['id'] ?? 0);

        if ($name === '') {
            $msg = '<p class="alert alert--error">Sponsor name is required.</p>';
        } elseif ($id > 0) {
            $db->prepare('UPDATE sponsors SET name=:n,phone=:ph,note=:nt,pooja_id=:pid,is_active=:a WHERE id=:id')
               ->execute([':n'=>$name,':ph'=>$phone,':nt'=>$note,':pid'=>$pooja_id,':a'=>$is_active,':id'=>$id]);
            $msg = '<p class="alert alert--success">Sponsor updated.</p>';
        } else {
            $db->prepare('INSERT INTO sponsors (name,phone,note,pooja_id,is_active) VALUES (:n,:ph,:nt,:pid,:a)')
               ->execute([':n'=>$name,':ph'=>$phone,':nt'=>$note,':pid'=>$pooja_id,':a'=>$is_active]);
            $msg = '<p class="alert alert--success">Sponsor added.</p>';
        }
    } elseif ($action === 'delete') {
        $id = (int)($_POST['id'] ?? 0);
        if ($id > 0) {
            $db->prepare('DELETE FROM sponsors WHERE id=:id')->execute([':id'=>$id]);
            $msg = '<p class="alert alert--success">Deleted.</p>';
        }
    }
}

$rows = $db->query(
    'SELECT s.*, p.name_ta AS pooja_name
       FROM sponsors s
       LEFT JOIN poojas p ON p.id = s.pooja_id
      ORDER BY s.created_at DESC LIMIT 60'
)->fetchAll();

$editing = null;
if (isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM sponsors WHERE id=:id');
    $stmt->execute([':id' => (int)$_GET['edit']]);
    $editing = $stmt->fetch() ?: null;
}

// Fetch poojas for the dropdown
$poojas = $db->query(
    "SELECT id, name_ta, name_en, pooja_date FROM poojas
      WHERE is_active=1 ORDER BY pooja_date DESC LIMIT 50"
)->fetchAll();

adminHeader('💛 Sponsor Manager');
echo $msg;
?>

<div class="admin-two-col">

<div class="admin-form-box card">
  <h3><?= $editing ? 'Edit Sponsor' : 'Add Sponsor' ?></h3>
  <form method="POST" action="/admin/sponsors.php">
    <input type="hidden" name="action" value="save" />
    <?php if ($editing): ?><input type="hidden" name="id" value="<?= $editing['id'] ?>" /><?php endif; ?>

    <label>Sponsor Name *
      <input name="name" required
             value="<?= htmlspecialchars($editing['name'] ?? '') ?>"
             placeholder="Murugan Family / ஸ்ரீ மருகன் குடும்பம்" />
    </label>
    <label>Contact Number
      <input name="phone" maxlength="30"
             value="<?= htmlspecialchars($editing['phone'] ?? '') ?>"
             placeholder="+91 98765 43210" />
    </label>
    <label>Linked Pooja (optional)
      <select name="pooja_id">
        <option value="">— None —</option>
        <?php foreach ($poojas as $p): ?>
        <option value="<?= $p['id'] ?>"
                <?= ($editing['pooja_id'] ?? '') == $p['id'] ? 'selected' : '' ?>>
          <?= htmlspecialchars($p['name_ta'] . ' · ' . $p['pooja_date']) ?>
        </option>
        <?php endforeach; ?>
      </select>
    </label>
    <label>Note (message / special request)
      <textarea name="note" rows="3" placeholder="Sponsor note, dedication..."><?= htmlspecialchars($editing['note'] ?? '') ?></textarea>
    </label>
    <label class="checkbox-label">
      <input type="checkbox" name="is_active"
             <?= (!$editing || $editing['is_active']) ? 'checked' : '' ?> /> Active
    </label>
    <button type="submit" class="btn btn-primary">Save Sponsor</button>
    <?php if ($editing): ?>
      <a href="/admin/sponsors.php" class="btn btn-secondary">Cancel</a>
    <?php endif; ?>
  </form>
</div>

<div class="admin-list">
  <table class="admin-table">
    <thead>
      <tr>
        <th>Name</th><th>Phone</th><th>Linked Pooja</th><th>Active</th><th>Actions</th>
      </tr>
    </thead>
    <tbody>
      <?php foreach ($rows as $row): ?>
      <tr>
        <td><?= htmlspecialchars($row['name']) ?></td>
        <td><?= htmlspecialchars($row['phone'] ?: '—') ?></td>
        <td><?= htmlspecialchars($row['pooja_name'] ?: '—') ?></td>
        <td><?= $row['is_active'] ? '✅' : '❌' ?></td>
        <td>
          <a href="/admin/sponsors.php?edit=<?= $row['id'] ?>" class="btn btn-sm">Edit</a>
          <form method="POST" action="/admin/sponsors.php" style="display:inline">
            <input type="hidden" name="action" value="delete" />
            <input type="hidden" name="id" value="<?= $row['id'] ?>" />
            <button class="btn btn-sm btn-danger"
                    onclick="return confirm('Delete this sponsor?')">Del</button>
          </form>
        </td>
      </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
</div>

</div>
<?php adminFooter(); ?>
