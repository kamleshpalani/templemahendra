<?php
// backend/admin/sevas.php — Sevas: bookable offerings, prices, order and homepage placement.
//
// Since migration 020 a seva's description and its timing ("Daily 7–9 am")
// are written in Tamil and in English (brief §6, §7), and a seva can be
// listed without being bookable online (is_bookable = 0: the public card
// shows the price and says to ask at the office). The old single-language
// `description` column is kept in step (English, or Tamil when there is no
// English) so pages that still read it keep working for a release; a request
// that only sends the old `description` field is accepted and the one text
// becomes both languages. A request that does not mention is_bookable at all
// (an older client, a bulk import) leaves the seva bookable.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_guard.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

if (!publicGuardHasColumn('sevas', 'is_bookable') || !publicGuardHasColumn('sevas', 'description_ta')) {
    adminHeader('Sevas', 'Worship');
    echo '<p class="alert alert--warning" role="alert">Bilingual sevas are not installed on this site yet: apply database migration <code>020_bilingual_content_events.sql</code> and reload.</p>';
    adminFooter();
    exit;
}

/** String value from a request array ('' when missing or not scalar). */
$str = static fn(array $src, string $key): string => is_scalar($src[$key] ?? null) ? (string) $src[$key] : '';

/** The submitted form, as typed, for showing it again (every value is h()-escaped on output). */
$fromPost = static function () use ($str): array {
    $legacyDesc = $str($_POST, 'description');
    return [
        'id'             => (int) $str($_POST, 'id'),
        'name_ta'        => $str($_POST, 'name_ta'),
        'name_en'        => $str($_POST, 'name_en'),
        'description_ta' => $str($_POST, 'description_ta') !== '' ? $str($_POST, 'description_ta') : $legacyDesc,
        'description_en' => $str($_POST, 'description_en') !== '' ? $str($_POST, 'description_en') : $legacyDesc,
        'timing_ta'      => $str($_POST, 'timing_ta'),
        'timing_en'      => $str($_POST, 'timing_en'),
        'amount'         => $str($_POST, 'amount'),
        'sort_order'     => (int) $str($_POST, 'sort_order'),
        'is_featured'    => isset($_POST['is_featured']) ? 1 : 0,
        // Hidden "0" + checkbox "1": only an explicit 0 makes a seva unbookable.
        'is_bookable'    => $str($_POST, 'is_bookable') === '0' ? 0 : 1,
        'is_active'      => isset($_POST['is_active']) ? 1 : 0,
    ];
};

// ── Flash left by the previous request (POST → 303 → GET) ────────────────────
$msg = '';
if (!empty($_SESSION['flash'])) {
    $msg = (string) $_SESSION['flash'];
    unset($_SESSION['flash']);
}

// ── List filters (whitelisted; read from the request that carried them) ──────
$filters       = ['all' => 'All', 'featured' => 'Featured', 'active' => 'Active', 'hidden' => 'Hidden', 'unbookable' => 'Not bookable'];
$defaultFilter = 'all';
$src           = $_SERVER['REQUEST_METHOD'] === 'POST' ? $_POST : $_GET; // a failed save must keep the list state
$filter        = isset($filters[$str($src, 'f')]) ? $str($src, 'f') : $defaultFilter;
$q             = mb_substr(trim($str($src, 'q')), 0, 100);
$query         = ['f' => $filter === $defaultFilter ? '' : $filter, 'q' => $q];
$listUrl       = static fn(array $override = []): string => '/admin/sevas.php' . rtrim(adminQuery($query, $override), '?');

