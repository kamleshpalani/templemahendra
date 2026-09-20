<?php
// backend/admin/deities.php — Deities: the temple's deities as shown on the
// About page (brief §6 "Deities"). Rows live in `deities` (migration 011), the
// same table the live-stream forms pick a deity from, so a name changed here
// is the name a broadcast is dedicated to.
//
// Deities are hidden rather than deleted while a stream refers to them; a
// delete is offered only for a row nothing points at.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/live/config.php';
require_once __DIR__ . '/../includes/live/validate.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

/** String value from a request array ('' when missing or not scalar). */
$str = static fn(array $src, string $key): string => is_scalar($src[$key] ?? null) ? (string) $src[$key] : '';

if (!liveTablesExist()) {
    adminHeader('Deities', 'Worship');
    echo '<p class="alert alert--warning" role="alert">Deities are not installed on this site yet: apply database migration <code>011_live_streams.sql</code> and reload.</p>';
    adminFooter();
    exit;
}

/** The temple deities belong to: the first active temple (single-temple site). */
$templeId = (int) ($db->query('SELECT id FROM temples WHERE is_active = 1 ORDER BY sort_order ASC, id ASC LIMIT 1')->fetchColumn() ?: 0);

/** A slug free for this temple, from the English name; "-2", "-3"… on a clash. */
function deitySlugFree(PDO $db, int $templeId, string $nameEn, ?int $exceptId): string
{
    $base = liveSlugify($nameEn);
    if ($base === 'stream') $base = 'deity';
    $base = substr($base, 0, 34);
    $stmt = $db->prepare('SELECT id FROM deities WHERE temple_id = :t AND slug = :s' . ($exceptId ? ' AND id <> :e' : ''));
    for ($n = 1; $n < 100; $n++) {
        $slug   = $n === 1 ? $base : $base . '-' . $n;
        $params = [':t' => $templeId, ':s' => $slug];
        if ($exceptId) $params[':e'] = $exceptId;
        $stmt->execute($params);
        if (!$stmt->fetch()) return $slug;
    }
    return $base . '-' . bin2hex(random_bytes(2));
}

/** Store an uploaded deity image under a random name; ['url' => …] or ['error' => …] or [] when none was sent. */
function deityImageUpload(?array $file): array
{
    $err = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);
    if (!$file || $err === UPLOAD_ERR_NO_FILE) return [];
    if ($err !== UPLOAD_ERR_OK) {
        return ['error' => match ($err) {
            UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => 'That image is larger than the server upload limit (' . (string) ini_get('upload_max_filesize') . ').',
            UPLOAD_ERR_PARTIAL => 'The upload was interrupted — try again.',
            default            => 'The image could not be uploaded.',
        }];
    }
    if ($file['size'] > UPLOAD_MAX_MB * 1024 * 1024) return ['error' => 'Image exceeds ' . UPLOAD_MAX_MB . ' MB limit.'];
    // Type and stored extension come from the decoded image, never from the client's name or MIME.
    $info = @getimagesize($file['tmp_name']);
    $kind = [IMAGETYPE_JPEG => 'jpg', IMAGETYPE_PNG => 'png', IMAGETYPE_WEBP => 'webp'][$info[2] ?? 0] ?? null;
    if (!$info || $kind === null) return ['error' => 'Only JPEG, PNG and WebP images are allowed.'];
    $filename = bin2hex(random_bytes(12)) . '.' . $kind;
    if (!move_uploaded_file($file['tmp_name'], UPLOAD_DIR . $filename)) return ['error' => 'Failed to store the uploaded image.'];
    return ['url' => '/uploads/' . $filename];
}

/** Remove a stored image if it is one of ours (under /uploads) — never a remote URL. */
function deityImageUnlink(?string $url): void
{
    if ($url && preg_match('#^/uploads/([a-f0-9]{24}\.(?:jpg|png|webp))$#', $url, $m)) {
        @unlink(UPLOAD_DIR . $m[1]);
    }
}

// ── Flash left by the previous request (POST → 303 → GET) ────────────────────
$msg = '';
if (!empty($_SESSION['flash'])) {
    $msg = (string) $_SESSION['flash'];
    unset($_SESSION['flash']);
}

