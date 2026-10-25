<?php
// backend/admin/gallery.php — Content → Gallery (brief §6 Gallery, §19, §22, §34).
//
// Upload photographs into albums, give each one alternative text in Tamil and
// English, and manage the albums themselves on the same page. Every upload is
// decoded before it is trusted (type and stored name come from the bytes,
// never from the client), and GD writes a ~480 px `thumb` for the grid and a
// ~1280 px `medium` for the lightbox (backend/includes/gallery_images.php).
// Deleting a photo removes all three files. Hidden photos and hidden albums
// stay saved but leave the public site; an album with photos cannot be
// deleted, only hidden. Before migration 021 the page still uploads and
// deletes, without albums or alt text.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../config/config.php';
require_once __DIR__ . '/../includes/gallery_images.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

/** String value from a request array ('' when missing or not scalar). */
$str = static fn(array $src, string $key): string => is_scalar($src[$key] ?? null) ? (string) $src[$key] : '';

$alert = static fn(string $tone, string $text): string => '<p class="alert alert--' . $tone . '" role="' . ($tone === 'success' ? 'status' : 'alert') . '">' . h($text) . '</p>';

$hasAlbums    = galleryAlbumsReady();
$msg          = '';
$fieldError   = '';    // plain-text validation error shown under the dropzone
$uploadFailed = false; // keeps the form drawer open on small screens after a failed upload
$errors       = [];
$editing      = null;  // the photo being edited (row or re-filled POST), else the upload form shows
$formVals     = ['caption' => '', 'alt_ta' => '', 'alt_en' => '', 'album_id' => 0]; // re-filled when an upload fails

// Flash message left by a successful POST before its redirect
if (isset($_SESSION['admin_flash'])) {
    $flash = $_SESSION['admin_flash'];
    unset($_SESSION['admin_flash']);
    if (is_array($flash) && !empty($flash['text'])) {
        $tone = in_array($flash['type'] ?? '', ['success', 'error', 'warning', 'info'], true) ? $flash['type'] : 'info';
        $msg  = $alert($tone, (string) $flash['text']);
    }
}
$flashTo = static function (string $type, string $text): void {
    $_SESSION['admin_flash'] = ['type' => $type, 'text' => $text];
};

