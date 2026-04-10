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
        $title_ta   = sanitizeText($_POST['title_ta'] ?? '');
        $title_en   = sanitizeText($_POST['title_en'] ?? '');
        $desc       = sanitizeText($_POST['description'] ?? '', 2000);
        $event_date = $_POST['event_date'] ?? '';
        $active     = isset($_POST['is_active']) ? 1 : 0;
        $id         = (int) ($_POST['id'] ?? 0);

        if ($title_ta === '' || $title_en === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $event_date)) {
            $msg = '<p class="alert alert--error">All fields are required and date must be YYYY-MM-DD.</p>';
        } elseif ($id > 0) {
            $db->prepare('UPDATE events SET title_ta=:ta,title_en=:en,description=:d,event_date=:dt,is_active=:a WHERE id=:id')
               ->execute([':ta'=>$title_ta,':en'=>$title_en,':d'=>$desc,':dt'=>$event_date,':a'=>$active,':id'=>$id]);
            $msg = '<p class="alert alert--success">Updated.</p>';
        } else {
            $db->prepare('INSERT INTO events (title_ta,title_en,description,event_date,is_active) VALUES (:ta,:en,:d,:dt,:a)')
               ->execute([':ta'=>$title_ta,':en'=>$title_en,':d'=>$desc,':dt'=>$event_date,':a'=>$active]);
            $msg = '<p class="alert alert--success">Created.</p>';
        }
    } elseif ($action === 'delete') {
        $id = (int) ($_POST['id'] ?? 0);
        $db->prepare('DELETE FROM events WHERE id=:id')->execute([':id' => $id]);
        $msg = '<p class="alert alert--success">Deleted.</p>';
    }
}

$rows    = $db->query('SELECT * FROM events ORDER BY event_date ASC')->fetchAll();
$editing = null;
if (isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM events WHERE id=:id');
    $stmt->execute([':id' => (int) $_GET['edit']]);
    $editing = $stmt->fetch();
}

adminHeader('Events');
echo $msg;
?>

<div class="admin-two-col">

<div class="admin-form-box card">
  <h3><?= $editing ? 'Edit Event' : 'New Event' ?></h3>
  <form method="POST" action="/admin/events.php">
    <input type="hidden" name="action" value="save" />
    <?php if ($editing): ?><input type="hidden" name="id" value="<?= $editing['id'] ?>" /><?php endif; ?>
    <label>Tamil Title * <input name="title_ta" required value="<?= htmlspecialchars($editing['title_ta'] ?? '') ?>" /></label>
    <label>English Title * <input name="title_en" required value="<?= htmlspecialchars($editing['title_en'] ?? '') ?>" /></label>
    <label>Event Date * <input type="date" name="event_date" required value="<?= htmlspecialchars($editing['event_date'] ?? '') ?>" /></label>
    <label>Description <textarea name="description" rows="4"><?= htmlspecialchars($editing['description'] ?? '') ?></textarea></label>
    <label class="checkbox-label"><input type="checkbox" name="is_active" <?= (!$editing || $editing['is_active']) ? 'checked' : '' ?> /> Active</label>
    <button type="submit" class="btn btn-primary">Save</button>
    <?php if ($editing): ?><a href="/admin/events.php" class="btn btn-secondary">Cancel</a><?php endif; ?>
  </form>
</div>

<div class="admin-list">
  <table class="admin-table">
    <thead><tr><th>Tamil</th><th>English</th><th>Date</th><th>Actions</th></tr></thead>
    <tbody>
      <?php foreach ($rows as $row): ?>
      <tr>
        <td><?= htmlspecialchars($row['title_ta']) ?></td>
        <td><?= htmlspecialchars($row['title_en']) ?></td>
        <td><?= htmlspecialchars($row['event_date']) ?></td>
        <td>
          <a href="/admin/events.php?edit=<?= $row['id'] ?>" class="btn btn-sm">Edit</a>
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
