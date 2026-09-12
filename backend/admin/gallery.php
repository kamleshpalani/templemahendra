<?php
// backend/admin/gallery.php — Photo gallery: upload photos and manage what the public gallery shows
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../config/config.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db           = getDB();
$msg          = '';
$fieldError   = '';    // plain-text validation error shown under the dropzone
$captionVal   = '';    // re-filled when an upload fails validation
$uploadFailed = false; // keeps the form drawer open on small screens after a failed upload

// Flash message left by a successful POST before its redirect
if (isset($_SESSION['admin_flash'])) {
    $flash = $_SESSION['admin_flash'];
    unset($_SESSION['admin_flash']);
    if (is_array($flash) && !empty($flash['text'])) {
        $tone = in_array($flash['type'] ?? '', ['success', 'error', 'warning', 'info'], true) ? $flash['type'] : 'info';
        $msg  = '<p class="alert alert--' . $tone . '" role="status">' . h((string) $flash['text']) . '</p>';
    }
}

// ── Handle POST ──────────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // A multipart body larger than post_max_size reaches PHP with $_POST and
    // $_FILES emptied, which would otherwise trip the CSRF guard and wrongly
    // blame the admin's session. Detect it before the guard runs.
    if (!$_POST && !$_FILES && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
        $uploadFailed = true;
        $msg = '<p class="alert alert--error" role="alert">That photo was too large for the server (limit '
             . h((string) ini_get('post_max_size')) . '). Resize it and try again.</p>';
    } else {
        $msg = adminCsrfGuard();
    }
    if ($msg === '') {
        $action = $_POST['action'] ?? '';

        if ($action === 'upload') {
            $caption    = sanitizeText($_POST['caption'] ?? '', 255);
            $captionVal = $caption;
            $file       = $_FILES['image'] ?? null;
            $err        = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);

            if (!$file || $err !== UPLOAD_ERR_OK) {
                $fieldError = match ($err) {
                    UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE =>
                        'That photo is larger than the server upload limit (' . (string) ini_get('upload_max_filesize') . ').',
                    UPLOAD_ERR_NO_FILE  => 'Choose a photo to upload.',
                    UPLOAD_ERR_PARTIAL  => 'The upload was interrupted — try again.',
                    default             => 'No file uploaded or upload error.',
                };
            } elseif ($file['size'] > UPLOAD_MAX_MB * 1024 * 1024) {
                $fieldError = 'File exceeds ' . UPLOAD_MAX_MB . ' MB limit.';
            } else {
                // Type and stored extension come from the decoded image itself —
                // never from $file['type'] or the attacker-supplied filename.
                $info = @getimagesize($file['tmp_name']);
                $kind = [IMAGETYPE_JPEG => 'jpg', IMAGETYPE_PNG => 'png', IMAGETYPE_WEBP => 'webp'][$info[2] ?? 0] ?? null;

                if (!$info || $kind === null) {
                    $fieldError = 'Only JPEG, PNG and WebP images are allowed.';
                } else {
                    $filename = bin2hex(random_bytes(12)) . '.' . $kind;
                    $dest     = UPLOAD_DIR . $filename;

                    if (move_uploaded_file($file['tmp_name'], $dest)) {
                        $db->prepare('INSERT INTO gallery (filename, caption, is_active, created_at) VALUES (:f,:c,1,CURRENT_TIMESTAMP)')
                           ->execute([':f' => $filename, ':c' => $caption]);
                        $_SESSION['admin_flash'] = ['type' => 'success', 'text' => 'Image uploaded.'];
                        header('Location: /admin/gallery.php', true, 303);
                        exit;
                    }
                    $uploadFailed = true;
                    $msg = '<p class="alert alert--error" role="alert">Failed to move uploaded file.</p>';
                }
            }
            if ($fieldError !== '') {
                $uploadFailed = true;
                $msg = '<p class="alert alert--error" role="alert">' . h($fieldError) . '</p>';
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
            $_SESSION['admin_flash'] = ['type' => 'success', 'text' => 'Deleted.'];
            header('Location: /admin/gallery.php', true, 303);
            exit;
        }
    }
}

$images = $db->query('SELECT * FROM gallery ORDER BY created_at DESC')->fetchAll();
$total  = count($images);

$headerActions = '<a href="/" target="_blank" rel="noopener" class="btn btn-ghost btn--sm">' . adminIcon('external') . 'View site</a>';
adminHeader('Gallery', 'Content', ['actions' => $headerActions]);
echo $msg;
echo adminPageIntro(
    'Upload photos of festivals, poojas and the temple for the public gallery page; deleting a photo removes it from the site and the server immediately.',
    '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="gallery-cols" aria-expanded="false">' . adminIcon('plus') . ' New photo</button>'
);
?>

