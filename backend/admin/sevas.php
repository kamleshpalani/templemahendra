<?php
// backend/admin/sevas.php — Sevas: bookable offerings, prices, order and homepage placement.
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

// ── List filters (GET, whitelisted) ──────────────────────────────────────────
$filters       = ['all' => 'All', 'featured' => 'Featured', 'active' => 'Active', 'hidden' => 'Hidden'];
$defaultFilter = 'all';
$filter        = isset($filters[$str($_GET, 'f')]) ? $str($_GET, 'f') : $defaultFilter;
$q             = mb_substr(trim($str($_GET, 'q')), 0, 100);
$query         = ['f' => $filter === $defaultFilter ? '' : $filter, 'q' => $q];
$listUrl       = static fn(array $override = []): string => '/admin/sevas.php' . rtrim(adminQuery($query, $override), '?');

// ── Create / update / delete ─────────────────────────────────────────────────
$editing = null; // row shown in the form: from ?edit=ID, or the submitted values after a validation error
$errors  = [];   // field => true when server-side validation failed

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $msg    = adminCsrfGuard();
    $action = $str($_POST, 'action');
    $backF  = $str($_POST, 'f');
    $back   = '/admin/sevas.php' . (isset($filters[$backF]) && $backF !== $defaultFilter ? '?f=' . $backF : '');

    if ($msg === '' && $action === 'save') {
        $name_ta  = sanitizeText($str($_POST, 'name_ta'));
        $name_en  = sanitizeText($str($_POST, 'name_en'));
        $desc     = sanitizeText($str($_POST, 'description'), 1000);
        $amount   = filter_var($str($_POST, 'amount'), FILTER_VALIDATE_FLOAT);
        $sort     = (int) $str($_POST, 'sort_order');
        $featured = isset($_POST['is_featured']) ? 1 : 0;
        $active   = isset($_POST['is_active']) ? 1 : 0;
        $id       = (int) $str($_POST, 'id');

        if ($name_ta === '')                   $errors['name_ta'] = true;
        if ($name_en === '')                   $errors['name_en'] = true;
        if ($amount === false || $amount < 0)  $errors['amount']  = true;

        if ($errors) {
            $msg     = '<p class="alert alert--error">Tamil name, English name, and a valid amount are required.</p>';
            $editing = [
                'id' => $id, 'name_ta' => $name_ta, 'name_en' => $name_en, 'description' => $desc,
                'amount' => $str($_POST, 'amount'), 'sort_order' => $sort, 'is_featured' => $featured, 'is_active' => $active,
            ];
        } else {
            if ($id > 0) {
                $db->prepare('UPDATE sevas SET name_ta=:ta,name_en=:en,description=:d,amount=:a,sort_order=:s,is_featured=:f,is_active=:act WHERE id=:id')
                   ->execute([':ta' => $name_ta, ':en' => $name_en, ':d' => $desc, ':a' => $amount, ':s' => $sort, ':f' => $featured, ':act' => $active, ':id' => $id]);
                $_SESSION['flash'] = '<p class="alert alert--success">Updated.</p>';
            } else {
                $db->prepare('INSERT INTO sevas (name_ta,name_en,description,amount,sort_order,is_featured,is_active) VALUES (:ta,:en,:d,:a,:s,:f,:act)')
                   ->execute([':ta' => $name_ta, ':en' => $name_en, ':d' => $desc, ':a' => $amount, ':s' => $sort, ':f' => $featured, ':act' => $active]);
                $_SESSION['flash'] = '<p class="alert alert--success">Created.</p>';
            }
            header('Location: ' . $back, true, 303);
            exit;
        }
    } elseif ($msg === '' && $action === 'delete') {
        $id = (int) $str($_POST, 'id');
        if ($id > 0) {
            $db->prepare('DELETE FROM sevas WHERE id=:id')->execute([':id' => $id]);
            $_SESSION['flash'] = '<p class="alert alert--success">Deleted.</p>';
        }
        header('Location: ' . $back, true, 303);
        exit;
    }
}

// ── Row being edited (?edit=ID) ──────────────────────────────────────────────
if ($editing === null && isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM sevas WHERE id=:id');
    $stmt->execute([':id' => (int) $str($_GET, 'edit')]);
    $editing = $stmt->fetch() ?: null;
    if ($editing === null && $msg === '') {
        $msg = '<p class="alert alert--warning">That seva no longer exists.</p>';
    }
}
$isEdit   = !empty($editing['id']);
$formOpen = $editing !== null;

