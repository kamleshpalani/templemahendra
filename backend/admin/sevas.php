<?php
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
        $name_ta   = sanitizeText($_POST['name_ta'] ?? '');
        $name_en   = sanitizeText($_POST['name_en'] ?? '');
        $desc      = sanitizeText($_POST['description'] ?? '', 1000);
        $amount    = filter_var($_POST['amount'] ?? 0, FILTER_VALIDATE_FLOAT);
        $sort      = (int) ($_POST['sort_order'] ?? 0);
        $featured  = isset($_POST['is_featured']) ? 1 : 0;
        $active    = isset($_POST['is_active'])   ? 1 : 0;
        $id        = (int) ($_POST['id'] ?? 0);

        if ($name_ta === '' || $name_en === '' || $amount === false || $amount < 0) {
            $msg = '<p class="alert alert--error">Tamil name, English name, and a valid amount are required.</p>';
        } elseif ($id > 0) {
            $db->prepare('UPDATE sevas SET name_ta=:ta,name_en=:en,description=:d,amount=:a,sort_order=:s,is_featured=:f,is_active=:act WHERE id=:id')
               ->execute([':ta'=>$name_ta,':en'=>$name_en,':d'=>$desc,':a'=>$amount,':s'=>$sort,':f'=>$featured,':act'=>$active,':id'=>$id]);
            $msg = '<p class="alert alert--success">Updated.</p>';
        } else {
            $db->prepare('INSERT INTO sevas (name_ta,name_en,description,amount,sort_order,is_featured,is_active) VALUES (:ta,:en,:d,:a,:s,:f,:act)')
               ->execute([':ta'=>$name_ta,':en'=>$name_en,':d'=>$desc,':a'=>$amount,':s'=>$sort,':f'=>$featured,':act'=>$active]);
            $msg = '<p class="alert alert--success">Created.</p>';
        }
    } elseif ($action === 'delete') {
        $id = (int) ($_POST['id'] ?? 0);
        $db->prepare('DELETE FROM sevas WHERE id=:id')->execute([':id' => $id]);
        $msg = '<p class="alert alert--success">Deleted.</p>';
    }
}

$rows    = $db->query('SELECT * FROM sevas ORDER BY sort_order ASC')->fetchAll();
$editing = null;
if (isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM sevas WHERE id=:id');
    $stmt->execute([':id' => (int) $_GET['edit']]);
    $editing = $stmt->fetch();
}

adminHeader('Sevas');
echo $msg;
?>

<div class="admin-two-col">

<div class="admin-form-box card">
  <h3><?= $editing ? 'Edit Seva' : 'New Seva' ?></h3>
  <form method="POST" action="/admin/sevas.php">
    <input type="hidden" name="action" value="save" />
    <?php if ($editing): ?><input type="hidden" name="id" value="<?= $editing['id'] ?>" /><?php endif; ?>
    <label>Tamil Name * <input name="name_ta" required value="<?= htmlspecialchars($editing['name_ta'] ?? '') ?>" /></label>
    <label>English Name * <input name="name_en" required value="<?= htmlspecialchars($editing['name_en'] ?? '') ?>" /></label>
    <label>Description <textarea name="description" rows="3"><?= htmlspecialchars($editing['description'] ?? '') ?></textarea></label>
    <label>Amount (₹) * <input type="number" name="amount" required min="0" step="0.01" value="<?= htmlspecialchars($editing['amount'] ?? '') ?>" /></label>
    <label>Sort Order <input type="number" name="sort_order" value="<?= htmlspecialchars($editing['sort_order'] ?? '0') ?>" /></label>
    <label class="checkbox-label"><input type="checkbox" name="is_featured" <?= (!$editing || $editing['is_featured']) ? 'checked' : '' ?> /> Featured on Homepage</label>
    <label class="checkbox-label"><input type="checkbox" name="is_active"   <?= (!$editing || $editing['is_active'])   ? 'checked' : '' ?> /> Active</label>
    <button type="submit" class="btn btn-primary">Save</button>
    <?php if ($editing): ?><a href="/admin/sevas.php" class="btn btn-secondary">Cancel</a><?php endif; ?>
  </form>
</div>

<div class="admin-list">
  <table class="admin-table">
    <thead><tr><th>Tamil</th><th>English</th><th>Amount</th><th>Featured</th><th>Actions</th></tr></thead>
    <tbody>
      <?php foreach ($rows as $row): ?>
      <tr>
        <td><?= htmlspecialchars($row['name_ta']) ?></td>
        <td><?= htmlspecialchars($row['name_en']) ?></td>
        <td>₹<?= number_format($row['amount'], 2) ?></td>
        <td><?= $row['is_featured'] ? '⭐' : '' ?></td>
        <td>
          <a href="/admin/sevas.php?edit=<?= $row['id'] ?>" class="btn btn-sm">Edit</a>
          <form method="POST" style="display:inline">
            <input type="hidden" name="action" value="delete" />
            <input type="hidden" name="id" value="<?= $row['id'] ?>" />
            <button class="btn btn-sm btn-danger" onclick="return confirm('Delete?')">Del</button>
          </form>
        </td>
      </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
</div>

</div>

<?php adminFooter(); ?>
