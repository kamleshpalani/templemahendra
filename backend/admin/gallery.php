<?php
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../config/config.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db  = getDB();
$msg = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? '';

    if ($action === 'upload') {
        $caption = sanitizeText($_POST['caption'] ?? '', 255);
        $file    = $_FILES['image'] ?? null;

        if (!$file || $file['error'] !== UPLOAD_ERR_OK) {
            $msg = '<p class="alert alert--error">No file uploaded or upload error.</p>';
        } elseif (!in_array($file['type'], ALLOWED_IMAGE_TYPES, true)) {
            $msg = '<p class="alert alert--error">Only JPEG, PNG and WebP images are allowed.</p>';
        } elseif ($file['size'] > UPLOAD_MAX_MB * 1024 * 1024) {
            $msg = '<p class="alert alert--error">File exceeds ' . UPLOAD_MAX_MB . ' MB limit.</p>';
        } else {
            $ext      = pathinfo($file['name'], PATHINFO_EXTENSION);
            $filename = bin2hex(random_bytes(12)) . '.' . strtolower($ext);
            $dest     = UPLOAD_DIR . $filename;

            if (move_uploaded_file($file['tmp_name'], $dest)) {
                $db->prepare('INSERT INTO gallery (filename, caption, is_active, created_at) VALUES (:f,:c,1,CURRENT_TIMESTAMP)')
                   ->execute([':f' => $filename, ':c' => $caption]);
                $msg = '<p class="alert alert--success">Image uploaded.</p>';
            } else {
                $msg = '<p class="alert alert--error">Failed to move uploaded file.</p>';
            }
        }
    } elseif ($action === 'delete') {
        $id   = (int) ($_POST['id'] ?? 0);
        $stmt = $db->prepare('SELECT filename FROM gallery WHERE id=:id');
        $stmt->execute([':id' => $id]);
        $row  = $stmt->fetch();
        if ($row) {
            @unlink(UPLOAD_DIR . $row['filename']);
            $db->prepare('DELETE FROM gallery WHERE id=:id')->execute([':id' => $id]);
        }
        $msg = '<p class="alert alert--success">Deleted.</p>';
    }
}

$images = $db->query('SELECT * FROM gallery ORDER BY created_at DESC')->fetchAll();

adminHeader('Gallery');
echo $msg;
?>

<div class="admin-form-box card" style="max-width:480px">
  <h3>Upload Image</h3>
  <form method="POST" action="/admin/gallery.php" enctype="multipart/form-data">
    <input type="hidden" name="action" value="upload" />
    <label>Image (JPEG/PNG/WebP, max <?= UPLOAD_MAX_MB ?>MB) *
      <input type="file" name="image" accept="image/jpeg,image/png,image/webp" required />
    </label>
    <label>Caption <input name="caption" /></label>
    <button type="submit" class="btn btn-primary">Upload</button>
  </form>
</div>

<div class="gallery-admin-grid" style="margin-top:2rem">
  <?php foreach ($images as $img): ?>
  <div class="gallery-admin-item card">
    <img src="/uploads/<?= htmlspecialchars($img['filename']) ?>" alt="<?= htmlspecialchars($img['caption']) ?>" loading="lazy" />
    <div class="gallery-admin-item__info">
      <p><?= htmlspecialchars($img['caption'] ?: '(no caption)') ?></p>
      <form method="POST" action="/admin/gallery.php">
        <input type="hidden" name="action" value="delete" />
        <input type="hidden" name="id" value="<?= $img['id'] ?>" />
        <button class="btn btn-sm btn-danger" onclick="return confirm('Delete image?')">Delete</button>
      </form>
    </div>
  </div>
  <?php endforeach; ?>
</div>

<?php adminFooter(); ?>
