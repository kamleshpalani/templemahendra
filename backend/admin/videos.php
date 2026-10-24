<?php
// backend/admin/videos.php — Media → Videos (brief §6 "Videos", §15).
//
// The temple's YouTube videos, each in a category the committee manages on the
// same page: paste a YouTube link or id, give a Tamil and an English title,
// pick a category, optionally the live darshan broadcast it recorded, and it
// appears on /videos. Hidden videos and hidden categories stay saved but are
// not shown to visitors. Categories with videos cannot be deleted, only hidden.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/videos.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

/** String value from a request array ('' when missing or not scalar). */
$str = static fn(array $src, string $key): string => is_scalar($src[$key] ?? null) ? (string) $src[$key] : '';

if (!videoTablesExist()) {
    adminHeader('Videos', 'Content');
    echo '<p class="alert alert--warning" role="alert">Videos are not installed on this site yet: apply database migration <code>017_videos.sql</code> and reload.</p>';
    adminFooter();
    exit;
}

/** A category slug nobody else uses, from the English name; "-2", "-3"… on a clash. */
function videoCategorySlugFree(PDO $db, string $nameEn, ?int $exceptId): string
{
    $base = substr(videoCategorySlug($nameEn), 0, 56);
    $stmt = $db->prepare('SELECT id FROM video_categories WHERE slug = :s' . ($exceptId ? ' AND id <> :e' : ''));
    for ($n = 1; $n < 100; $n++) {
        $slug   = $n === 1 ? $base : $base . '-' . $n;
        $params = [':s' => $slug];
        if ($exceptId) $params[':e'] = $exceptId;
        $stmt->execute($params);
        if (!$stmt->fetch()) return $slug;
    }
    return $base . '-' . bin2hex(random_bytes(2));
}

$alert = static fn(string $tone, string $text): string => '<p class="alert alert--' . $tone . '" role="' . ($tone === 'success' ? 'status' : 'alert') . '">' . h($text) . '</p>';

// ── Flash left by the previous request (POST → 303 → GET) ────────────────────
$msg = '';
if (!empty($_SESSION['flash'])) {
    $msg = (string) $_SESSION['flash'];
    unset($_SESSION['flash']);
}