// ── List ─────────────────────────────────────────────────────────────────────
$cap    = 500;
$where  = [];
$params = [];
switch ($filter) {
    case 'featured': $where[] = 'is_featured = 1'; break;
    case 'active':   $where[] = 'is_active = 1';   break;
    case 'hidden':   $where[] = 'is_active = 0';   break;
}
if ($q !== '') {
    $like    = '%' . addcslashes($q, '%_\\') . '%';
    $where[] = '(name_en LIKE :q1 OR name_ta LIKE :q2 OR description LIKE :q3)';
    $params += [':q1' => $like, ':q2' => $like, ':q3' => $like];
}
$stmt = $db->prepare('SELECT * FROM sevas' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY sort_order ASC LIMIT ' . ($cap + 1));
$stmt->execute($params);
$rows   = $stmt->fetchAll();
$capped = count($rows) > $cap;
if ($capped) $rows = array_slice($rows, 0, $cap);

$c = $db->query('SELECT COUNT(*) AS total,
                        COALESCE(SUM(is_featured = 1), 0) AS featured,
                        COALESCE(SUM(is_active = 1), 0)   AS active,
                        COALESCE(SUM(is_active = 0), 0)   AS hidden
                   FROM sevas')->fetch();
$chipCounts = ['all' => (int) $c['total'], 'featured' => (int) $c['featured'], 'active' => (int) $c['active'], 'hidden' => (int) $c['hidden']];

$shown      = count($rows);
$filtered   = $filter !== $defaultFilter || $q !== '';
$countLabel = $filtered ? "$shown of {$chipCounts['all']} records" : "$shown record" . ($shown === 1 ? '' : 's');
if ($capped) $countLabel .= " · showing the first $cap";

$invalid    = static fn(string $f): string => isset($errors[$f]) ? ' aria-invalid="true" aria-describedby="err-' . $f . '"' : '';
$fieldError = static fn(string $f, string $text): string => isset($errors[$f]) ? '<span class="field__error" id="err-' . $f . '">' . adminIcon('alert-circle') . h($text) . '</span>' : '';

// ── Page ─────────────────────────────────────────────────────────────────────
adminHeader('Sevas', 'Worship', [
    'actions' => '<a href="/sevas" target="_blank" rel="noopener" class="btn btn-ghost btn--sm">' . adminIcon('external') . 'View on site</a>',
]);
echo $msg;
echo adminPageIntro(
    'Sevas are the offerings devotees can book on the public site — set each one’s price and display order, and choose which are featured on the homepage.',
    '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="crud" aria-expanded="false">' . adminIcon('plus') . ' New seva</button>'
    . '<a href="/admin/bulk_upload.php?entity=sevas" class="btn btn--sm">' . adminIcon('upload') . ' Import CSV / Excel</a>'
);
?>

<div class="admin-two-col admin-two-col--collapsible" id="crud" data-editing="<?= $formOpen ? '1' : '0' ?>">

  <section class="card card--solid card--static admin-form-box" id="new" aria-labelledby="form-title">
    <h2 id="form-title"><?= adminIcon($isEdit ? 'pencil' : 'plus') ?> <?= $isEdit ? 'Edit seva' : 'New seva' ?></h2>
    <form method="POST" action="/admin/sevas.php">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save" />
      <input type="hidden" name="f" value="<?= h($filter) ?>" />
      <?php if ($isEdit): ?><input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" /><?php endif; ?>

      <label for="name_en">
        <span class="field__label">English name <span class="field__required" aria-hidden="true">*</span></span>
        <input id="name_en" name="name_en" type="text" required aria-required="true" maxlength="200" autocomplete="off"
               placeholder="e.g. Abhishekam" value="<?= h($editing['name_en'] ?? '') ?>"<?= $invalid('name_en') ?> />
        <?= $fieldError('name_en', 'English name is required.') ?>
      </label>

      <label for="name_ta">
        <span class="field__label">Tamil name <span class="field__required" aria-hidden="true">*</span></span>
        <input id="name_ta" name="name_ta" type="text" lang="ta" required aria-required="true" maxlength="200" autocomplete="off"
               placeholder="எ.கா. அபிஷேகம்" value="<?= h($editing['name_ta'] ?? '') ?>"<?= $invalid('name_ta') ?> />
        <?= $fieldError('name_ta', 'Tamil name is required.') ?>
      </label>

      <label for="description">
        <span class="field__label">Description <span class="field__optional">optional</span></span>
        <textarea id="description" name="description" rows="3" maxlength="1000" data-counter><?= h($editing['description'] ?? '') ?></textarea>
        <span class="field__hint">Shown under the seva name on the booking page.</span>
      </label>

      <div class="form-grid">
        <label for="amount">
          <span class="field__label">Amount (₹) <span class="field__required" aria-hidden="true">*</span></span>
          <input id="amount" name="amount" type="number" inputmode="decimal" required aria-required="true" min="0" step="0.01"
                 placeholder="0.00" value="<?= h((string) ($editing['amount'] ?? '')) ?>"<?= $invalid('amount') ?> />
          <?= $fieldError('amount', 'Enter a valid amount of 0 or more.') ?>
        </label>
        <label for="sort_order">
          <span class="field__label">Sort order</span>
          <input id="sort_order" name="sort_order" type="number" inputmode="numeric" step="1"
                 value="<?= h((string) ($editing['sort_order'] ?? '0')) ?>" />
          <span class="field__hint">Lower shows first.</span>
        </label>
      </div>

      <label class="switch">
        <input type="checkbox" name="is_featured" value="1"<?= (!$editing || !empty($editing['is_featured'])) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Featured on homepage</strong><span class="switch__desc">Appears in the Sevas section of the homepage.</span></span>
      </label>

      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= (!$editing || !empty($editing['is_active'])) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Active</strong><span class="switch__desc">Visible and bookable on the public site. Hidden sevas stay saved.</span></span>
      </label>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> <?= $isEdit ? 'Save changes' : 'Save seva' ?></button>
        <?php if ($formOpen): ?><a href="<?= h($listUrl()) ?>" class="btn btn-ghost">Cancel</a><?php endif; ?>
      </div>
    </form>
  </section>

  <div class="admin-list">
    <form method="GET" action="/admin/sevas.php" class="toolbar" role="search">
      <?php if ($filter !== $defaultFilter): ?><input type="hidden" name="f" value="<?= h($filter) ?>" /><?php endif; ?>
      <div class="toolbar__search">
        <?= adminIcon('search') ?>
        <label for="q" class="sr-only">Search sevas</label>
        <input id="q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search by name or description…" autocomplete="off" />
        <button type="submit" class="sr-only">Search</button>
      </div>
      <nav class="filter-chips" aria-label="Filter sevas">
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
            <th scope="col">Seva</th>
            <th scope="col" class="num">Amount</th>
            <th scope="col" class="num">Order</th>
            <th scope="col">Status</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($rows as $row): $rid = (int) $row['id']; ?>
          <tr>
            <td>
              <span class="cell-title"><?= h($row['name_en']) ?></span>
              <span class="cell-sub" lang="ta"><?= h($row['name_ta']) ?></span>
            </td>
            <td class="num cell-money"><?= adminFmtMoney((float) $row['amount'], 2) ?></td>
            <td class="num tabular"><?= (int) $row['sort_order'] ?></td>
            <td>
              <span class="cluster">
                <?php if ($row['is_featured']) echo adminBadge('Featured', 'gold'); ?>
                <?= $row['is_active'] ? adminBadge('Active', 'success') : adminBadge('Hidden', 'muted') ?>
              </span>
            </td>
            <td class="cell-actions">
              <?= adminMenu([
                  ['label' => 'Edit', 'icon' => 'pencil', 'href' => $listUrl(['edit' => $rid])],
                  'divider',
                  ['label' => 'Delete', 'icon' => 'trash', 'danger' => true,
                   'form' => ['action' => 'delete', 'id' => $rid, 'f' => $filter],
                   'confirm' => 'Delete “' . $row['name_en'] . '”? This cannot be undone.'],
              ], 'Actions for ' . $row['name_en']) ?>
            </td>
          </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>
    <?php if ($capped): ?>
      <p class="field__hint mt-2">Only the first <?= $cap ?> sevas are listed. Use search or a filter to narrow the list.</p>
    <?php endif; ?>
    <?php elseif ($filtered): ?>
      <?= adminEmpty('search', 'No sevas match', 'Try a different search term or filter.',
          '<a href="/admin/sevas.php" class="btn btn--sm">' . adminIcon('x') . ' Clear filters</a>') ?>
    <?php else: ?>
      <?= adminEmpty('sparkles', 'No sevas yet', 'Add the first seva devotees can book, or import a list from a spreadsheet.',
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' New seva</a>'
          . '<a href="/admin/bulk_upload.php?entity=sevas" class="btn btn--sm">' . adminIcon('upload') . ' Import CSV / Excel</a>') ?>
    <?php endif; ?>
  </div>

</div>

<?php adminFooter(); ?>
