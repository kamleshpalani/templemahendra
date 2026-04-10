<?php
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db  = getDB();
$msg = '';

// Handle create / update / delete
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? '';

    if ($action === 'save') {
        $title     = sanitizeText($_POST['title'] ?? '');
        $body      = sanitizeText($_POST['body'] ?? '', 2000);
        $is_active = isset($_POST['is_active']) ? 1 : 0;
        $id        = (int) ($_POST['id'] ?? 0);

        if ($title === '') {
            $msg = '<p class="alert alert--error">Title is required.</p>';
        } elseif ($id > 0) {
            $db->prepare('UPDATE announcements SET title=:t, body=:b, is_active=:a WHERE id=:id')
               ->execute([':t' => $title, ':b' => $body, ':a' => $is_active, ':id' => $id]);
            $msg = '<p class="alert alert--success">Updated.</p>';
        } else {
            $db->prepare('INSERT INTO announcements (title, body, is_active, created_at) VALUES (:t,:b,:a,NOW())')
               ->execute([':t' => $title, ':b' => $body, ':a' => $is_active]);
            $msg = '<p class="alert alert--success">Created.</p>';
        }
    } elseif ($action === 'delete') {
        $id = (int) ($_POST['id'] ?? 0);
        if ($id > 0) {
            $db->prepare('DELETE FROM announcements WHERE id=:id')->execute([':id' => $id]);
            $msg = '<p class="alert alert--success">Deleted.</p>';
        }
    }
}

$rows    = $db->query('SELECT * FROM announcements ORDER BY created_at DESC')->fetchAll();
$editing = null;
if (isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM announcements WHERE id=:id');
    $stmt->execute([':id' => (int) $_GET['edit']]);
    $editing = $stmt->fetch();
}

adminHeader('Announcements');
echo $msg;
?>

<div class="admin-two-col">

<div class="admin-form-box card">
  <h3><?= $editing ? 'Edit Announcement' : 'New Announcement' ?></h3>
  <form method="POST" action="/admin/announcements.php">
    <input type="hidden" name="action" value="save" />
    <?php if ($editing): ?><input type="hidden" name="id" value="<?= $editing['id'] ?>" /><?php endif; ?>
    <label>Title * <input name="title" required value="<?= htmlspecialchars($editing['title'] ?? '') ?>" /></label>
    <label>Body    <textarea name="body" rows="4"><?= htmlspecialchars($editing['body'] ?? '') ?></textarea></label>
    <label class="checkbox-label">
      <input type="checkbox" name="is_active" <?= (!$editing || $editing['is_active']) ? 'checked' : '' ?> /> Active
    </label>
    <button type="submit" class="btn btn-primary">Save</button>
    <?php if ($editing): ?><a href="/admin/announcements.php" class="btn btn-secondary">Cancel</a><?php endif; ?>
  </form>
</div>

<div class="admin-list">
  <table class="admin-table">
    <thead><tr><th>Title</th><th>Active</th><th>Date</th><th>Actions</th></tr></thead>
    <tbody>
      <?php foreach ($rows as $row): ?>
      <tr>
        <td><?= htmlspecialchars($row['title']) ?></td>
        <td><?= $row['is_active'] ? '✅' : '❌' ?></td>
        <td><?= htmlspecialchars($row['created_at']) ?></td>
        <td>
          <a href="/admin/announcements.php?edit=<?= $row['id'] ?>" class="btn btn-sm">Edit</a>
          <form method="POST" action="/admin/announcements.php" style="display:inline">
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