$filters       = ['active' => 'Shown', 'hidden' => 'Hidden', 'all' => 'All'];
$defaultFilter = 'all';
$src           = $_SERVER['REQUEST_METHOD'] === 'POST' ? $_POST : $_GET;
$filter        = isset($filters[$str($src, 'f')]) ? $str($src, 'f') : $defaultFilter;
$query         = ['f' => $filter === $defaultFilter ? '' : $filter];
$listUrl       = static fn(array $override = []): string => '/admin/deities.php' . rtrim(adminQuery($query, $override), '?');

$editing = null;
$errors  = [];

$fromPost = static fn(): array => [
    'id'             => (int) $str($_POST, 'id'),
    'name_en'        => $str($_POST, 'name_en'),
    'name_ta'        => $str($_POST, 'name_ta'),
    'description_en' => $str($_POST, 'description_en'),
    'description_ta' => $str($_POST, 'description_ta'),
    'image_url'      => $str($_POST, 'image_url'),
    'sort_order'     => $str($_POST, 'sort_order'),
    'is_active'      => isset($_POST['is_active']) ? 1 : 0,
];

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $msg    = adminCsrfGuard();
    $action = $str($_POST, 'action');
    $back   = $listUrl();

    if ($msg !== '' && $action === 'save') $editing = $fromPost();

    if ($msg === '' && $templeId === 0) {
        $msg = '<p class="alert alert--error" role="alert">No active temple is configured, so a deity cannot be saved.</p>';
    } elseif ($msg === '' && $action === 'save') {
        $id     = (int) $str($_POST, 'id');
        $nameEn = sanitizeText($str($_POST, 'name_en'), 200);
        $nameTa = sanitizeText($str($_POST, 'name_ta'), 200);
        $descEn = sanitizeText($str($_POST, 'description_en'), 5000);
        $descTa = sanitizeText($str($_POST, 'description_ta'), 5000);
        $order  = $str($_POST, 'sort_order');
        $active = isset($_POST['is_active']) ? 1 : 0;
        $imageUrl = sanitizeText($str($_POST, 'image_url'), 500);

        if ($nameEn === '') $errors['name_en'] = true;
        if ($nameTa === '') $errors['name_ta'] = true;
        if ($order !== '' && !preg_match('/^-?[0-9]{1,6}$/', $order)) $errors['sort_order'] = true;
        if ($imageUrl !== '' && !preg_match('#^(https://[^\s"<>]{1,480}|/uploads/[a-f0-9]{24}\.(?:jpg|png|webp))$#', $imageUrl)) $errors['image_url'] = true;

        $current = null;
        if ($id > 0 && !$errors) {
            $stmt = $db->prepare('SELECT * FROM deities WHERE id = :id AND temple_id = :t');
            $stmt->execute([':id' => $id, ':t' => $templeId]);
            $current = $stmt->fetch() ?: null;
            if ($current === null) $errors['id'] = true;
        }

        $upload = [];
        if (!$errors) {
            $upload = deityImageUpload($_FILES['image'] ?? null);
            if (isset($upload['error'])) $errors['image'] = $upload['error'];
        }

        if ($errors) {
            $msg = '<p class="alert alert--error" role="alert">' . h(isset($errors['id']) ? 'That deity no longer exists.'
                : ($errors['image'] ?? 'Please fix the highlighted fields.')) . '</p>';
            $editing = $fromPost();
        } else {
            $newImage = $upload['url'] ?? ($imageUrl !== '' ? $imageUrl : null);
            $orderInt = $order === '' ? 0 : (int) $order;
            if ($current) {
                $db->prepare('UPDATE deities SET name_en=:en, name_ta=:ta, description_en=:den, description_ta=:dta, image_url=:img, sort_order=:o, is_active=:a, updated_at=UTC_TIMESTAMP() WHERE id=:id')
                   ->execute([':en' => $nameEn, ':ta' => $nameTa, ':den' => $descEn !== '' ? $descEn : null, ':dta' => $descTa !== '' ? $descTa : null,
                              ':img' => $newImage, ':o' => $orderInt, ':a' => $active, ':id' => $id]);
                if (($current['image_url'] ?? null) !== $newImage) deityImageUnlink($current['image_url'] ?? null);
                adminAudit('deity_updated', 'deity:' . $id, $nameEn);
                $_SESSION['flash'] = '<p class="alert alert--success" role="status">Updated.</p>';
            } else {
                $db->prepare('INSERT INTO deities (temple_id, slug, name_ta, name_en, description_ta, description_en, image_url, sort_order, is_active, created_at, updated_at)
                              VALUES (:t, :s, :ta, :en, :dta, :den, :img, :o, :a, UTC_TIMESTAMP(), UTC_TIMESTAMP())')
                   ->execute([':t' => $templeId, ':s' => deitySlugFree($db, $templeId, $nameEn, null), ':ta' => $nameTa, ':en' => $nameEn,
                              ':dta' => $descTa !== '' ? $descTa : null, ':den' => $descEn !== '' ? $descEn : null,
                              ':img' => $newImage, ':o' => $orderInt, ':a' => $active]);
                adminAudit('deity_created', 'deity:' . (int) $db->lastInsertId(), $nameEn);
                $_SESSION['flash'] = '<p class="alert alert--success" role="status">Created.</p>';
            }
            header('Location: ' . $back, true, 303);
            exit;
        }
    } elseif ($msg === '' && $action === 'toggle') {
        $id   = (int) $str($_POST, 'id');
        $stmt = $db->prepare('UPDATE deities SET is_active = 1 - is_active, updated_at = UTC_TIMESTAMP() WHERE id = :id AND temple_id = :t');
        $stmt->execute([':id' => $id, ':t' => $templeId]);
        if ($stmt->rowCount()) {
            adminAudit('deity_toggled', 'deity:' . $id);
            $_SESSION['flash'] = '<p class="alert alert--success" role="status">Visibility changed.</p>';
        }
        header('Location: ' . $back, true, 303);
        exit;
    } elseif ($msg === '' && $action === 'delete') {
        $id   = (int) $str($_POST, 'id');
        $stmt = $db->prepare('SELECT d.*, (SELECT COUNT(*) FROM live_streams s WHERE s.deity_id = d.id) AS streams FROM deities d WHERE d.id = :id AND d.temple_id = :t');
        $stmt->execute([':id' => $id, ':t' => $templeId]);
        $row = $stmt->fetch();
        if ($row && (int) $row['streams'] > 0) {
            $_SESSION['flash'] = '<p class="alert alert--warning" role="alert">' . h($row['name_en']) . ' is linked to ' . (int) $row['streams']
                . ' live stream' . ((int) $row['streams'] === 1 ? '' : 's') . ' and cannot be deleted. Hide it instead.</p>';
        } elseif ($row) {
            $db->prepare('DELETE FROM deities WHERE id = :id')->execute([':id' => $id]);
            deityImageUnlink($row['image_url'] ?? null);
            adminAudit('deity_deleted', 'deity:' . $id, (string) $row['name_en']);
            $_SESSION['flash'] = '<p class="alert alert--success" role="status">Deleted.</p>';
        }
        header('Location: ' . $back, true, 303);
        exit;
    }
}

