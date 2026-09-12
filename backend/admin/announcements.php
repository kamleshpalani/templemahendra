<?php
// backend/admin/announcements.php — Announcements: short notices for the homepage ticker.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

/** String value from a request array ('' when missing or not scalar). */
$str = static fn(array $src, string $key): string => is_scalar($src[$key] ?? null) ? (string) $src[$key] : '';

// ── Flash left by the previous request (POST → 303 → GET) ────────────────────
$msg = '';
if (!empty($_SESSION['flash'])) {
    $msg = (string) $_SESSION['flash'];
    unset($_SESSION['flash']);
}

// ── List filters (whitelisted; read from the request that carried them) ──────
$filters       = ['active' => 'Active', 'hidden' => 'Hidden', 'all' => 'All'];
$defaultFilter = 'all';
$src           = $_SERVER['REQUEST_METHOD'] === 'POST' ? $_POST : $_GET; // a failed save must keep the list state
$filter        = isset($filters[$str($src, 'f')]) ? $str($src, 'f') : $defaultFilter;
$q             = mb_substr(trim($str($src, 'q')), 0, 100);
$query         = ['f' => $filter === $defaultFilter ? '' : $filter, 'q' => $q];
$listUrl       = static fn(array $override = []): string => '/admin/announcements.php' . rtrim(adminQuery($query, $override), '?');

// ── Create / update / delete ─────────────────────────────────────────────────
$editing = null; // row shown in the form: from ?edit=ID, or the submitted values after a validation error
$errors  = [];   // field => true when server-side validation failed

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $msg    = adminCsrfGuard();
    $action = $str($_POST, 'action');
    $backF  = $str($_POST, 'f');
    $back   = '/admin/announcements.php' . (isset($filters[$backF]) && $backF !== $defaultFilter ? '?f=' . $backF : '');

    // A rejected token must not cost the admin their typing — reflect it back (inert: every value is h()-escaped).
    if ($msg !== '' && $action === 'save') {
        $editing = [
            'id'        => (int) $str($_POST, 'id'),
            'title'     => $str($_POST, 'title'),
            'body'      => $str($_POST, 'body'),
            'is_active' => isset($_POST['is_active']) ? 1 : 0,
        ];
    }

    if ($msg === '' && $action === 'save') {
        // Length is clamped to the column definition so nothing reaches MySQL out of bounds.
        $title     = sanitizeText($str($_POST, 'title'), 300); // VARCHAR(300)
        $body      = sanitizeText($str($_POST, 'body'), 2000);
        $is_active = isset($_POST['is_active']) ? 1 : 0;
        $id        = (int) $str($_POST, 'id');

        if ($title === '') $errors['title'] = true;

        if ($errors) {
            $msg     = '<p class="alert alert--error">Title is required.</p>';
            $editing = ['id' => $id, 'title' => $title, 'body' => $body, 'is_active' => $is_active];
        } else {
            if ($id > 0) {
                $db->prepare('UPDATE announcements SET title=:t, body=:b, is_active=:a WHERE id=:id')
                   ->execute([':t' => $title, ':b' => $body, ':a' => $is_active, ':id' => $id]);
                $_SESSION['flash'] = '<p class="alert alert--success">Updated.</p>';
            } else {
                $db->prepare('INSERT INTO announcements (title, body, is_active, created_at) VALUES (:t,:b,:a,CURRENT_TIMESTAMP)')
                   ->execute([':t' => $title, ':b' => $body, ':a' => $is_active]);
                $_SESSION['flash'] = '<p class="alert alert--success">Created.</p>';
            }
            header('Location: ' . $back, true, 303);
            exit;
        }
    } elseif ($msg === '' && $action === 'delete') {
        $id = (int) $str($_POST, 'id');
        if ($id > 0) {
            $db->prepare('DELETE FROM announcements WHERE id=:id')->execute([':id' => $id]);
            $_SESSION['flash'] = '<p class="alert alert--success">Deleted.</p>';
        }
        header('Location: ' . $back, true, 303);
        exit;
    }
}