$categories = $db->query('SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.category_id = c.id) AS n
                            FROM video_categories c ORDER BY c.sort_order ASC, c.id ASC LIMIT 200')->fetchAll();
$categoryById = array_column($categories, null, 'id');

$hasStreams = videoStreamsTableExists();
$streams    = $hasStreams
    ? $db->query("SELECT id, slug, title_en, title_ta, recording_url, provider_broadcast_id, actual_end_at, scheduled_start_at
                    FROM live_streams WHERE deleted_at IS NULL AND status = 'COMPLETED'
                   ORDER BY COALESCE(actual_end_at, scheduled_start_at) DESC, id DESC LIMIT 150")->fetchAll()
    : [];
$streamById = array_column($streams, null, 'id');

$filters       = ['all' => 'All', 'active' => 'Shown', 'hidden' => 'Hidden', 'featured' => 'Featured'];
$defaultFilter = 'all';
$src           = $_SERVER['REQUEST_METHOD'] === 'POST' ? $_POST : $_GET;
$filter        = isset($filters[$str($src, 'f')]) ? $str($src, 'f') : $defaultFilter;
$catFilter     = (int) $str($src, 'c');
if ($catFilter !== 0 && !isset($categoryById[$catFilter])) $catFilter = 0;
$q             = mb_substr(trim($str($src, 'q')), 0, 100);
$query         = ['f' => $filter === $defaultFilter ? '' : $filter, 'c' => $catFilter ?: '', 'q' => $q];
$listUrl       = static fn(array $override = []): string => '/admin/videos.php' . rtrim(adminQuery($query, $override), '?');

$editing = null;
$errors  = [];

$fromPost = static fn(): array => [
    'id'             => (int) $str($_POST, 'id'),
    'youtube'        => $str($_POST, 'youtube'),
    'title_ta'       => $str($_POST, 'title_ta'),
    'title_en'       => $str($_POST, 'title_en'),
    'description_ta' => $str($_POST, 'description_ta'),
    'description_en' => $str($_POST, 'description_en'),
    'category_id'    => (int) $str($_POST, 'category_id'),
    'live_stream_id' => (int) $str($_POST, 'live_stream_id'),
    'published_on'   => $str($_POST, 'published_on'),
    'sort_order'     => $str($_POST, 'sort_order'),
    'is_featured'    => isset($_POST['is_featured']) ? 1 : 0,
    'is_active'      => isset($_POST['is_active']) ? 1 : 0,
];

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $msg    = adminCsrfGuard();
    $action = $str($_POST, 'action');
    $back   = $listUrl();

    if ($msg !== '' && $action === 'save') $editing = $fromPost();

    if ($msg === '' && $action === 'save') {
        $id        = (int) $str($_POST, 'id');
        $youtube   = trim($str($_POST, 'youtube'));
        $ytId      = videoYoutubeId($youtube);
        $titleTa   = sanitizeText($str($_POST, 'title_ta'), 300);
        $titleEn   = sanitizeText($str($_POST, 'title_en'), 300);
        $descTa    = sanitizeText($str($_POST, 'description_ta'), 5000);
        $descEn    = sanitizeText($str($_POST, 'description_en'), 5000);
        $catId     = (int) $str($_POST, 'category_id');
        $streamId  = (int) $str($_POST, 'live_stream_id');
        $published = trim($str($_POST, 'published_on'));
        $order     = $str($_POST, 'sort_order');
        $featured  = isset($_POST['is_featured']) ? 1 : 0;
        $active    = isset($_POST['is_active']) ? 1 : 0;

        // A recording of a broadcast may leave the link blank: the broadcast's own recording is used.
        if ($ytId === null && $youtube === '' && $streamId > 0 && isset($streamById[$streamId])) {
            $s    = $streamById[$streamId];
            $ytId = videoYoutubeId($s['recording_url'] ?? '') ?? videoYoutubeId($s['provider_broadcast_id'] ?? '');
        }

        if ($ytId === null) $errors['youtube'] = true;
        if ($titleTa === '') $errors['title_ta'] = true;
        if ($titleEn === '') $errors['title_en'] = true;
        if ($catId !== 0 && !isset($categoryById[$catId])) $errors['category_id'] = true;
        if ($streamId !== 0 && !isset($streamById[$streamId])) $errors['live_stream_id'] = true;
        if ($published !== '' && !(preg_match('/^\d{4}-\d{2}-\d{2}$/', $published) && DateTimeImmutable::createFromFormat('!Y-m-d', $published) !== false
            && DateTimeImmutable::createFromFormat('!Y-m-d', $published)->format('Y-m-d') === $published)) $errors['published_on'] = true;
        if ($order !== '' && !preg_match('/^-?[0-9]{1,6}$/', $order)) $errors['sort_order'] = true;

        $current = null;
        if ($id > 0 && !$errors) {
            $stmt = $db->prepare('SELECT * FROM videos WHERE id = :id');
            $stmt->execute([':id' => $id]);
            $current = $stmt->fetch() ?: null;
            if ($current === null) $errors['id'] = true;
        }
        if ($ytId !== null && !$errors) {
            $stmt = $db->prepare('SELECT id, title_en FROM videos WHERE youtube_id = :y' . ($id > 0 ? ' AND id <> :id' : ''));
            $stmt->execute($id > 0 ? [':y' => $ytId, ':id' => $id] : [':y' => $ytId]);
            if ($dup = $stmt->fetch()) $errors['duplicate'] = 'That YouTube video is already listed as “' . $dup['title_en'] . '” (#' . (int) $dup['id'] . ').';
        }

        if ($errors) {
            $msg = $alert('error', isset($errors['id']) ? 'That video no longer exists.' : ($errors['duplicate'] ?? 'Please fix the highlighted fields.'));
            $editing = $fromPost();
        } else {
            $params = [
                ':y' => $ytId, ':ta' => $titleTa, ':en' => $titleEn,
                ':dta' => $descTa !== '' ? $descTa : null, ':den' => $descEn !== '' ? $descEn : null,
                ':c' => $catId ?: null, ':s' => $hasStreams && $streamId ? $streamId : null,
                ':p' => $published !== '' ? $published : null, ':o' => $order === '' ? 0 : (int) $order,
                ':fe' => $featured, ':a' => $active,
            ];
            if ($current) {
                $params[':id'] = $id;
                $db->prepare('UPDATE videos SET youtube_id=:y, title_ta=:ta, title_en=:en, description_ta=:dta, description_en=:den, category_id=:c,
                                 live_stream_id=:s, published_on=:p, sort_order=:o, is_featured=:fe, is_active=:a WHERE id=:id')->execute($params);
                adminAudit('video_updated', 'video:' . $id, $titleEn . ' [' . $ytId . ']');
                $_SESSION['flash'] = $alert('success', 'Updated.');
            } else {
                $db->prepare('INSERT INTO videos (youtube_id, title_ta, title_en, description_ta, description_en, category_id, live_stream_id, published_on, sort_order, is_featured, is_active)
                              VALUES (:y, :ta, :en, :dta, :den, :c, :s, :p, :o, :fe, :a)')->execute($params);
                adminAudit('video_created', 'video:' . (int) $db->lastInsertId(), $titleEn . ' [' . $ytId . ']');
                $_SESSION['flash'] = $alert('success', 'Added.');
            }
            header('Location: ' . $back, true, 303);
            exit;
        }
    } elseif ($msg === '' && ($action === 'toggle' || $action === 'feature')) {
        $id   = (int) $str($_POST, 'id');
        $col  = $action === 'toggle' ? 'is_active' : 'is_featured';
        $stmt = $db->prepare("UPDATE videos SET $col = 1 - $col WHERE id = :id");
        $stmt->execute([':id' => $id]);
        if ($stmt->rowCount()) {
            adminAudit($action === 'toggle' ? 'video_toggled' : 'video_featured', 'video:' . $id);
            $_SESSION['flash'] = $alert('success', $action === 'toggle' ? 'Visibility changed.' : 'Featured changed.');
        }
        header('Location: ' . $back, true, 303);
        exit;
    } elseif ($msg === '' && $action === 'delete') {
        $id   = (int) $str($_POST, 'id');
        $stmt = $db->prepare('SELECT title_en, youtube_id FROM videos WHERE id = :id');
        $stmt->execute([':id' => $id]);
        if ($row = $stmt->fetch()) {
            $db->prepare('DELETE FROM videos WHERE id = :id')->execute([':id' => $id]);
            adminAudit('video_deleted', 'video:' . $id, $row['title_en'] . ' [' . $row['youtube_id'] . ']');
            $_SESSION['flash'] = $alert('success', 'Deleted.');
        }
        header('Location: ' . $back, true, 303);
        exit;
    } elseif ($msg === '' && $action === 'cat_save') {
        $cid    = (int) $str($_POST, 'cat_id');
        $nameTa = sanitizeText($str($_POST, 'cat_name_ta'), 200);
        $nameEn = sanitizeText($str($_POST, 'cat_name_en'), 200);
        $order  = $str($_POST, 'cat_sort_order');
        if ($nameTa === '' || $nameEn === '' || ($order !== '' && !preg_match('/^-?[0-9]{1,6}$/', $order)) || ($cid !== 0 && !isset($categoryById[$cid]))) {
            $_SESSION['flash'] = $alert('error', 'A category needs a Tamil name, an English name and a whole-number order.');
        } elseif ($cid !== 0) {
            $db->prepare('UPDATE video_categories SET name_ta=:ta, name_en=:en, sort_order=:o WHERE id=:id')
               ->execute([':ta' => $nameTa, ':en' => $nameEn, ':o' => $order === '' ? 0 : (int) $order, ':id' => $cid]);
            adminAudit('video_category_updated', 'video_category:' . $cid, $nameEn);
            $_SESSION['flash'] = $alert('success', 'Category updated.');
        } else {
            $db->prepare('INSERT INTO video_categories (slug, name_ta, name_en, sort_order) VALUES (:s, :ta, :en, :o)')
               ->execute([':s' => videoCategorySlugFree($db, $nameEn, null), ':ta' => $nameTa, ':en' => $nameEn, ':o' => $order === '' ? 0 : (int) $order]);
            adminAudit('video_category_created', 'video_category:' . (int) $db->lastInsertId(), $nameEn);
            $_SESSION['flash'] = $alert('success', 'Category added.');
        }
        header('Location: ' . $back . '#categories', true, 303);
        exit;
    } elseif ($msg === '' && ($action === 'cat_toggle' || $action === 'cat_delete')) {
        $cid = (int) $str($_POST, 'cat_id');
        $cat = $categoryById[$cid] ?? null;
        if ($cat && $action === 'cat_toggle') {
            $db->prepare('UPDATE video_categories SET is_active = 1 - is_active WHERE id = :id')->execute([':id' => $cid]);
            adminAudit('video_category_toggled', 'video_category:' . $cid, $cat['name_en']);
            $_SESSION['flash'] = $alert('success', 'Category visibility changed.');
        } elseif ($cat && (int) $cat['n'] > 0) {
            $_SESSION['flash'] = $alert('warning', $cat['name_en'] . ' has ' . (int) $cat['n'] . ' video' . ((int) $cat['n'] === 1 ? '' : 's') . ' and cannot be deleted. Hide it, or move its videos first.');
        } elseif ($cat) {
            $db->prepare('DELETE FROM video_categories WHERE id = :id')->execute([':id' => $cid]);
            adminAudit('video_category_deleted', 'video_category:' . $cid, $cat['name_en']);
            $_SESSION['flash'] = $alert('success', 'Category deleted.');
        }
        header('Location: ' . $back . '#categories', true, 303);
        exit;
    }
}

if ($editing === null && isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM videos WHERE id = :id');
    $stmt->execute([':id' => (int) $str($_GET, 'edit')]);
    $editing = $stmt->fetch() ?: null;
    if ($editing) $editing['youtube'] = $editing['youtube_id'];
    if ($editing === null && $msg === '') $msg = $alert('warning', 'That video no longer exists.');
}
$isEdit   = !empty($editing['id']);
$formOpen = $editing !== null;

// ── List ─────────────────────────────────────────────────────────────────────
$where  = ['1=1'];
$params = [];
switch ($filter) {
    case 'active':   $where[] = 'v.is_active = 1'; break;
    case 'hidden':   $where[] = 'v.is_active = 0'; break;
    case 'featured': $where[] = 'v.is_featured = 1'; break;
}
if ($catFilter) { $where[] = 'v.category_id = :c'; $params[':c'] = $catFilter; }
if ($q !== '') {
    $where[] = '(v.title_en LIKE :q1 OR v.title_ta LIKE :q2 OR v.youtube_id LIKE :q3)';
    $like = '%' . addcslashes($q, '%_\\') . '%';
    $params += [':q1' => $like, ':q2' => $like, ':q3' => $like];
}
$stmt = $db->prepare('SELECT v.*, c.name_en AS category_name, ' . ($hasStreams ? 's.slug' : 'NULL') . ' AS stream_slug
                        FROM videos v LEFT JOIN video_categories c ON c.id = v.category_id
                        ' . ($hasStreams ? 'LEFT JOIN live_streams s ON s.id = v.live_stream_id' : '') . '
                       WHERE ' . implode(' AND ', $where) . '
                       ORDER BY v.sort_order ASC, v.published_on IS NULL, v.published_on DESC, v.id DESC LIMIT 300');
$stmt->execute($params);
$rows = $stmt->fetchAll();

$c = $db->query('SELECT COUNT(*) AS total, COALESCE(SUM(is_active = 1), 0) AS active, COALESCE(SUM(is_active = 0), 0) AS hidden, COALESCE(SUM(is_featured = 1), 0) AS featured FROM videos')->fetch();
$chipCounts = ['all' => (int) $c['total'], 'active' => (int) $c['active'], 'hidden' => (int) $c['hidden'], 'featured' => (int) $c['featured']];
$shown      = count($rows);
$filtered   = $filter !== $defaultFilter || $catFilter || $q !== '';
$countLabel = $filtered ? "$shown of {$chipCounts['all']} videos" : "$shown video" . ($shown === 1 ? '' : 's');

$invalid    = static fn(string $f): string => isset($errors[$f]) ? ' aria-invalid="true" aria-describedby="err-' . $f . '"' : '';
$fieldError = static fn(string $f, string $text): string => isset($errors[$f]) ? '<span class="field__error" id="err-' . $f . '">' . adminIcon('alert-circle') . h($text) . '</span>' : '';

adminHeader('Videos', 'Content', [
    'actions' => '<a href="/videos" target="_blank" rel="noopener" class="btn btn-ghost btn--sm">' . adminIcon('external') . 'View on site</a>',
]);
echo $msg;
echo adminPageIntro(
    'YouTube videos shown on the Videos page, grouped by category. Paste a YouTube link or the 11-character video id; the title and description are shown in Tamil and English. Previous live darshan broadcasts already appear under Darshan recordings — link one here to list it alongside the other videos.',
    '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="crud" aria-expanded="false">' . adminIcon('plus') . ' New video</button>'
);
?>

<div class="admin-two-col admin-two-col--collapsible" id="crud" data-editing="<?= $formOpen ? '1' : '0' ?>">

  <section class="card card--solid card--static admin-form-box" id="new" aria-labelledby="form-title">
    <h2 id="form-title"><?= adminIcon($isEdit ? 'pencil' : 'play') ?> <?= $isEdit ? 'Edit video' : 'New video' ?></h2>
    <form method="POST" action="/admin/videos.php">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save" />
      <input type="hidden" name="f" value="<?= h($filter) ?>" />
      <input type="hidden" name="c" value="<?= $catFilter ?: '' ?>" />
      <input type="hidden" name="q" value="<?= h($q) ?>" />
      <?php if ($isEdit): ?><input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" /><?php endif; ?>

      <label for="youtube">
        <span class="field__label">YouTube link or video id <span class="field__required" aria-hidden="true">*</span></span>
        <input id="youtube" name="youtube" type="text" maxlength="500" autocomplete="off" inputmode="url" spellcheck="false"
               placeholder="https://www.youtube.com/watch?v=… or dQw4w9WgXcQ" value="<?= h($editing['youtube'] ?? '') ?>"<?= $invalid('youtube') ?> />
        <?= $fieldError('youtube', 'Paste a YouTube link (youtube.com/watch, youtu.be, shorts, live) or the 11-character video id.') ?>
        <?php if (!empty($editing['youtube_id'])): ?><span class="field__hint">Currently <a href="<?= h(liveYoutubeWatchUrl($editing['youtube_id'])) ?>" target="_blank" rel="noopener"><?= h($editing['youtube_id']) ?></a></span><?php endif; ?>
      </label>

      <label for="title_ta">
        <span class="field__label">Title (Tamil) <span class="field__required" aria-hidden="true">*</span></span>
        <input id="title_ta" name="title_ta" type="text" required aria-required="true" maxlength="300" lang="ta" autocomplete="off"
               placeholder="பௌர்ணமி பூஜை" value="<?= h($editing['title_ta'] ?? '') ?>"<?= $invalid('title_ta') ?> />
        <?= $fieldError('title_ta', 'The Tamil title is required.') ?>
      </label>

      <label for="title_en">
        <span class="field__label">Title (English) <span class="field__required" aria-hidden="true">*</span></span>
        <input id="title_en" name="title_en" type="text" required aria-required="true" maxlength="300" autocomplete="off"
               placeholder="Pournami Pooja" value="<?= h($editing['title_en'] ?? '') ?>"<?= $invalid('title_en') ?> />
        <?= $fieldError('title_en', 'The English title is required.') ?>
      </label>

      <label for="description_ta">
        <span class="field__label">Description (Tamil) <span class="field__optional">optional</span></span>
        <textarea id="description_ta" name="description_ta" rows="3" maxlength="5000" lang="ta" data-counter><?= h($editing['description_ta'] ?? '') ?></textarea>
      </label>

      <label for="description_en">
        <span class="field__label">Description (English) <span class="field__optional">optional</span></span>
        <textarea id="description_en" name="description_en" rows="3" maxlength="5000" data-counter><?= h($editing['description_en'] ?? '') ?></textarea>
      </label>

      <label for="category_id">
        <span class="field__label">Category</span>
        <select id="category_id" name="category_id"<?= $invalid('category_id') ?>>
          <option value="0">— None —</option>
          <?php foreach ($categories as $cat): ?>
            <option value="<?= (int) $cat['id'] ?>"<?= (int) ($editing['category_id'] ?? 0) === (int) $cat['id'] ? ' selected' : '' ?>>
              <?= h($cat['name_en']) ?> · <?= h($cat['name_ta']) ?><?= $cat['is_active'] ? '' : ' (hidden)' ?>
            </option>
          <?php endforeach; ?>
        </select>
        <?= $fieldError('category_id', 'Choose one of the listed categories.') ?>
        <span class="field__hint">Manage categories at the foot of the list.</span>
      </label>

      <?php if ($hasStreams): ?>
      <label for="live_stream_id">
        <span class="field__label">Recording of a live darshan <span class="field__optional">optional</span></span>
        <select id="live_stream_id" name="live_stream_id"<?= $invalid('live_stream_id') ?>>
          <option value="0">— Not a broadcast recording —</option>
          <?php foreach ($streams as $s): $when = $s['actual_end_at'] ?? $s['scheduled_start_at']; ?>
            <option value="<?= (int) $s['id'] ?>"<?= (int) ($editing['live_stream_id'] ?? 0) === (int) $s['id'] ? ' selected' : '' ?>>
              <?= h($s['title_en']) ?><?= $when ? ' · ' . h(substr((string) $when, 0, 10)) : '' ?><?= videoYoutubeId($s['recording_url'] ?? '') || videoYoutubeId($s['provider_broadcast_id'] ?? '') ? '' : ' (no YouTube recording)' ?>
            </option>
          <?php endforeach; ?>
        </select>
        <?= $fieldError('live_stream_id', 'Choose one of the listed completed broadcasts.') ?>
        <span class="field__hint">Leave the YouTube link blank to use the broadcast’s own recording.</span>
      </label>
      <?php endif; ?>

      <div class="form-grid">
        <label for="published_on">
          <span class="field__label">Date <span class="field__optional">optional</span></span>
          <input id="published_on" name="published_on" type="date" value="<?= h($editing['published_on'] ?? '') ?>"<?= $invalid('published_on') ?> />
          <?= $fieldError('published_on', 'Enter a valid date.') ?>
          <span class="field__hint">When the pooja or event took place; newest first.</span>
        </label>
        <label for="sort_order">
          <span class="field__label">Display order</span>
          <input id="sort_order" name="sort_order" type="number" inputmode="numeric" min="-999999" max="999999" step="1"
                 value="<?= h((string) ($editing['sort_order'] ?? '0')) ?>"<?= $invalid('sort_order') ?> />
          <?= $fieldError('sort_order', 'Display order must be a whole number.') ?>
          <span class="field__hint">Smaller numbers come first.</span>
        </label>
      </div>

      <label class="switch">
        <input type="checkbox" name="is_featured" value="1"<?= !empty($editing['is_featured']) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Featured</strong><span class="switch__desc">Played large at the top of the Videos page (the first featured video in display order).</span></span>
      </label>

      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= (!$editing || !empty($editing['is_active'])) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Shown</strong><span class="switch__desc">Listed on the Videos page. Hidden videos stay saved.</span></span>
      </label>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> <?= $isEdit ? 'Save changes' : 'Add video' ?></button>
        <?php if ($formOpen): ?><a href="<?= h($listUrl()) ?>" class="btn btn-ghost">Cancel</a><?php endif; ?>
      </div>
    </form>
  </section>

  <div class="admin-list">
    <div class="toolbar">
      <nav class="filter-chips" aria-label="Filter videos">
        <?php foreach ($filters as $key => $label): ?>
          <a class="chip" href="<?= h($listUrl(['f' => $key === $defaultFilter ? '' : $key])) ?>"<?= $key === $filter ? ' aria-current="page"' : '' ?>>
            <?= h($label) ?> <span class="chip__count"><?= $chipCounts[$key] ?></span>
          </a>
        <?php endforeach; ?>
      </nav>
      <span class="toolbar__count" aria-live="polite"><?= h($countLabel) ?></span>
    </div>
    <form method="GET" action="/admin/videos.php" class="toolbar" role="search">
      <?php if ($query['f'] !== ''): ?><input type="hidden" name="f" value="<?= h($query['f']) ?>" /><?php endif; ?>
      <div class="toolbar__group">
        <label class="sr-only" for="video-c">Category</label>
        <select id="video-c" name="c">
          <option value="">All categories</option>
          <?php foreach ($categories as $cat): ?>
            <option value="<?= (int) $cat['id'] ?>"<?= $catFilter === (int) $cat['id'] ? ' selected' : '' ?>><?= h($cat['name_en']) ?> (<?= (int) $cat['n'] ?>)</option>
          <?php endforeach; ?>
        </select>
      </div>
      <div class="toolbar__search">
        <?= adminIcon('search') ?>
        <label class="sr-only" for="video-q">Search videos by title or video id</label>
        <input id="video-q" name="q" type="search" placeholder="Search title or video id…" value="<?= h($q) ?>" maxlength="100" autocomplete="off" />
      </div>
      <div class="toolbar__group">
        <button type="submit" class="btn btn--sm">Search</button>
        <?php if ($q !== '' || $catFilter): ?><a href="<?= h($listUrl(['q' => '', 'c' => ''])) ?>" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Clear</a><?php endif; ?>
      </div>
    </form>

    <?php if ($rows): ?>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Video</th>
            <th scope="col">Category</th>
            <th scope="col">Date</th>
            <th scope="col">Status</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($rows as $row): $rid = (int) $row['id']; ?>
          <tr>
            <td class="cell-num"><?= (int) $row['sort_order'] ?></td>
            <td>
              <span class="cell-title" lang="ta"><?= h($row['title_ta']) ?></span>
              <span class="cell-muted"><?= h($row['title_en']) ?></span>
              <span class="cell-muted"><a href="<?= h(liveYoutubeWatchUrl($row['youtube_id'])) ?>" target="_blank" rel="noopener"><?= adminIcon('play') ?> <?= h($row['youtube_id']) ?></a>
                <?php if (!empty($row['stream_slug'])): ?> · <a href="/live-darshan/<?= h($row['stream_slug']) ?>" target="_blank" rel="noopener"><?= adminIcon('tv') ?> broadcast</a><?php endif; ?></span>
            </td>
            <td><?= $row['category_name'] !== null ? h($row['category_name']) : '<span class="cell-muted">—</span>' ?></td>
            <td class="cell-num"><?= $row['published_on'] !== null ? h($row['published_on']) : '<span class="cell-muted">—</span>' ?></td>
            <td>
              <?= $row['is_active'] ? adminBadge('Shown', 'success') : adminBadge('Hidden', 'muted') ?>
              <?= $row['is_featured'] ? adminBadge('Featured', 'warning') : '' ?>
            </td>
            <td class="cell-actions">
              <?= adminMenu([
                  ['label' => 'Edit', 'icon' => 'pencil', 'href' => $listUrl(['edit' => $rid])],
                  ['label' => $row['is_active'] ? 'Hide' : 'Show', 'icon' => $row['is_active'] ? 'eye-off' : 'eye',
                   'form' => ['action' => 'toggle', 'id' => $rid] + $query],
                  ['label' => $row['is_featured'] ? 'Unfeature' : 'Feature', 'icon' => 'star',
                   'form' => ['action' => 'feature', 'id' => $rid] + $query],
                  'divider',
                  ['label' => 'Delete', 'icon' => 'trash', 'danger' => true,
                   'form' => ['action' => 'delete', 'id' => $rid] + $query,
                   'confirm' => 'Delete “' . $row['title_en'] . '”? This cannot be undone.'],
              ], 'Actions for ' . $row['title_en']) ?>
            </td>
          </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>
    <?php elseif ($filtered): ?>
      <?= adminEmpty('search', 'No videos match', 'Try another filter or search.',
          '<a href="/admin/videos.php" class="btn btn--sm">' . adminIcon('x') . ' Clear filters</a>') ?>
    <?php else: ?>
      <?= adminEmpty('play', 'No videos yet', 'Paste a YouTube link, add a Tamil and an English title, and the video appears on the Videos page.',
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' New video</a>') ?>
    <?php endif; ?>

    <section class="card card--solid card--static" id="categories" aria-labelledby="categories-title" style="margin-top:1.5rem">
      <h2 id="categories-title"><?= adminIcon('layers') ?> Categories</h2>
      <p class="field__hint">Visitors filter the Videos page by these. A hidden category hides its videos too; a category with videos cannot be deleted.</p>
      <?php if ($categories): ?>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Category</th>
              <th scope="col">Videos</th>
              <th scope="col">Status</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <?php foreach ($categories as $cat): $cid = (int) $cat['id']; $n = (int) $cat['n']; ?>
            <tr>
              <td class="cell-num"><?= (int) $cat['sort_order'] ?></td>
              <td>
                <form method="POST" action="/admin/videos.php" class="inline-edit" aria-label="Edit category <?= h($cat['name_en']) ?>">
                  <?= csrfField() ?>
                  <input type="hidden" name="action" value="cat_save" />
                  <input type="hidden" name="cat_id" value="<?= $cid ?>" />
                  <?php foreach ($query as $k => $v): ?><input type="hidden" name="<?= h($k) ?>" value="<?= h((string) $v) ?>" /><?php endforeach; ?>
                  <label class="sr-only" for="cat_name_ta_<?= $cid ?>">Tamil name</label>
                  <input id="cat_name_ta_<?= $cid ?>" name="cat_name_ta" type="text" lang="ta" required maxlength="200" value="<?= h($cat['name_ta']) ?>" />
                  <label class="sr-only" for="cat_name_en_<?= $cid ?>">English name</label>
                  <input id="cat_name_en_<?= $cid ?>" name="cat_name_en" type="text" required maxlength="200" value="<?= h($cat['name_en']) ?>" />
                  <label class="sr-only" for="cat_sort_<?= $cid ?>">Order</label>
                  <input id="cat_sort_<?= $cid ?>" name="cat_sort_order" type="number" step="1" min="-999999" max="999999" value="<?= (int) $cat['sort_order'] ?>" style="width:5.5rem" />
                  <button type="submit" class="btn btn--sm"><?= adminIcon('check') ?> Save</button>
                </form>
                <span class="cell-muted">/videos?category=<?= h($cat['slug']) ?></span>
              </td>
              <td class="cell-num"><a href="<?= h($listUrl(['c' => $cid])) ?>"><?= $n ?></a></td>
              <td><?= $cat['is_active'] ? adminBadge('Shown', 'success') : adminBadge('Hidden', 'muted') ?></td>
              <td class="cell-actions">
                <?= adminMenu(array_values(array_filter([
                    ['label' => $cat['is_active'] ? 'Hide' : 'Show', 'icon' => $cat['is_active'] ? 'eye-off' : 'eye',
                     'form' => ['action' => 'cat_toggle', 'cat_id' => $cid] + $query],
                    $n === 0 ? 'divider' : null,
                    $n === 0 ? ['label' => 'Delete', 'icon' => 'trash', 'danger' => true,
                     'form' => ['action' => 'cat_delete', 'cat_id' => $cid] + $query,
                     'confirm' => 'Delete the category “' . $cat['name_en'] . '”?'] : null,
                ])), 'Actions for category ' . $cat['name_en']) ?>
              </td>
            </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      </div>
      <?php endif; ?>
      <form method="POST" action="/admin/videos.php" class="inline-edit" aria-label="New category" style="margin-top:1rem">
        <?= csrfField() ?>
        <input type="hidden" name="action" value="cat_save" />
        <?php foreach ($query as $k => $v): ?><input type="hidden" name="<?= h($k) ?>" value="<?= h((string) $v) ?>" /><?php endforeach; ?>
        <label class="sr-only" for="cat_name_ta">New category, Tamil name</label>
        <input id="cat_name_ta" name="cat_name_ta" type="text" lang="ta" required maxlength="200" placeholder="தமிழ் பெயர்" />
        <label class="sr-only" for="cat_name_en">New category, English name</label>
        <input id="cat_name_en" name="cat_name_en" type="text" required maxlength="200" placeholder="English name" />
        <label class="sr-only" for="cat_sort_order">Order</label>
        <input id="cat_sort_order" name="cat_sort_order" type="number" step="1" min="-999999" max="999999" value="<?= $categories ? (int) max(array_column($categories, 'sort_order')) + 10 : 10 ?>" style="width:5.5rem" />
        <button type="submit" class="btn btn-primary btn--sm"><?= adminIcon('plus') ?> Add category</button>
      </form>
    </section>
  </div>

</div>

<?php adminFooter(); ?>