<div class="admin-two-col admin-two-col--collapsible" id="gallery-cols"<?= $uploadFailed ? ' data-editing="1"' : '' ?>>
  <section class="card card--static admin-form-box" id="new" aria-labelledby="upload-title">
    <h2 id="upload-title"><?= adminIcon('upload') ?> Upload photo</h2>
    <form method="POST" action="/admin/gallery.php" enctype="multipart/form-data">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="upload" />

      <div class="field<?= $fieldError !== '' ? ' field--error' : '' ?>">
        <span class="field__label" id="image-label">Photo <span class="field__required" aria-hidden="true">*</span></span>
        <div class="dropzone" role="group" aria-labelledby="image-label dropzone-title" aria-describedby="dropzone-hint">
          <span class="dropzone__icon" aria-hidden="true"><?= adminIcon('image') ?></span>
          <span class="dropzone__title" id="dropzone-title">Drag &amp; drop a photo, or click to browse</span>
          <span class="field__hint" id="dropzone-hint">JPEG, PNG or WebP · max <?= (int) UPLOAD_MAX_MB ?> MB</span>
          <span class="dropzone__file" aria-live="polite"></span>
          <input type="file" id="image" name="image" accept="image/jpeg,image/png,image/webp" required aria-required="true"
                 aria-labelledby="image-label"
                 aria-describedby="dropzone-hint<?= $fieldError !== '' ? ' image-error' : '' ?>"<?= $fieldError !== '' ? ' aria-invalid="true"' : '' ?> />
        </div>
        <?php if ($fieldError !== ''): ?>
          <span class="field__error" id="image-error" role="alert"><?= adminIcon('alert-circle') ?> <?= h($fieldError) ?></span>
        <?php endif; ?>
      </div>

      <label for="caption">
        <span class="field__label">Caption <span class="field__optional">optional</span></span>
        <input type="text" id="caption" name="caption" maxlength="255" value="<?= h($captionVal) ?>"
               placeholder="e.g. Pournami Abhishekam, March 2026" autocomplete="off" aria-describedby="caption-hint" />
        <span class="field__hint" id="caption-hint">Shown under the photo on the public site. Up to 255 characters.</span>
      </label>

      <button type="submit" class="btn btn-primary"><?= adminIcon('upload') ?> Upload</button>
    </form>
  </section>

  <div class="admin-list">
    <div class="callout mb-4">
      <?= adminIcon('info') ?>
      <p>Photos appear on the public gallery page in upload order, newest first. Deleting a photo also removes the original file from the server.</p>
    </div>

    <div class="toolbar">
      <span class="toolbar__count" role="status"><?= $total ?> photo<?= $total === 1 ? '' : 's' ?></span>
    </div>

    <?php if (!$images): ?>
      <?= adminEmpty(
          'image',
          'No photos yet',
          'Upload the first photo of a festival, pooja or the temple to start the public gallery.',
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('upload') . ' Upload a photo</a>'
      ) ?>
    <?php else: ?>
      <div class="gallery-admin-grid">
        <?php foreach ($images as $img): $cap = trim((string) ($img['caption'] ?? '')); $id = (int) $img['id']; ?>
          <figure class="gallery-admin-item">
            <?php // the card wraps the photo only: .card sets overflow:hidden, which would clip the row menu popover ?>
            <div class="card card--static">
              <img src="/uploads/<?= h($img['filename']) ?>" alt="<?= h($cap !== '' ? $cap : 'Gallery photo ' . $id) ?>" loading="lazy" width="400" height="400" />
            </div>
            <figcaption class="gallery-admin-item__info">
              <div class="grow">
                <?php if ($cap !== ''): ?>
                  <p title="<?= h($cap) ?>"><?= h($cap) ?></p>
                <?php else: ?>
                  <p class="text-muted">No caption</p>
                <?php endif; ?>
                <time class="text-xs" datetime="<?= h($img['created_at']) ?>"><?= h(adminFmtDate($img['created_at'])) ?></time>
              </div>
              <?= adminMenu([
                  ['label' => 'View original', 'href' => '/uploads/' . $img['filename'], 'icon' => 'external'],
                  'divider',
                  [
                      'label'        => 'Delete',
                      'icon'         => 'trash',
                      'danger'       => true,
                      'form'         => ['action' => 'delete', 'id' => $id],
                      'confirm'      => 'Delete this photo? It is removed from the public gallery and the file is deleted from the server.',
                      'confirmLabel' => 'Delete photo',
                  ],
              ], 'Photo actions') ?>
            </figcaption>
          </figure>
        <?php endforeach; ?>
      </div>
    <?php endif; ?>
  </div>
</div>

<?php adminFooter(); ?>