// ── Row being edited (?edit=ID) ──────────────────────────────────────────────
if ($editing === null && isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM announcements WHERE id=:id');
    $stmt->execute([':id' => (int) $str($_GET, 'edit')]);
    $editing = $stmt->fetch() ?: null;
    if ($editing === null && $msg === '') {
        $msg = '<p class="alert alert--warning">That announcement no longer exists.</p>';
    }
}
$isEdit   = !empty($editing['id']);
$formOpen = $editing !== null;

// ── List ─────────────────────────────────────────────────────────────────────
$cap    = 500;
$where  = [];
$params = [];
switch ($filter) {
    case 'active': $where[] = 'is_active = 1'; break;
    case 'hidden': $where[] = 'is_active = 0'; break;
}
if ($q !== '') {
    $like    = '%' . addcslashes($q, '%_\\') . '%';
    $where[] = '(title LIKE :q1 OR body LIKE :q2)';
    $params += [':q1' => $like, ':q2' => $like];
}
$stmt = $db->prepare('SELECT * FROM announcements' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY created_at DESC LIMIT ' . ($cap + 1));
$stmt->execute($params);
$rows   = $stmt->fetchAll();
$capped = count($rows) > $cap;
if ($capped) $rows = array_slice($rows, 0, $cap);

$c = $db->query('SELECT COUNT(*) AS total,
                        COALESCE(SUM(is_active = 1), 0) AS active,
                        COALESCE(SUM(is_active = 0), 0) AS hidden
                   FROM announcements')->fetch();
$chipCounts = ['active' => (int) $c['active'], 'hidden' => (int) $c['hidden'], 'all' => (int) $c['total']];

$shown      = count($rows);
$filtered   = $filter !== $defaultFilter || $q !== '';
$countLabel = $filtered ? "$shown of {$chipCounts['all']} records" : "$shown record" . ($shown === 1 ? '' : 's');
if ($capped) $countLabel .= " · showing the first $cap";

$invalid    = static fn(string $f): string => isset($errors[$f]) ? ' aria-invalid="true" aria-describedby="err-' . $f . '"' : '';
$fieldError = static fn(string $f, string $text): string => isset($errors[$f]) ? '<span class="field__error" id="err-' . $f . '">' . adminIcon('alert-circle') . h($text) . '</span>' : '';

// ── Page ─────────────────────────────────────────────────────────────────────
adminHeader('Announcements', 'Content', [
    'actions' => '<a href="/" target="_blank" rel="noopener" class="btn btn-ghost btn--sm">' . adminIcon('external') . 'View on site</a>',
]);
echo $msg;
echo adminPageIntro(
    'Short notices that scroll in the homepage ticker — newest first. Hidden announcements stay saved but are not shown to visitors.',
    '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="crud" aria-expanded="false">' . adminIcon('plus') . ' New announcement</button>'
);
?>

<div class="admin-two-col admin-two-col--collapsible" id="crud" data-editing="<?= $formOpen ? '1' : '0' ?>">

  <section class="card card--solid card--static admin-form-box" id="new" aria-labelledby="form-title">
    <h2 id="form-title"><?= adminIcon($isEdit ? 'pencil' : 'megaphone') ?> <?= $isEdit ? 'Edit announcement' : 'New announcement' ?></h2>
    <form method="POST" action="/admin/announcements.php">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save" />
      <input type="hidden" name="f" value="<?= h($filter) ?>" />
      <input type="hidden" name="q" value="<?= h($q) ?>" />
      <?php if ($isEdit): ?><input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" /><?php endif; ?>

      <label for="title">
        <span class="field__label">Title <span class="field__required" aria-hidden="true">*</span></span>
        <input id="title" name="title" type="text" required aria-required="true" maxlength="300" autocomplete="off"
               placeholder="e.g. Kumbabhishekam preparations begin" value="<?= h($editing['title'] ?? '') ?>"<?= $invalid('title') ?> />
        <?= $fieldError('title', 'Title is required.') ?>
        <span class="field__hint">This is the line that scrolls in the ticker — keep it short.</span>
      </label>

      <label for="body">
        <span class="field__label">Body <span class="field__optional">optional</span></span>
        <textarea id="body" name="body" rows="4" maxlength="2000" data-counter><?= h($editing['body'] ?? '') ?></textarea>
        <span class="field__hint">Extra detail shown when a visitor opens the announcement.</span>
      </label>

      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= (!$editing || !empty($editing['is_active'])) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Active</strong><span class="switch__desc">Shown in the homepage ticker. Hidden announcements stay saved.</span></span>
      </label>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> <?= $isEdit ? 'Save changes' : 'Publish announcement' ?></button>
        <?php if ($formOpen): ?><a href="<?= h($listUrl()) ?>" class="btn btn-ghost">Cancel</a><?php endif; ?>
      </div>
    </form>
  </section>

  <div class="admin-list">
    <form method="GET" action="/admin/announcements.php" class="toolbar" role="search">
      <?php if ($filter !== $defaultFilter): ?><input type="hidden" name="f" value="<?= h($filter) ?>" /><?php endif; ?>
      <div class="toolbar__search">
        <?= adminIcon('search') ?>
        <label for="q" class="sr-only">Search announcements</label>
        <input id="q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search by title or body…" autocomplete="off" />
        <button type="submit" class="sr-only">Search</button>
      </div>
      <nav class="filter-chips" aria-label="Filter announcements">
        <?php foreach ($filters as $key => $label): ?>
          <a class="chip" href="<?= h($listUrl(['f' => $key === $defaultFilter ? '' : $key])) ?>"<?= $key === $filter ? ' aria-current="page"' : '' ?>>
            <?= h($label) ?> <span class="chip__count"><?= $chipCounts[$key] ?></span>
          </a>
        <?php endforeach; ?>
      </nav>
      <?php if ($q !== ''): ?>
        <a href="<?= h($listUrl(['q' => ''])) ?>" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Clear search</a>
      <?php endif; ?>
      <span class="toolbar__count" aria-live="polite"><?= h($countLabel) ?></span>
    </form>

    <?php if ($rows): ?>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Announcement</th>
            <th scope="col">Body</th>
            <th scope="col">Status</th>
            <th scope="col">Created</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($rows as $row): $rid = (int) $row['id']; ?>
          <tr>
            <td><span class="cell-title"><?= h($row['title']) ?></span></td>
            <td><?= $row['body'] !== null && $row['body'] !== '' ? '<span class="cell-clip">' . h($row['body']) . '</span>' : '<span class="cell-muted">—</span>' ?></td>
            <td><?= $row['is_active'] ? adminBadge('Active', 'success') : adminBadge('Hidden', 'muted') ?></td>
            <td class="cell-date"><time datetime="<?= h($row['created_at']) ?>"><?= adminFmtDate($row['created_at'], true) ?></time></td>
            <td class="cell-actions">
              <?= adminMenu([
                  ['label' => 'Edit', 'icon' => 'pencil', 'href' => $listUrl(['edit' => $rid])],
                  'divider',
                  ['label' => 'Delete', 'icon' => 'trash', 'danger' => true,
                   'form' => ['action' => 'delete', 'id' => $rid, 'f' => $filter],
                   'confirm' => 'Delete “' . $row['title'] . '”? This cannot be undone.'],
              ], 'Actions for ' . $row['title']) ?>
            </td>
          </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>
    <?php if ($capped): ?>
      <p class="field__hint mt-2">Only the first <?= $cap ?> announcements are listed. Use search or a filter to narrow the list.</p>
    <?php endif; ?>
    <?php elseif ($filtered): ?>
      <?= adminEmpty('search', 'No announcements match', 'Try a different search term or filter.',
          '<a href="/admin/announcements.php" class="btn btn--sm">' . adminIcon('x') . ' Clear filters</a>') ?>
    <?php else: ?>
      <?= adminEmpty('megaphone', 'No announcements yet', 'Post a notice and it will start scrolling in the homepage ticker straight away.',
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' New announcement</a>') ?>
    <?php endif; ?>
  </div>

</div>

<?php adminFooter(); ?>