if ($editing === null && isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM deities WHERE id = :id AND temple_id = :t');
    $stmt->execute([':id' => (int) $str($_GET, 'edit'), ':t' => $templeId]);
    $editing = $stmt->fetch() ?: null;
    if ($editing === null && $msg === '') $msg = '<p class="alert alert--warning" role="alert">That deity no longer exists.</p>';
}
$isEdit   = !empty($editing['id']);
$formOpen = $editing !== null;

// ── List ─────────────────────────────────────────────────────────────────────
$where = ['d.temple_id = :t'];
switch ($filter) {
    case 'active': $where[] = 'd.is_active = 1'; break;
    case 'hidden': $where[] = 'd.is_active = 0'; break;
}
$stmt = $db->prepare('SELECT d.*, (SELECT COUNT(*) FROM live_streams s WHERE s.deity_id = d.id) AS streams
                        FROM deities d WHERE ' . implode(' AND ', $where) . ' ORDER BY d.sort_order ASC, d.id ASC LIMIT 200');
$stmt->execute([':t' => $templeId]);
$rows = $stmt->fetchAll();

$c = $db->prepare('SELECT COUNT(*) AS total, COALESCE(SUM(is_active = 1), 0) AS active, COALESCE(SUM(is_active = 0), 0) AS hidden FROM deities WHERE temple_id = :t');
$c->execute([':t' => $templeId]);
$c = $c->fetch();
$chipCounts = ['active' => (int) $c['active'], 'hidden' => (int) $c['hidden'], 'all' => (int) $c['total']];
$shown      = count($rows);
$countLabel = $filter !== $defaultFilter ? "$shown of {$chipCounts['all']} deities" : "$shown deit" . ($shown === 1 ? 'y' : 'ies');

$invalid    = static fn(string $f): string => isset($errors[$f]) ? ' aria-invalid="true" aria-describedby="err-' . $f . '"' : '';
$fieldError = static fn(string $f, string $text): string => isset($errors[$f]) ? '<span class="field__error" id="err-' . $f . '">' . adminIcon('alert-circle') . h($text) . '</span>' : '';

adminHeader('Deities', 'Worship', [
    'actions' => '<a href="/about#deities" target="_blank" rel="noopener" class="btn btn-ghost btn--sm">' . adminIcon('external') . 'View on site</a>',
]);
echo $msg;
echo adminPageIntro(
    'The deities shown on the About page, in display order, with a Tamil and an English name and description. Hidden deities stay saved and keep their live-stream links but are not shown to visitors.',
    '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="crud" aria-expanded="false">' . adminIcon('plus') . ' New deity</button>'
);
?>

<div class="admin-two-col admin-two-col--collapsible" id="crud" data-editing="<?= $formOpen ? '1' : '0' ?>">

  <section class="card card--solid card--static admin-form-box" id="new" aria-labelledby="form-title">
    <h2 id="form-title"><?= adminIcon($isEdit ? 'pencil' : 'sparkles') ?> <?= $isEdit ? 'Edit deity' : 'New deity' ?></h2>
    <form method="POST" action="/admin/deities.php" enctype="multipart/form-data">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save" />
      <input type="hidden" name="f" value="<?= h($filter) ?>" />
      <?php if ($isEdit): ?><input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" /><?php endif; ?>

      <label for="name_ta">
        <span class="field__label">Name (Tamil) <span class="field__required" aria-hidden="true">*</span></span>
        <input id="name_ta" name="name_ta" type="text" required aria-required="true" maxlength="200" lang="ta" autocomplete="off"
               placeholder="ஸ்ரீ ரேணுகாதேவி" value="<?= h($editing['name_ta'] ?? '') ?>"<?= $invalid('name_ta') ?> />
        <?= $fieldError('name_ta', 'The Tamil name is required.') ?>
      </label>

      <label for="name_en">
        <span class="field__label">Name (English) <span class="field__required" aria-hidden="true">*</span></span>
        <input id="name_en" name="name_en" type="text" required aria-required="true" maxlength="200" autocomplete="off"
               placeholder="Sri Renukadevi" value="<?= h($editing['name_en'] ?? '') ?>"<?= $invalid('name_en') ?> />
        <?= $fieldError('name_en', 'The English name is required.') ?>
      </label>

      <label for="description_ta">
        <span class="field__label">Description (Tamil) <span class="field__optional">optional</span></span>
        <textarea id="description_ta" name="description_ta" rows="4" maxlength="5000" lang="ta" data-counter><?= h($editing['description_ta'] ?? '') ?></textarea>
      </label>

      <label for="description_en">
        <span class="field__label">Description (English) <span class="field__optional">optional</span></span>
        <textarea id="description_en" name="description_en" rows="4" maxlength="5000" data-counter><?= h($editing['description_en'] ?? '') ?></textarea>
      </label>

      <label for="image">
        <span class="field__label">Image <span class="field__optional">optional</span></span>
        <input type="file" id="image" name="image" accept="image/jpeg,image/png,image/webp" aria-describedby="image-hint"<?= isset($errors['image']) ? ' aria-invalid="true"' : '' ?> />
        <span class="field__hint" id="image-hint">JPEG, PNG or WebP · max <?= (int) UPLOAD_MAX_MB ?> MB. Replaces the current image.</span>
      </label>
      <?php if (!empty($editing['image_url'])): ?>
        <p class="field__hint">Current image: <a href="<?= h($editing['image_url']) ?>" target="_blank" rel="noopener"><?= h($editing['image_url']) ?></a></p>
      <?php endif; ?>
      <input type="hidden" name="image_url" value="<?= h($editing['image_url'] ?? '') ?>" />
      <?= $fieldError('image_url', 'The stored image address is not valid.') ?>

      <label for="sort_order">
        <span class="field__label">Display order</span>
        <input id="sort_order" name="sort_order" type="number" inputmode="numeric" min="-999999" max="999999" step="1"
               value="<?= h((string) ($editing['sort_order'] ?? '0')) ?>"<?= $invalid('sort_order') ?> />
        <?= $fieldError('sort_order', 'Display order must be a whole number.') ?>
        <span class="field__hint">Smaller numbers come first.</span>
      </label>

      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= (!$editing || !empty($editing['is_active'])) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Shown</strong><span class="switch__desc">Listed on the About page and offered when a live stream is dedicated to a deity.</span></span>
      </label>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> <?= $isEdit ? 'Save changes' : 'Add deity' ?></button>
        <?php if ($formOpen): ?><a href="<?= h($listUrl()) ?>" class="btn btn-ghost">Cancel</a><?php endif; ?>
      </div>
    </form>
  </section>

  <div class="admin-list">
    <div class="toolbar">
      <nav class="filter-chips" aria-label="Filter deities">
        <?php foreach ($filters as $key => $label): ?>
          <a class="chip" href="<?= h($listUrl(['f' => $key === $defaultFilter ? '' : $key])) ?>"<?= $key === $filter ? ' aria-current="page"' : '' ?>>
            <?= h($label) ?> <span class="chip__count"><?= $chipCounts[$key] ?></span>
          </a>
        <?php endforeach; ?>
      </nav>
      <span class="toolbar__count" aria-live="polite"><?= h($countLabel) ?></span>
    </div>

    <?php if ($rows): ?>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Deity</th>
            <th scope="col">Description</th>
            <th scope="col">Streams</th>
            <th scope="col">Status</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($rows as $row): $rid = (int) $row['id']; $streams = (int) $row['streams']; ?>
          <tr>
            <td class="cell-num"><?= (int) $row['sort_order'] ?></td>
            <td>
              <span class="cell-title" lang="ta"><?= h($row['name_ta']) ?></span>
              <span class="cell-muted"><?= h($row['name_en']) ?></span>
              <?php if (!empty($row['image_url'])): ?><span class="cell-muted"><?= adminIcon('image') ?> image</span><?php endif; ?>
            </td>
            <td><?= ($row['description_en'] ?? '') !== '' ? '<span class="cell-clip">' . h($row['description_en']) . '</span>' : '<span class="cell-muted">—</span>' ?></td>
            <td class="cell-num"><?= $streams ?></td>
            <td><?= $row['is_active'] ? adminBadge('Shown', 'success') : adminBadge('Hidden', 'muted') ?></td>
            <td class="cell-actions">
              <?= adminMenu(array_values(array_filter([
                  ['label' => 'Edit', 'icon' => 'pencil', 'href' => $listUrl(['edit' => $rid])],
                  ['label' => $row['is_active'] ? 'Hide' : 'Show', 'icon' => $row['is_active'] ? 'eye-off' : 'eye',
                   'form' => ['action' => 'toggle', 'id' => $rid, 'f' => $filter]],
                  $streams === 0 ? 'divider' : null,
                  $streams === 0 ? ['label' => 'Delete', 'icon' => 'trash', 'danger' => true,
                   'form' => ['action' => 'delete', 'id' => $rid, 'f' => $filter],
                   'confirm' => 'Delete “' . $row['name_en'] . '”? This cannot be undone.'] : null,
              ])), 'Actions for ' . $row['name_en']) ?>
            </td>
          </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>
    <?php elseif ($filter !== $defaultFilter): ?>
      <?= adminEmpty('search', 'No deities match', 'Try another filter.',
          '<a href="/admin/deities.php" class="btn btn--sm">' . adminIcon('x') . ' Clear filters</a>') ?>
    <?php else: ?>
      <?= adminEmpty('sparkles', 'No deities yet', 'Add the temple’s deities and they appear on the About page in display order.',
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' New deity</a>') ?>
    <?php endif; ?>
  </div>

</div>

<?php adminFooter(); ?>