// ── Create / update / toggle / delete ────────────────────────────────────────
$editing = null; // row shown in the form: from ?edit=ID, or the submitted values after a validation error
$errors  = [];   // field => true when server-side validation failed

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $msg    = adminCsrfGuard();
    $action = $str($_POST, 'action');
    $backF  = $str($_POST, 'f');
    $back   = '/admin/sevas.php' . (isset($filters[$backF]) && $backF !== $defaultFilter ? '?f=' . $backF : '');

    // A rejected token must not cost the admin their typing — reflect it back (inert: every value is h()-escaped).
    if ($msg !== '' && $action === 'save') $editing = $fromPost();

    if ($msg === '' && $action === 'save') {
        $in = $fromPost();
        // Lengths and ranges are clamped to the column definitions so nothing reaches MySQL out of bounds.
        $name_ta   = sanitizeText($in['name_ta'], 200);   // VARCHAR(200)
        $name_en   = sanitizeText($in['name_en'], 200);   // VARCHAR(200)
        $desc_ta   = sanitizeText($in['description_ta'], 1000);
        $desc_en   = sanitizeText($in['description_en'], 1000);
        $timing_ta = sanitizeText($in['timing_ta'], 200); // VARCHAR(200)
        $timing_en = sanitizeText($in['timing_en'], 200); // VARCHAR(200)
        $amount    = filter_var($in['amount'], FILTER_VALIDATE_FLOAT);
        $sort      = max(-2147483648, min(2147483647, $in['sort_order'])); // INT
        $featured  = $in['is_featured'];
        $bookable  = $in['is_bookable'];
        $active    = $in['is_active'];
        $id        = $in['id'];

        if ($name_ta === '')                   $errors['name_ta'] = true;
        if ($name_en === '')                   $errors['name_en'] = true;
        // DECIMAL(10,2) → 0 … 99,999,999.99
        if ($amount === false || $amount < 0 || $amount > 99999999.99) $errors['amount'] = true;

        if ($errors) {
            $msg     = '<p class="alert alert--error">Tamil name, English name, and a valid amount are required.</p>';
            $editing = $in;
        } else {
            $params = [
                ':ta' => $name_ta, ':en' => $name_en,
                ':dta' => $desc_ta !== '' ? $desc_ta : null, ':den' => $desc_en !== '' ? $desc_en : null,
                ':d'   => $desc_en !== '' ? $desc_en : ($desc_ta !== '' ? $desc_ta : null), // legacy column: English, else Tamil
                ':tta' => $timing_ta !== '' ? $timing_ta : null, ':ten' => $timing_en !== '' ? $timing_en : null,
                ':a' => $amount, ':s' => $sort, ':f' => $featured, ':bk' => $bookable, ':act' => $active,
            ];
            if ($id > 0) {
                $params[':id'] = $id;
                $db->prepare('UPDATE sevas SET name_ta=:ta, name_en=:en, description=:d, description_ta=:dta, description_en=:den,
                                 timing_ta=:tta, timing_en=:ten, amount=:a, sort_order=:s, is_featured=:f, is_bookable=:bk, is_active=:act WHERE id=:id')->execute($params);
                adminAudit('seva_updated', 'seva:' . $id, $name_en . ' · ₹' . $amount);
                $_SESSION['flash'] = '<p class="alert alert--success">Updated.</p>';
            } else {
                $db->prepare('INSERT INTO sevas (name_ta, name_en, description, description_ta, description_en, timing_ta, timing_en, amount, sort_order, is_featured, is_bookable, is_active)
                              VALUES (:ta, :en, :d, :dta, :den, :tta, :ten, :a, :s, :f, :bk, :act)')->execute($params);
                adminAudit('seva_created', 'seva:' . (int) $db->lastInsertId(), $name_en . ' · ₹' . $amount);
                $_SESSION['flash'] = '<p class="alert alert--success">Created.</p>';
            }
            header('Location: ' . $back, true, 303);
            exit;
        }
    } elseif ($msg === '' && in_array($action, ['toggle', 'feature', 'bookable'], true)) {
        $id   = (int) $str($_POST, 'id');
        $col  = ['toggle' => 'is_active', 'feature' => 'is_featured', 'bookable' => 'is_bookable'][$action];
        $stmt = $db->prepare("UPDATE sevas SET $col = 1 - $col WHERE id = :id");
        $stmt->execute([':id' => $id]);
        if ($stmt->rowCount()) {
            adminAudit(['toggle' => 'seva_toggled', 'feature' => 'seva_featured', 'bookable' => 'seva_bookable_toggled'][$action], 'seva:' . $id);
            $_SESSION['flash'] = '<p class="alert alert--success">' . ['toggle' => 'Visibility changed.', 'feature' => 'Featured changed.', 'bookable' => 'Booking changed.'][$action] . '</p>';
        }
        header('Location: ' . $back, true, 303);
        exit;
    } elseif ($msg === '' && $action === 'delete') {
        $id = (int) $str($_POST, 'id');
        if ($id > 0) {
            $gone = $db->prepare('SELECT name_en FROM sevas WHERE id=:id');
            $gone->execute([':id' => $id]);
            $goneName = $gone->fetchColumn();
            $db->prepare('DELETE FROM sevas WHERE id=:id')->execute([':id' => $id]);
            if ($goneName !== false) adminAudit('seva_deleted', 'seva:' . $id, (string) $goneName);
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
    case 'featured':   $where[] = 'is_featured = 1'; break;
    case 'active':     $where[] = 'is_active = 1';   break;
    case 'hidden':     $where[] = 'is_active = 0';   break;
    case 'unbookable': $where[] = 'is_bookable = 0'; break;
}
if ($q !== '') {
    $like    = '%' . addcslashes($q, '%_\\') . '%';
    $where[] = '(name_en LIKE :q1 OR name_ta LIKE :q2 OR description_ta LIKE :q3 OR description_en LIKE :q4 OR description LIKE :q5)';
    $params += [':q1' => $like, ':q2' => $like, ':q3' => $like, ':q4' => $like, ':q5' => $like];
}
$stmt = $db->prepare('SELECT * FROM sevas' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY sort_order ASC, id ASC LIMIT ' . ($cap + 1));
$stmt->execute($params);
$rows   = $stmt->fetchAll();
$capped = count($rows) > $cap;
if ($capped) $rows = array_slice($rows, 0, $cap);

$c = $db->query('SELECT COUNT(*) AS total,
                        COALESCE(SUM(is_featured = 1), 0) AS featured,
                        COALESCE(SUM(is_active = 1), 0)   AS active,
                        COALESCE(SUM(is_active = 0), 0)   AS hidden,
                        COALESCE(SUM(is_bookable = 0), 0) AS unbookable
                   FROM sevas')->fetch();
$chipCounts = ['all' => (int) $c['total'], 'featured' => (int) $c['featured'], 'active' => (int) $c['active'], 'hidden' => (int) $c['hidden'], 'unbookable' => (int) $c['unbookable']];

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
    'Sevas are the offerings devotees can book on the public site — describe each one in Tamil and English, set its price, timing and display order, choose which are featured on the homepage, and mark any that can only be arranged at the office.',
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
      <input type="hidden" name="q" value="<?= h($q) ?>" />
      <?php if ($isEdit): ?><input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" /><?php endif; ?>

      <label for="name_ta">
        <span class="field__label">Name (Tamil) <span class="field__required" aria-hidden="true">*</span></span>
        <input id="name_ta" name="name_ta" type="text" lang="ta" required aria-required="true" maxlength="200" autocomplete="off"
               placeholder="எ.கா. அபிஷேகம்" value="<?= h($editing['name_ta'] ?? '') ?>"<?= $invalid('name_ta') ?> />
        <?= $fieldError('name_ta', 'Tamil name is required.') ?>
      </label>

      <label for="name_en">
        <span class="field__label">Name (English) <span class="field__required" aria-hidden="true">*</span></span>
        <input id="name_en" name="name_en" type="text" required aria-required="true" maxlength="200" autocomplete="off"
               placeholder="e.g. Abhishekam" value="<?= h($editing['name_en'] ?? '') ?>"<?= $invalid('name_en') ?> />
        <?= $fieldError('name_en', 'English name is required.') ?>
      </label>

      <label for="description_ta">
        <span class="field__label">Description (Tamil) <span class="field__optional">optional</span></span>
        <textarea id="description_ta" name="description_ta" rows="3" lang="ta" maxlength="1000" data-counter><?= h($editing['description_ta'] ?? '') ?></textarea>
        <span class="field__hint">Shown under the seva name on the booking page.</span>
      </label>

      <label for="description_en">
        <span class="field__label">Description (English) <span class="field__optional">optional</span></span>
        <textarea id="description_en" name="description_en" rows="3" maxlength="1000" data-counter><?= h($editing['description_en'] ?? '') ?></textarea>
      </label>

      <div class="form-grid">
        <label for="timing_ta">
          <span class="field__label">Timing (Tamil) <span class="field__optional">optional</span></span>
          <input id="timing_ta" name="timing_ta" type="text" lang="ta" maxlength="200" autocomplete="off"
                 placeholder="எ.கா. தினமும் காலை 7–9" value="<?= h($editing['timing_ta'] ?? '') ?>" />
        </label>
        <label for="timing_en">
          <span class="field__label">Timing (English) <span class="field__optional">optional</span></span>
          <input id="timing_en" name="timing_en" type="text" maxlength="200" autocomplete="off"
                 placeholder="e.g. Daily 7–9 am" value="<?= h($editing['timing_en'] ?? '') ?>" />
          <span class="field__hint">When the seva is performed.</span>
        </label>
      </div>

      <div class="form-grid">
        <label for="amount">
          <span class="field__label">Amount (₹) <span class="field__required" aria-hidden="true">*</span></span>
          <input id="amount" name="amount" type="number" inputmode="decimal" required aria-required="true" min="0" max="99999999.99" step="0.01"
                 placeholder="0.00" value="<?= h((string) ($editing['amount'] ?? '')) ?>"<?= $invalid('amount') ?> />
          <?= $fieldError('amount', 'Enter an amount between 0 and 99,999,999.99.') ?>
          <span class="field__hint">Between 0 and 99,999,999.99.</span>
        </label>
        <label for="sort_order">
          <span class="field__label">Sort order</span>
          <input id="sort_order" name="sort_order" type="number" inputmode="numeric" step="1" min="-2147483648" max="2147483647"
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
        <input type="hidden" name="is_bookable" value="0" />
        <input type="checkbox" name="is_bookable" value="1"<?= (!$editing || !isset($editing['is_bookable']) || !empty($editing['is_bookable'])) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Bookable online</strong><span class="switch__desc">Devotees can send a booking request from the website. Switched off, the seva is still listed with its price and visitors are asked to contact the office.</span></span>
      </label>

      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= (!$editing || !empty($editing['is_active'])) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Active</strong><span class="switch__desc">Visible on the public site. Hidden sevas stay saved.</span></span>
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
            <th scope="col">Timing</th>
            <th scope="col" class="num">Amount</th>
            <th scope="col" class="num">Order</th>
            <th scope="col">Status</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($rows as $row): $rid = (int) $row['id']; $timing = $row['timing_en'] ?? $row['timing_ta']; ?>
          <tr>
            <td>
              <span class="cell-title" lang="ta"><?= h($row['name_ta']) ?></span>
              <span class="cell-sub"><?= h($row['name_en']) ?></span>
            </td>
            <td><?= $timing !== null && $timing !== '' ? h($timing) : '<span class="cell-muted">—</span>' ?></td>
            <td class="num cell-money"><?= adminFmtMoney((float) $row['amount'], 2) ?></td>
            <td class="num tabular"><?= (int) $row['sort_order'] ?></td>
            <td>
              <span class="cluster">
                <?php if ($row['is_featured']) echo adminBadge('Featured', 'gold'); ?>
                <?php if (!$row['is_bookable']) echo adminBadge('Not bookable', 'warning'); ?>
                <?= $row['is_active'] ? adminBadge('Active', 'success') : adminBadge('Hidden', 'muted') ?>
              </span>
            </td>
            <td class="cell-actions">
              <?= adminMenu([
                  ['label' => 'Edit', 'icon' => 'pencil', 'href' => $listUrl(['edit' => $rid])],
                  ['label' => $row['is_active'] ? 'Hide' : 'Show', 'icon' => $row['is_active'] ? 'eye-off' : 'eye',
                   'form' => ['action' => 'toggle', 'id' => $rid, 'f' => $filter]],
                  ['label' => $row['is_featured'] ? 'Unfeature' : 'Feature', 'icon' => 'star',
                   'form' => ['action' => 'feature', 'id' => $rid, 'f' => $filter]],
                  ['label' => $row['is_bookable'] ? 'Stop online booking' : 'Allow online booking', 'icon' => 'toggle',
                   'form' => ['action' => 'bookable', 'id' => $rid, 'f' => $filter]],
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