// ── Albums, events and the filters (needed by POST validation and the page) ──
$albums = $hasAlbums
    ? $db->query('SELECT a.*,
                         (SELECT COUNT(*) FROM gallery g WHERE g.album_id = a.id) AS n,
                         (SELECT COUNT(*) FROM gallery g WHERE g.album_id = a.id AND g.is_active = 1) AS n_active
                    FROM gallery_albums a ORDER BY a.sort_order ASC, a.id ASC LIMIT 200')->fetchAll()
    : [];
$albumById = array_column($albums, null, 'id');

$events = [];
if ($hasAlbums) {
    try {
        $events = $db->query('SELECT id, title_ta, title_en, event_date FROM events ORDER BY event_date DESC, id DESC LIMIT 150')->fetchAll();
    } catch (Throwable $e) {
        $events = [];
    }
}
$eventById = array_column($events, null, 'id');

$filters       = ['all' => 'All', 'active' => 'Shown', 'hidden' => 'Hidden'];
$defaultFilter = 'all';
$src           = $_SERVER['REQUEST_METHOD'] === 'POST' ? $_POST : $_GET;
$filter        = isset($filters[$str($src, 'f')]) ? $str($src, 'f') : $defaultFilter;
$albumFilter   = $hasAlbums ? $str($src, 'a') : ''; // '' all · 'none' unfiled · '<id>'
if ($albumFilter !== '' && $albumFilter !== 'none' && (!preg_match('/^[0-9]{1,10}$/D', $albumFilter) || !isset($albumById[(int) $albumFilter]))) $albumFilter = '';
$q             = mb_substr(trim($str($src, 'q')), 0, 100);
$query         = ['f' => $filter === $defaultFilter ? '' : $filter, 'a' => $albumFilter, 'q' => $q];
$listUrl       = static fn(array $override = []): string => '/admin/gallery.php' . rtrim(adminQuery($query, $override), '?');

/** Album id from a form value: 0 for none, or a listed album; null when unknown. */
$albumFromPost = static function (string $v) use ($albumById, $hasAlbums): ?int {
    if ($v === '' || $v === '0') return 0;
    if (!$hasAlbums || !preg_match('/^[0-9]{1,10}$/D', $v) || !isset($albumById[(int) $v])) return null;
    return (int) $v;
};

/** The text of the edit form after a failed save, so nothing typed is lost. */
$photoFromPost = static fn(): array => [
    'id'        => (int) $str($_POST, 'id'),
    'filename'  => '',
    'thumb_filename' => null,
    'caption'   => $str($_POST, 'caption'),
    'alt_ta'    => $str($_POST, 'alt_ta'),
    'alt_en'    => $str($_POST, 'alt_en'),
    'album_id'  => (int) $str($_POST, 'album_id'),
    'is_active' => isset($_POST['is_active']) ? 1 : 0,
];

// ── Handle POST ──────────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // A multipart body larger than post_max_size reaches PHP with $_POST and
    // $_FILES emptied, which would otherwise trip the CSRF guard and wrongly
    // blame the admin's session. Detect it before the guard runs.
    if (!$_POST && !$_FILES && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
        $uploadFailed = true;
        $msg = $alert('error', 'That photo was too large for the server (limit ' . (string) ini_get('post_max_size') . '). Resize it and try again.');
    } else {
        $msg = adminCsrfGuard();
    }
    $action = $str($_POST, 'action');
    $back   = $listUrl();

    if ($msg === '' && $action === 'upload') {
        $caption = sanitizeText($str($_POST, 'caption'), 255);
        $altTa   = sanitizeText($str($_POST, 'alt_ta'), 300);
        $altEn   = sanitizeText($str($_POST, 'alt_en'), 300);
        $albumId = $albumFromPost($str($_POST, 'album_id'));
        $formVals = ['caption' => $caption, 'alt_ta' => $altTa, 'alt_en' => $altEn, 'album_id' => (int) $str($_POST, 'album_id')];
        $file    = $_FILES['image'] ?? null;
        $err     = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);

        if ($albumId === null) {
            $errors['album_id'] = true;
            $fieldError = 'Choose one of the listed albums.';
        } elseif (!$file || $err !== UPLOAD_ERR_OK) {
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
            $image = galleryDecodeImage((string) $file['tmp_name']);
            if ($image === null) {
                $fieldError = 'Only JPEG, PNG and WebP images are allowed.';
            } else {
                $filename = bin2hex(random_bytes(12)) . '.' . $image['ext'];
                $dest     = UPLOAD_DIR . $filename;

                if (move_uploaded_file($file['tmp_name'], $dest)) {
                    $variants = galleryMakeVariants($filename, $image['type']);
                    if ($hasAlbums) {
                        $db->prepare('INSERT INTO gallery (album_id, filename, thumb_filename, medium_filename, width, height, caption, alt_ta, alt_en, is_active, created_at)
                                      VALUES (:a, :f, :t, :m, :w, :h, :c, :ata, :aen, 1, CURRENT_TIMESTAMP)')
                           ->execute([
                               ':a' => $albumId ?: null, ':f' => $filename,
                               ':t' => $variants['thumb']['filename'] ?? null, ':m' => $variants['medium']['filename'] ?? null,
                               ':w' => $image['width'], ':h' => $image['height'],
                               ':c' => $caption, ':ata' => $altTa !== '' ? $altTa : null, ':aen' => $altEn !== '' ? $altEn : null,
                           ]);
                    } else {
                        $db->prepare('INSERT INTO gallery (filename, caption, is_active, created_at) VALUES (:f,:c,1,CURRENT_TIMESTAMP)')
                           ->execute([':f' => $filename, ':c' => $caption]);
                    }
                    $newId = (int) $db->lastInsertId();
                    $albumName = $albumId ? (string) $albumById[$albumId]['title_en'] : '';
                    adminAudit('gallery_uploaded', 'gallery:' . $newId, $filename . ($caption !== '' ? ' · ' . $caption : '') . ($albumName !== '' ? ' · album: ' . $albumName : ''));
                    $flashTo('success', 'Photo uploaded.' . ($variants['thumb'] === null ? ' The grid will use the original: a smaller copy could not be made on this server.' : '')
                        . ($altTa === '' && $altEn === '' ? ' Add alternative text so the photo is described to everyone.' : ''));
                    header('Location: ' . $listUrl($albumId ? ['a' => (string) $albumId] : []), true, 303);
                    exit;
                }
                $uploadFailed = true;
                $msg = $alert('error', 'Failed to move uploaded file.');
            }
        }
        if ($fieldError !== '') {
            $uploadFailed = true;
            $msg = $alert('error', $fieldError);
        }
    } elseif ($msg === '' && $action === 'update') {
        $id      = (int) $str($_POST, 'id');
        $caption = sanitizeText($str($_POST, 'caption'), 255);
        $altTa   = sanitizeText($str($_POST, 'alt_ta'), 300);
        $altEn   = sanitizeText($str($_POST, 'alt_en'), 300);
        $albumId = $albumFromPost($str($_POST, 'album_id'));
        $active  = isset($_POST['is_active']) ? 1 : 0;

        $stmt = $db->prepare('SELECT * FROM gallery WHERE id = :id');
        $stmt->execute([':id' => $id]);
        $current = $stmt->fetch() ?: null;
        if ($current === null) $errors['id'] = true;
        if ($albumId === null) $errors['album_id'] = true;

        if ($errors) {
            $msg = $alert('error', isset($errors['id']) ? 'That photo no longer exists.' : 'Please fix the highlighted fields.');
            $editing = $photoFromPost();
        } else {
            if ($hasAlbums) {
                $db->prepare('UPDATE gallery SET caption = :c, alt_ta = :ata, alt_en = :aen, album_id = :a, is_active = :act WHERE id = :id')
                   ->execute([':c' => $caption, ':ata' => $altTa !== '' ? $altTa : null, ':aen' => $altEn !== '' ? $altEn : null,
                              ':a' => $albumId ?: null, ':act' => $active, ':id' => $id]);
            } else {
                $db->prepare('UPDATE gallery SET caption = :c, is_active = :act WHERE id = :id')
                   ->execute([':c' => $caption, ':act' => $active, ':id' => $id]);
            }
            $fromAlbum = (int) ($current['album_id'] ?? 0);
            $detail = ($caption !== '' ? $caption : (string) $current['filename']);
            if ($hasAlbums && $fromAlbum !== (int) $albumId) {
                $detail .= ' · moved ' . ($fromAlbum && isset($albumById[$fromAlbum]) ? $albumById[$fromAlbum]['title_en'] : 'unfiled')
                         . ' → ' . ($albumId && isset($albumById[$albumId]) ? $albumById[$albumId]['title_en'] : 'unfiled');
            }
            adminAudit('gallery_updated', 'gallery:' . $id, $detail);
            $flashTo('success', 'Photo updated.');
            header('Location: ' . $back, true, 303);
            exit;
        }
    } elseif ($msg === '' && $action === 'toggle') {
        $id   = (int) $str($_POST, 'id');
        $stmt = $db->prepare('UPDATE gallery SET is_active = 1 - is_active WHERE id = :id');
        $stmt->execute([':id' => $id]);
        if ($stmt->rowCount()) {
            adminAudit('gallery_toggled', 'gallery:' . $id);
            $flashTo('success', 'Visibility changed.');
        }
        header('Location: ' . $back, true, 303);
        exit;
    } elseif ($msg === '' && $action === 'delete') {
        $id   = (int) $str($_POST, 'id');
        $stmt = $db->prepare('SELECT * FROM gallery WHERE id = :id');
        $stmt->execute([':id' => $id]);
        $row  = $stmt->fetch();
        if ($row) {
            $db->prepare('DELETE FROM gallery WHERE id = :id')->execute([':id' => $id]);
            galleryDeleteFiles($row);
            adminAudit('gallery_deleted', 'gallery:' . $id, (string) $row['filename'] . (($row['caption'] ?? '') !== '' ? ' · ' . $row['caption'] : ''));
            $flashTo('success', 'Photo deleted.');
        }
        header('Location: ' . $back, true, 303);
        exit;
    } elseif ($msg === '' && $action === 'cover' && $hasAlbums) {
        // "Use as album cover" from a photo's row menu: the photo must be in that album.
        $id   = (int) $str($_POST, 'id');
        $stmt = $db->prepare('SELECT id, album_id, caption, filename FROM gallery WHERE id = :id');
        $stmt->execute([':id' => $id]);
        $row  = $stmt->fetch();
        $aid  = $row ? (int) $row['album_id'] : 0;
        if ($row && $aid && isset($albumById[$aid])) {
            $db->prepare('UPDATE gallery_albums SET cover_image_id = :p WHERE id = :a')->execute([':p' => $id, ':a' => $aid]);
            adminAudit('gallery_album_cover', 'gallery_album:' . $aid, $albumById[$aid]['title_en'] . ' ← photo #' . $id);
            $flashTo('success', 'Album cover set.');
        } else {
            $flashTo('warning', 'Put the photo in an album first, then choose it as the cover.');
        }
        header('Location: ' . $back, true, 303);
        exit;
    } elseif ($msg === '' && $action === 'album_save' && $hasAlbums) {
        $aid     = (int) $str($_POST, 'album_id');
        $titleTa = sanitizeText($str($_POST, 'album_title_ta'), 200);
        $titleEn = sanitizeText($str($_POST, 'album_title_en'), 200);
        $descTa  = sanitizeText($str($_POST, 'album_description_ta'), 2000);
        $descEn  = sanitizeText($str($_POST, 'album_description_en'), 2000);
        $eventV  = $str($_POST, 'album_event_id');
        $order   = $str($_POST, 'album_sort_order');
        $coverV  = $str($_POST, 'album_cover_id');
        $eventId = ($eventV === '' || $eventV === '0') ? 0 : ((preg_match('/^[0-9]{1,10}$/D', $eventV) && isset($eventById[(int) $eventV])) ? (int) $eventV : null);
        $coverId = ($coverV === '' || $coverV === '0') ? 0 : (preg_match('/^[0-9]{1,10}$/D', $coverV) ? (int) $coverV : null);
        $problem = '';
        if ($titleTa === '' || $titleEn === '') $problem = 'An album needs a Tamil title and an English title.';
        elseif ($order !== '' && !preg_match('/^-?[0-9]{1,6}$/D', $order)) $problem = 'Display order must be a whole number.';
        elseif ($eventId === null) $problem = 'Choose one of the listed events.';
        elseif ($aid !== 0 && !isset($albumById[$aid])) $problem = 'That album no longer exists.';
        elseif ($coverId === null) $problem = 'Choose one of the album\'s own photos as its cover.';
        elseif ($coverId !== 0) {
            $stmt = $db->prepare('SELECT COUNT(*) FROM gallery WHERE id = :p AND album_id = :a');
            $stmt->execute([':p' => $coverId, ':a' => $aid]);
            if ($aid === 0 || (int) $stmt->fetchColumn() === 0) $problem = 'Choose one of the album\'s own photos as its cover.';
        }

        if ($problem !== '') {
            $flashTo('error', $problem);
        } elseif ($aid !== 0) {
            $db->prepare('UPDATE gallery_albums SET title_ta = :ta, title_en = :en, description_ta = :dta, description_en = :den,
                                 event_id = :e, sort_order = :o, cover_image_id = :c WHERE id = :id')
               ->execute([':ta' => $titleTa, ':en' => $titleEn, ':dta' => $descTa !== '' ? $descTa : null, ':den' => $descEn !== '' ? $descEn : null,
                          ':e' => $eventId ?: null, ':o' => $order === '' ? 0 : (int) $order, ':c' => $coverId ?: null, ':id' => $aid]);
            adminAudit('gallery_album_updated', 'gallery_album:' . $aid, $titleEn);
            $flashTo('success', 'Album updated.');
        } else {
            $db->prepare('INSERT INTO gallery_albums (slug, title_ta, title_en, description_ta, description_en, event_id, sort_order)
                          VALUES (:s, :ta, :en, :dta, :den, :e, :o)')
               ->execute([':s' => galleryAlbumSlugFree($db, $titleEn), ':ta' => $titleTa, ':en' => $titleEn,
                          ':dta' => $descTa !== '' ? $descTa : null, ':den' => $descEn !== '' ? $descEn : null,
                          ':e' => $eventId ?: null, ':o' => $order === '' ? 0 : (int) $order]);
            adminAudit('gallery_album_created', 'gallery_album:' . (int) $db->lastInsertId(), $titleEn);
            $flashTo('success', 'Album added.');
        }
        header('Location: ' . $back . '#albums', true, 303);
        exit;
    } elseif ($msg === '' && ($action === 'album_toggle' || $action === 'album_delete') && $hasAlbums) {
        $aid = (int) $str($_POST, 'album_id');
        $a   = $albumById[$aid] ?? null;
        if ($a && $action === 'album_toggle') {
            $db->prepare('UPDATE gallery_albums SET is_active = 1 - is_active WHERE id = :id')->execute([':id' => $aid]);
            adminAudit('gallery_album_toggled', 'gallery_album:' . $aid, $a['title_en']);
            $flashTo('success', 'Album visibility changed.');
        } elseif ($a && (int) $a['n'] > 0) {
            $flashTo('warning', $a['title_en'] . ' has ' . (int) $a['n'] . ' photo' . ((int) $a['n'] === 1 ? '' : 's') . ' and cannot be deleted. Hide it, or move its photos first.');
        } elseif ($a) {
            $db->prepare('DELETE FROM gallery_albums WHERE id = :id')->execute([':id' => $aid]);
            adminAudit('gallery_album_deleted', 'gallery_album:' . $aid, $a['title_en']);
            $flashTo('success', 'Album deleted.');
        }
        header('Location: ' . $back . '#albums', true, 303);
        exit;
    } elseif ($msg === '' && in_array($action, ['cover', 'album_save', 'album_toggle', 'album_delete'], true)) {
        $flashTo('warning', 'Albums are not installed on this site yet: apply database migration 021_gallery_albums.sql.');
        header('Location: ' . $back, true, 303);
        exit;
    }
}

if ($editing === null && isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM gallery WHERE id = :id');
    $stmt->execute([':id' => (int) $str($_GET, 'edit')]);
    $editing = $stmt->fetch() ?: null;
    if ($editing === null && $msg === '') $msg = $alert('warning', 'That photo no longer exists.');
}
$isEdit = $editing !== null;

// ── List ─────────────────────────────────────────────────────────────────────
$where  = ['1=1'];
$params = [];
if ($filter === 'active') $where[] = 'g.is_active = 1';
if ($filter === 'hidden') $where[] = 'g.is_active = 0';
if ($hasAlbums && $albumFilter === 'none') $where[] = 'g.album_id IS NULL';
if ($hasAlbums && $albumFilter !== '' && $albumFilter !== 'none') { $where[] = 'g.album_id = :a'; $params[':a'] = (int) $albumFilter; }
if ($q !== '') {
    $like = '%' . addcslashes($q, '%_\\') . '%';
    if ($hasAlbums) {
        $where[] = '(g.caption LIKE :q1 OR g.alt_ta LIKE :q2 OR g.alt_en LIKE :q3)';
        $params += [':q1' => $like, ':q2' => $like, ':q3' => $like];
    } else {
        $where[] = 'g.caption LIKE :q1';
        $params[':q1'] = $like;
    }
}
$stmt = $db->prepare('SELECT g.*' . ($hasAlbums ? ', a.title_en AS album_title' : '') . '
                        FROM gallery g' . ($hasAlbums ? ' LEFT JOIN gallery_albums a ON a.id = g.album_id' : '') . '
                       WHERE ' . implode(' AND ', $where) . '
                       ORDER BY g.created_at DESC, g.id DESC LIMIT 500');
$stmt->execute($params);
$images = $stmt->fetchAll();

$c = $db->query('SELECT COUNT(*) AS total, COALESCE(SUM(is_active = 1), 0) AS active, COALESCE(SUM(is_active = 0), 0) AS hidden FROM gallery')->fetch();
$chipCounts = ['all' => (int) $c['total'], 'active' => (int) $c['active'], 'hidden' => (int) $c['hidden']];
$shown      = count($images);
$filtered   = $filter !== $defaultFilter || $albumFilter !== '' || $q !== '';
$countLabel = $filtered ? "$shown of {$chipCounts['all']} photos" : "$shown photo" . ($shown === 1 ? '' : 's');
$unfiled    = $hasAlbums ? (int) $db->query('SELECT COUNT(*) FROM gallery WHERE album_id IS NULL')->fetchColumn() : 0;

// Photos per album for the cover pickers (id → caption), newest first.
$photosByAlbum = [];
if ($hasAlbums) {
    foreach ($db->query('SELECT id, album_id, caption FROM gallery WHERE album_id IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 2000')->fetchAll() as $p) {
        $photosByAlbum[(int) $p['album_id']][] = $p;
    }
}

$invalid    = static fn(string $f): string => isset($errors[$f]) ? ' aria-invalid="true" aria-describedby="err-' . $f . '"' : '';
$fieldErr   = static fn(string $f, string $text): string => isset($errors[$f]) ? '<span class="field__error" id="err-' . $f . '">' . adminIcon('alert-circle') . h($text) . '</span>' : '';
$thumbOf    = static fn(array $img): string => '/uploads/' . (($img['thumb_filename'] ?? '') !== '' && $img['thumb_filename'] !== null ? $img['thumb_filename'] : $img['filename']);
$photoLabel = static function (array $img): string {
    foreach (['alt_en', 'alt_ta', 'caption'] as $k) {
        if (($img[$k] ?? '') !== '' && $img[$k] !== null) return (string) $img[$k];
    }
    return 'Gallery photo ' . (int) $img['id'];
};
$albumOptions = static function (int $selected) use ($albums): string {
    $out = '<option value="0"' . ($selected === 0 ? ' selected' : '') . '>— No album (unfiled) —</option>';
    foreach ($albums as $a) {
        $out .= '<option value="' . (int) $a['id'] . '"' . ($selected === (int) $a['id'] ? ' selected' : '') . '>'
              . h($a['title_en']) . ' · ' . h($a['title_ta']) . ($a['is_active'] ? '' : ' (hidden)') . '</option>';
    }
    return $out;
};

$headerActions = '<a href="/gallery" target="_blank" rel="noopener" class="btn btn-ghost btn--sm">' . adminIcon('external') . 'View on site</a>';
adminHeader('Gallery', 'Media', ['actions' => $headerActions]);
echo $msg;
if (!$hasAlbums) {
    echo '<p class="alert alert--warning" role="alert">Albums and alternative text are not installed on this site yet: apply database migration <code>021_gallery_albums.sql</code> and reload. Photos can still be uploaded and deleted.</p>';
}
echo adminPageIntro(
    'Photographs for the public gallery, filed into albums by festival or event. Give every photo alternative text in Tamil and English — it is what a screen reader speaks and what appears while the picture loads. Smaller copies are made for the grid automatically; deleting a photo removes every copy from the server.',
    '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="gallery-cols" aria-expanded="false">' . adminIcon('plus') . ' New photo</button>'
);
?>

<div class="admin-two-col admin-two-col--collapsible" id="gallery-cols" data-editing="<?= ($uploadFailed || $isEdit) ? '1' : '0' ?>">
  <section class="card card--solid card--static admin-form-box" id="new" aria-labelledby="form-title">
    <?php if ($isEdit): ?>
      <h2 id="form-title"><?= adminIcon('pencil') ?> Edit photo</h2>
      <?php if (($editing['filename'] ?? '') !== ''): ?>
        <div class="card card--static">
          <img src="<?= h($thumbOf($editing)) ?>" alt="<?= h($photoLabel($editing)) ?>" width="400" height="400" loading="lazy" />
        </div>
      <?php endif; ?>
      <form method="POST" action="/admin/gallery.php">
        <?= csrfField() ?>
        <input type="hidden" name="action" value="update" />
        <input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" />
        <?php foreach ($query as $k => $v): ?><input type="hidden" name="<?= h($k) ?>" value="<?= h((string) $v) ?>" /><?php endforeach; ?>

        <label for="caption">
          <span class="field__label">Caption <span class="field__optional">optional</span></span>
          <input type="text" id="caption" name="caption" maxlength="255" value="<?= h((string) ($editing['caption'] ?? '')) ?>" autocomplete="off" aria-describedby="caption-hint" />
          <span class="field__hint" id="caption-hint">Shown under the photo on the public site. Up to 255 characters.</span>
        </label>

        <?php if ($hasAlbums): ?>
        <label for="alt_ta">
          <span class="field__label">Alternative text (Tamil) <span class="field__optional">recommended</span></span>
          <input type="text" id="alt_ta" name="alt_ta" maxlength="300" lang="ta" value="<?= h((string) ($editing['alt_ta'] ?? '')) ?>" autocomplete="off"
                 placeholder="மலர் அலங்காரத்தில் அம்மன்" aria-describedby="alt-hint" />
        </label>
        <label for="alt_en">
          <span class="field__label">Alternative text (English) <span class="field__optional">recommended</span></span>
          <input type="text" id="alt_en" name="alt_en" maxlength="300" value="<?= h((string) ($editing['alt_en'] ?? '')) ?>" autocomplete="off"
                 placeholder="The Amman in floral alankaram" aria-describedby="alt-hint" />
          <span class="field__hint" id="alt-hint">Describe what is in the picture for someone who cannot see it. Left blank, the caption is used.</span>
        </label>
        <label for="album_id">
          <span class="field__label">Album</span>
          <select id="album_id" name="album_id"<?= $invalid('album_id') ?>><?= $albumOptions((int) ($editing['album_id'] ?? 0)) ?></select>
          <?= $fieldErr('album_id', 'Choose one of the listed albums.') ?>
          <span class="field__hint">Manage albums at the foot of the list.</span>
        </label>
        <?php endif; ?>

        <label class="switch">
          <input type="checkbox" name="is_active" value="1"<?= !empty($editing['is_active']) ? ' checked' : '' ?> />
          <span class="switch__track" aria-hidden="true"></span>
          <span class="switch__label"><strong>Shown</strong><span class="switch__desc">Listed on the public gallery. Hidden photos stay saved.</span></span>
        </label>

        <div class="form-actions">
          <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> Save changes</button>
          <a href="<?= h($listUrl()) ?>" class="btn btn-ghost">Cancel</a>
        </div>
      </form>
    <?php else: ?>
      <h2 id="form-title"><?= adminIcon('upload') ?> Upload photo</h2>
      <form method="POST" action="/admin/gallery.php" enctype="multipart/form-data">
        <?= csrfField() ?>
        <input type="hidden" name="action" value="upload" />
        <?php foreach ($query as $k => $v): ?><input type="hidden" name="<?= h($k) ?>" value="<?= h((string) $v) ?>" /><?php endforeach; ?>

        <div class="field<?= $fieldError !== '' && !isset($errors['album_id']) ? ' field--error' : '' ?>">
          <span class="field__label" id="image-label">Photo <span class="field__required" aria-hidden="true">*</span></span>
          <div class="dropzone" role="group" aria-labelledby="image-label dropzone-title" aria-describedby="dropzone-hint">
            <span class="dropzone__icon" aria-hidden="true"><?= adminIcon('image') ?></span>
            <span class="dropzone__title" id="dropzone-title">Drag &amp; drop a photo, or click to browse</span>
            <span class="field__hint" id="dropzone-hint">JPEG, PNG or WebP · max <?= (int) UPLOAD_MAX_MB ?> MB · a 480 px and a 1280 px copy are made for the site</span>
            <span class="dropzone__file" aria-live="polite"></span>
            <input type="file" id="image" name="image" accept="image/jpeg,image/png,image/webp" required aria-required="true"
                   aria-labelledby="image-label"
                   aria-describedby="dropzone-hint<?= $fieldError !== '' && !isset($errors['album_id']) ? ' image-error' : '' ?>"<?= $fieldError !== '' && !isset($errors['album_id']) ? ' aria-invalid="true"' : '' ?> />
          </div>
          <?php if ($fieldError !== '' && !isset($errors['album_id'])): ?>
            <span class="field__error" id="image-error" role="alert"><?= adminIcon('alert-circle') ?> <?= h($fieldError) ?></span>
          <?php endif; ?>
        </div>

        <label for="caption">
          <span class="field__label">Caption <span class="field__optional">optional</span></span>
          <input type="text" id="caption" name="caption" maxlength="255" value="<?= h($formVals['caption']) ?>"
                 placeholder="e.g. Pournami Abhishekam, March 2026" autocomplete="off" aria-describedby="caption-hint" />
          <span class="field__hint" id="caption-hint">Shown under the photo on the public site. Up to 255 characters.</span>
        </label>

        <?php if ($hasAlbums): ?>
        <label for="alt_ta">
          <span class="field__label">Alternative text (Tamil) <span class="field__optional">recommended</span></span>
          <input type="text" id="alt_ta" name="alt_ta" maxlength="300" lang="ta" value="<?= h($formVals['alt_ta']) ?>" autocomplete="off"
                 placeholder="மலர் அலங்காரத்தில் அம்மன்" aria-describedby="alt-hint" />
        </label>
        <label for="alt_en">
          <span class="field__label">Alternative text (English) <span class="field__optional">recommended</span></span>
          <input type="text" id="alt_en" name="alt_en" maxlength="300" value="<?= h($formVals['alt_en']) ?>" autocomplete="off"
                 placeholder="The Amman in floral alankaram" aria-describedby="alt-hint" />
          <span class="field__hint" id="alt-hint">Describe what is in the picture for someone who cannot see it. Left blank, the caption is used.</span>
        </label>
        <label for="album_id">
          <span class="field__label">Album</span>
          <select id="album_id" name="album_id"<?= $invalid('album_id') ?>><?= $albumOptions($formVals['album_id'] ?: ($albumFilter !== '' && $albumFilter !== 'none' ? (int) $albumFilter : 0)) ?></select>
          <?= $fieldErr('album_id', 'Choose one of the listed albums.') ?>
          <span class="field__hint">Manage albums at the foot of the list.</span>
        </label>
        <?php endif; ?>

        <button type="submit" class="btn btn-primary"><?= adminIcon('upload') ?> Upload</button>
      </form>
    <?php endif; ?>
  </section>

  <div class="admin-list">
    <div class="toolbar">
      <nav class="filter-chips" aria-label="Filter photos">
        <?php foreach ($filters as $key => $label): ?>
          <a class="chip" href="<?= h($listUrl(['f' => $key === $defaultFilter ? '' : $key])) ?>"<?= $key === $filter ? ' aria-current="page"' : '' ?>>
            <?= h($label) ?> <span class="chip__count"><?= $chipCounts[$key] ?></span>
          </a>
        <?php endforeach; ?>
      </nav>
      <span class="toolbar__count" aria-live="polite"><?= h($countLabel) ?></span>
    </div>
    <form method="GET" action="/admin/gallery.php" class="toolbar" role="search">
      <?php if ($query['f'] !== ''): ?><input type="hidden" name="f" value="<?= h($query['f']) ?>" /><?php endif; ?>
      <?php if ($hasAlbums): ?>
      <div class="toolbar__group">
        <label class="sr-only" for="gallery-a">Album</label>
        <select id="gallery-a" name="a">
          <option value="">All albums</option>
          <option value="none"<?= $albumFilter === 'none' ? ' selected' : '' ?>>Unfiled (<?= $unfiled ?>)</option>
          <?php foreach ($albums as $a): ?>
            <option value="<?= (int) $a['id'] ?>"<?= $albumFilter === (string) $a['id'] ? ' selected' : '' ?>><?= h($a['title_en']) ?> (<?= (int) $a['n'] ?>)</option>
          <?php endforeach; ?>
        </select>
      </div>
      <?php endif; ?>
      <div class="toolbar__search">
        <?= adminIcon('search') ?>
        <label class="sr-only" for="gallery-q">Search photos by caption or alternative text</label>
        <input id="gallery-q" name="q" type="search" placeholder="Search caption or alt text…" value="<?= h($q) ?>" maxlength="100" autocomplete="off" />
      </div>
      <div class="toolbar__group">
        <button type="submit" class="btn btn--sm">Search</button>
        <?php if ($q !== '' || $albumFilter !== ''): ?><a href="<?= h($listUrl(['q' => '', 'a' => ''])) ?>" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Clear</a><?php endif; ?>
      </div>
    </form>

    <?php if ($images): ?>
      <div class="gallery-admin-grid">
        <?php foreach ($images as $img): $cap = trim((string) ($img['caption'] ?? '')); $id = (int) $img['id']; $aid = (int) ($img['album_id'] ?? 0); $noAlt = $hasAlbums && trim((string) ($img['alt_ta'] ?? '')) === '' && trim((string) ($img['alt_en'] ?? '')) === ''; ?>
          <figure class="gallery-admin-item">
            <?php // the card wraps the photo only: .card sets overflow:hidden, which would clip the row menu popover ?>
            <div class="card card--static">
              <img src="<?= h($thumbOf($img)) ?>" alt="<?= h($photoLabel($img)) ?>" loading="lazy" decoding="async" width="400" height="400" />
            </div>
            <figcaption class="gallery-admin-item__info">
              <div class="grow">
                <?php if ($cap !== ''): ?>
                  <p title="<?= h($cap) ?>"><?= h($cap) ?></p>
                <?php else: ?>
                  <p class="text-muted">No caption</p>
                <?php endif; ?>
                <p>
                  <?= $img['is_active'] ? '' : adminBadge('Hidden', 'muted') ?>
                  <?= $hasAlbums && $aid && !empty($img['album_title']) ? adminBadge((string) $img['album_title'], 'info') : '' ?>
                  <?= $hasAlbums && $noAlt ? adminBadge('No alt text', 'warning') : '' ?>
                  <?= $hasAlbums && ($img['thumb_filename'] ?? null) === null ? adminBadge('Original only', 'muted') : '' ?>
                </p>
                <time class="text-xs" datetime="<?= h($img['created_at']) ?>"><?= h(adminFmtDate($img['created_at'])) ?></time>
              </div>
              <?= adminMenu(array_values(array_filter([
                  ['label' => 'Edit', 'icon' => 'pencil', 'href' => $listUrl(['edit' => $id])],
                  ['label' => $img['is_active'] ? 'Hide' : 'Show', 'icon' => $img['is_active'] ? 'eye-off' : 'eye',
                   'form' => ['action' => 'toggle', 'id' => $id] + $query],
                  $hasAlbums && $aid ? ['label' => 'Use as album cover', 'icon' => 'star', 'form' => ['action' => 'cover', 'id' => $id] + $query] : null,
                  ['label' => 'View original', 'href' => '/uploads/' . $img['filename'], 'icon' => 'external'],
                  'divider',
                  [
                      'label'        => 'Delete',
                      'icon'         => 'trash',
                      'danger'       => true,
                      'form'         => ['action' => 'delete', 'id' => $id] + $query,
                      'confirm'      => 'Delete this photo? It is removed from the public gallery and every copy of the file is deleted from the server.',
                      'confirmLabel' => 'Delete photo',
                  ],
              ])), 'Actions for ' . $photoLabel($img)) ?>
            </figcaption>
          </figure>
        <?php endforeach; ?>
      </div>
    <?php elseif ($filtered): ?>
      <?= adminEmpty('search', 'No photos match', 'Try another album, filter or search.',
          '<a href="/admin/gallery.php" class="btn btn--sm">' . adminIcon('x') . ' Clear filters</a>') ?>
    <?php else: ?>
      <?= adminEmpty(
          'image',
          'No photos yet',
          'Upload the first photo of a festival, pooja or the temple to start the public gallery.',
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('upload') . ' Upload a photo</a>'
      ) ?>
    <?php endif; ?>

    <?php if ($hasAlbums): ?>
    <section class="card card--solid card--static mt-6" id="albums" aria-labelledby="albums-title">
      <h2 id="albums-title"><?= adminIcon('layers') ?> Albums</h2>
      <p class="field__hint">Visitors filter the gallery by these (<code>/gallery?album=…</code>). An album is listed publicly once it holds a shown photo; a hidden album hides its photos too; an album with photos cannot be deleted. The cover is the newest photo unless one is chosen.</p>
      <?php if ($albums): ?>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Album</th>
              <th scope="col">Photos</th>
              <th scope="col">Status</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <?php foreach ($albums as $a): $aid = (int) $a['id']; $n = (int) $a['n']; ?>
            <tr>
              <td class="cell-num"><?= (int) $a['sort_order'] ?></td>
              <td>
                <form method="POST" action="/admin/gallery.php" class="inline-edit" aria-label="Edit album <?= h($a['title_en']) ?>">
                  <?= csrfField() ?>
                  <input type="hidden" name="action" value="album_save" />
                  <input type="hidden" name="album_id" value="<?= $aid ?>" />
                  <?php foreach ($query as $k => $v): ?><input type="hidden" name="<?= h($k) ?>" value="<?= h((string) $v) ?>" /><?php endforeach; ?>
                  <label class="sr-only" for="album_title_ta_<?= $aid ?>">Tamil title</label>
                  <input id="album_title_ta_<?= $aid ?>" name="album_title_ta" type="text" lang="ta" required maxlength="200" value="<?= h($a['title_ta']) ?>" />
                  <label class="sr-only" for="album_title_en_<?= $aid ?>">English title</label>
                  <input id="album_title_en_<?= $aid ?>" name="album_title_en" type="text" required maxlength="200" value="<?= h($a['title_en']) ?>" />
                  <label class="sr-only" for="album_sort_<?= $aid ?>">Order</label>
                  <input id="album_sort_<?= $aid ?>" name="album_sort_order" type="number" step="1" min="-999999" max="999999" value="<?= (int) $a['sort_order'] ?>" class="cell-num" />
                  <label class="sr-only" for="album_description_ta_<?= $aid ?>">Tamil description</label>
                  <input id="album_description_ta_<?= $aid ?>" name="album_description_ta" type="text" lang="ta" maxlength="2000" placeholder="விளக்கம் (தமிழ்)" value="<?= h((string) ($a['description_ta'] ?? '')) ?>" />
                  <label class="sr-only" for="album_description_en_<?= $aid ?>">English description</label>
                  <input id="album_description_en_<?= $aid ?>" name="album_description_en" type="text" maxlength="2000" placeholder="Description (English)" value="<?= h((string) ($a['description_en'] ?? '')) ?>" />
                  <label class="sr-only" for="album_event_<?= $aid ?>">Event</label>
                  <select id="album_event_<?= $aid ?>" name="album_event_id">
                    <option value="0">— No event —</option>
                    <?php foreach ($events as $ev): ?>
                      <option value="<?= (int) $ev['id'] ?>"<?= (int) ($a['event_id'] ?? 0) === (int) $ev['id'] ? ' selected' : '' ?>><?= h($ev['title_en']) ?> · <?= h((string) $ev['event_date']) ?></option>
                    <?php endforeach; ?>
                  </select>
                  <label class="sr-only" for="album_cover_<?= $aid ?>">Cover photo</label>
                  <select id="album_cover_<?= $aid ?>" name="album_cover_id">
                    <option value="0">— Cover: newest photo —</option>
                    <?php foreach ($photosByAlbum[$aid] ?? [] as $p): ?>
                      <option value="<?= (int) $p['id'] ?>"<?= (int) ($a['cover_image_id'] ?? 0) === (int) $p['id'] ? ' selected' : '' ?>>#<?= (int) $p['id'] ?><?= ($p['caption'] ?? '') !== '' ? ' · ' . h(mb_substr((string) $p['caption'], 0, 40)) : '' ?></option>
                    <?php endforeach; ?>
                  </select>
                  <button type="submit" class="btn btn--sm"><?= adminIcon('check') ?> Save</button>
                </form>
                <span class="cell-muted">/gallery?album=<?= h($a['slug']) ?></span>
              </td>
              <td class="cell-num"><a href="<?= h($listUrl(['a' => (string) $aid])) ?>"><?= $n ?></a><?= $n !== (int) $a['n_active'] ? ' <span class="cell-muted">(' . (int) $a['n_active'] . ' shown)</span>' : '' ?></td>
              <td><?= $a['is_active'] ? adminBadge('Shown', 'success') : adminBadge('Hidden', 'muted') ?></td>
              <td class="cell-actions">
                <?= adminMenu(array_values(array_filter([
                    ['label' => $a['is_active'] ? 'Hide' : 'Show', 'icon' => $a['is_active'] ? 'eye-off' : 'eye',
                     'form' => ['action' => 'album_toggle', 'album_id' => $aid] + $query],
                    ['label' => 'View on site', 'icon' => 'external', 'href' => '/gallery?album=' . rawurlencode((string) $a['slug'])],
                    $n === 0 ? 'divider' : null,
                    $n === 0 ? ['label' => 'Delete', 'icon' => 'trash', 'danger' => true,
                     'form' => ['action' => 'album_delete', 'album_id' => $aid] + $query,
                     'confirm' => 'Delete the album “' . $a['title_en'] . '”?'] : null,
                ])), 'Actions for album ' . $a['title_en']) ?>
              </td>
            </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      </div>
      <?php endif; ?>
      <form method="POST" action="/admin/gallery.php" class="inline-edit mt-4" aria-label="New album">
        <?= csrfField() ?>
        <input type="hidden" name="action" value="album_save" />
        <input type="hidden" name="album_id" value="0" />
        <?php foreach ($query as $k => $v): ?><input type="hidden" name="<?= h($k) ?>" value="<?= h((string) $v) ?>" /><?php endforeach; ?>
        <label class="sr-only" for="album_title_ta">New album, Tamil title</label>
        <input id="album_title_ta" name="album_title_ta" type="text" lang="ta" required maxlength="200" placeholder="தமிழ் தலைப்பு" />
        <label class="sr-only" for="album_title_en">New album, English title</label>
        <input id="album_title_en" name="album_title_en" type="text" required maxlength="200" placeholder="English title" />
        <label class="sr-only" for="album_sort_order">Order</label>
        <input id="album_sort_order" name="album_sort_order" type="number" step="1" min="-999999" max="999999" value="<?= $albums ? (int) max(array_column($albums, 'sort_order')) + 10 : 10 ?>" class="cell-num" />
        <label class="sr-only" for="album_event_id">Event</label>
        <select id="album_event_id" name="album_event_id">
          <option value="0">— No event —</option>
          <?php foreach ($events as $ev): ?>
            <option value="<?= (int) $ev['id'] ?>"><?= h($ev['title_en']) ?> · <?= h((string) $ev['event_date']) ?></option>
          <?php endforeach; ?>
        </select>
        <button type="submit" class="btn btn-primary btn--sm"><?= adminIcon('plus') ?> Add album</button>
      </form>
    </section>
    <?php endif; ?>
  </div>
</div>

<?php adminFooter(); ?>
