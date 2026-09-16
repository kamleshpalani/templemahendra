<?php
// backend/admin/donation_categories.php — Donation Categories
// (docs/payments/SPEC.md §10.5): the purposes a devotee can choose on /donate.
//
// A category's slug is what `donations.purpose` stores, which is why it can be
// set only once: changing it afterwards would orphan every donation already
// labelled with it. A category that has been used is never deleted — it is
// hidden instead, so old donations keep their name in reports and receipts.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/payments.php';
require_once __DIR__ . '/includes/admin_layout.php';

const DC_BASE = '/admin/donation_categories.php';
/** DECIMAL(12,2) holds far more, but a suggested donation above ₹99,99,99,999.99 is a typo. */
const DC_MAX_SUGGESTED = 999999999.99;

$db     = getDB();
$tables = payTablesExist();

/** String value from a request array ('' when missing or not scalar). */
$str = static fn(array $src, string $key): string => is_scalar($src[$key] ?? null) ? trim((string) $src[$key]) : '';

// ── Flash left by the previous request (POST → 303 → GET) ────────────────────
$msg = '';
if (!empty($_SESSION['flash_donation_categories'])) {
    [$fType, $fText] = $_SESSION['flash_donation_categories'];
    unset($_SESSION['flash_donation_categories']);
    $tone = in_array($fType, ['success', 'warning', 'error'], true) ? $fType : 'success';
    $msg  = '<p class="alert alert--' . $tone . '" role="' . ($tone === 'success' ? 'status' : 'alert') . '">' . h($fText) . '</p>';
}
function dcFlash(string $type, string $text): void
{
    $_SESSION['flash_donation_categories'] = [$type, $text];
}

/** How many donations (pledges and online) each category labels, by id. */
function dcUsage(PDO $db): array
{
    $out = [];
    try {
        $rows = $db->query(
            'SELECT c.id, COUNT(d.id) AS uses
               FROM donation_categories c
               LEFT JOIN donations d ON d.category_id = c.id OR d.purpose = c.slug
              GROUP BY c.id'
        )->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as $r) $out[(int) $r['id']] = (int) $r['uses'];
    } catch (Throwable $e) {
        error_log('[payments] donation category usage counts failed: ' . $e->getMessage());
    }
    return $out;
}

// ── List filters (whitelisted; read from the request that carried them) ──────
$filters       = ['all' => 'All', 'active' => 'Active', 'hidden' => 'Hidden'];
$defaultFilter = 'all';
$src           = $_SERVER['REQUEST_METHOD'] === 'POST' ? $_POST : $_GET;
$filter        = isset($filters[$str($src, 'f')]) ? $str($src, 'f') : $defaultFilter;
$q             = mb_substr($str($src, 'q'), 0, 100);
$query         = ['f' => $filter === $defaultFilter ? '' : $filter, 'q' => $q];
$listUrl       = static fn(array $override = []): string => DC_BASE . rtrim(adminQuery($query, $override), '?');

$editing = null; // the row shown in the form: from ?edit=ID, or the submitted values after an error
$errors  = [];

// ── Create / update / delete / hide ──────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $guard  = adminCsrfGuard();
    $action = $str($_POST, 'action');
    $back   = $listUrl();

    if ($guard !== '') {
        dcFlash('error', 'Your session expired or the form was tampered with. Please reload and try again.');
        header('Location: ' . $back, true, 303);
        exit;
    }
    if (!$tables) {
        dcFlash('error', 'Donation categories are not installed yet: apply database migration 010_payments.sql first.');
        header('Location: ' . $back, true, 303);
        exit;
    }

    if ($action === 'save') {
        $id        = (int) $str($_POST, 'id');
        $slug      = strtolower($str($_POST, 'slug'));
        $nameTa    = sanitizeText($str($_POST, 'name_ta'), 120);
        $nameEn    = sanitizeText($str($_POST, 'name_en'), 120);
        $descTa    = sanitizeText($str($_POST, 'description_ta'), 500);
        $descEn    = sanitizeText($str($_POST, 'description_en'), 500);
        $amountRaw = $str($_POST, 'suggested_amount');
        $sort      = max(-2147483648, min(2147483647, (int) $str($_POST, 'sort_order')));
        $active    = isset($_POST['is_active']) ? 1 : 0;
        $existing  = null;

        if ($id > 0) {
            $stmt = $db->prepare('SELECT * FROM donation_categories WHERE id = :id');
            $stmt->execute([':id' => $id]);
            $existing = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
            if ($existing === null) $errors['id'] = true;
            else $slug = (string) $existing['slug']; // a slug is set once and never changed
        } else {
            if (!preg_match('/^[a-z0-9_]{2,40}$/D', $slug)) {
                $errors['slug'] = true;
            } else {
                $stmt = $db->prepare('SELECT 1 FROM donation_categories WHERE slug = :s');
                $stmt->execute([':s' => $slug]);
                if ($stmt->fetchColumn() !== false) $errors['slug_taken'] = true;
            }
        }
        if ($nameTa === '') $errors['name_ta'] = true;
        if ($nameEn === '') $errors['name_en'] = true;

        $amount = null;
        if ($amountRaw !== '') {
            $parsed = payAmountParse($amountRaw);
            if ($parsed === null || (float) $parsed < 1 || (float) $parsed > DC_MAX_SUGGESTED) $errors['suggested_amount'] = true;
            else $amount = $parsed;
        }

        if ($errors) {
            $msg     = '<p class="alert alert--error" role="alert">'
                . h(isset($errors['slug_taken']) ? 'That key is already used by another category. Choose a different one.'
                    : (isset($errors['id']) ? 'That category no longer exists.'
                    : 'Check the highlighted fields: a key, a Tamil name and an English name are needed, and a suggested amount must be between ₹1 and ₹99,99,99,999.'))
                . '</p>';
            $editing = [
                'id' => $id, 'slug' => $slug, 'name_ta' => $nameTa, 'name_en' => $nameEn,
                'description_ta' => $descTa, 'description_en' => $descEn,
                'suggested_amount' => $amountRaw, 'sort_order' => $sort, 'is_active' => $active,
            ];
        } elseif ($id > 0) {
            $db->prepare(
                'UPDATE donation_categories
                    SET name_ta = :ta, name_en = :en, description_ta = :dta, description_en = :den,
                        suggested_amount = :amount, sort_order = :sort, is_active = :active, updated_at = UTC_TIMESTAMP()
                  WHERE id = :id'
            )->execute([
                ':ta' => $nameTa, ':en' => $nameEn, ':dta' => $descTa ?: null, ':den' => $descEn ?: null,
                ':amount' => $amount, ':sort' => $sort, ':active' => $active, ':id' => $id,
            ]);
            adminAudit('donation_category_saved', $slug, 'updated "' . $nameEn . '"' . ($active ? '' : ' (hidden)'));
            dcFlash('success', 'Saved “' . $nameEn . '”.');
            header('Location: ' . $back, true, 303);
            exit;
        } else {
            $db->prepare(
                'INSERT INTO donation_categories (slug, name_ta, name_en, description_ta, description_en, suggested_amount, sort_order, is_active, created_at, updated_at)
                 VALUES (:slug, :ta, :en, :dta, :den, :amount, :sort, :active, UTC_TIMESTAMP(), UTC_TIMESTAMP())'
            )->execute([
                ':slug' => $slug, ':ta' => $nameTa, ':en' => $nameEn, ':dta' => $descTa ?: null, ':den' => $descEn ?: null,
                ':amount' => $amount, ':sort' => $sort, ':active' => $active,
            ]);
            adminAudit('donation_category_created', $slug, 'created "' . $nameEn . '"');
            dcFlash('success', 'Created “' . $nameEn . '”. Devotees see it on the donation page' . ($active ? ' now.' : ' once you make it active.'));
            header('Location: ' . $back, true, 303);
            exit;
        }
    } elseif ($action === 'delete' || $action === 'hide') {
        $id   = (int) $str($_POST, 'id');
        $stmt = $db->prepare('SELECT * FROM donation_categories WHERE id = :id');
        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            dcFlash('error', 'That category no longer exists.');
        } elseif ($action === 'hide') {
            $db->prepare('UPDATE donation_categories SET is_active = 0, updated_at = UTC_TIMESTAMP() WHERE id = :id')->execute([':id' => $id]);
            adminAudit('donation_category_hidden', (string) $row['slug'], 'hidden from the donation page');
            dcFlash('success', '“' . $row['name_en'] . '” is hidden from the donation page. Donations already given to it keep their name.');
        } else {
            $uses = dcUsage($db)[$id] ?? 0;
            if ($uses > 0) {
                dcFlash('error', '“' . $row['name_en'] . '” cannot be deleted: ' . $uses . ' donation' . ($uses === 1 ? '' : 's') . ' use it. Hide it instead.');
            } else {
                $db->prepare('DELETE FROM donation_categories WHERE id = :id')->execute([':id' => $id]);
                adminAudit('donation_category_deleted', (string) $row['slug'], 'deleted "' . $row['name_en'] . '" (unused)');
                dcFlash('success', 'Deleted “' . $row['name_en'] . '”.');
            }
        }
        header('Location: ' . $back, true, 303);
        exit;
    } else {
        dcFlash('error', 'That action is not available on this page.');
        header('Location: ' . $back, true, 303);
        exit;
    }
}

// ── Page ─────────────────────────────────────────────────────────────────────
adminHeader('Donation Categories', 'Worship', [
    'actions' => '<a href="/donate" target="_blank" rel="noopener" class="btn btn-ghost btn--sm">' . adminIcon('external') . 'View on site</a>',
]);
echo $msg;

if (!$tables) {
    echo adminEmpty(
        'heart-hands',
        'Donation categories are not installed yet',
        'Apply database migration 010_payments.sql (see README). Until then the donation page offers the purposes built into the form.'
    );
    adminFooter();
    exit;
}

if ($editing === null && isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM donation_categories WHERE id = :id');
    $stmt->execute([':id' => (int) $str($_GET, 'edit')]);
    $editing = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
    if ($editing === null) echo '<p class="alert alert--warning" role="status">That category no longer exists.</p>';
}
$isEdit   = !empty($editing['id']);
$formOpen = $editing !== null;

$all   = payCategoriesAll($db);
$usage = dcUsage($db);
$rows  = array_values(array_filter($all, static function (array $c) use ($filter, $q): bool {
    if ($filter === 'active' && !$c['is_active']) return false;
    if ($filter === 'hidden' && $c['is_active']) return false;
    if ($q === '') return true;
    $hay = mb_strtolower($c['slug'] . ' ' . $c['name']['en'] . ' ' . $c['name']['ta'] . ' ' . $c['description']['en'] . ' ' . $c['description']['ta']);
    return str_contains($hay, mb_strtolower($q));
}));
$chipCounts = [
    'all'    => count($all),
    'active' => count(array_filter($all, static fn(array $c): bool => $c['is_active'])),
    'hidden' => count(array_filter($all, static fn(array $c): bool => !$c['is_active'])),
];
$filtered   = $filter !== $defaultFilter || $q !== '';
$countLabel = $filtered ? count($rows) . ' of ' . $chipCounts['all'] . ' categories' : count($rows) . ' categor' . (count($rows) === 1 ? 'y' : 'ies');

$invalid    = static fn(string $f): string => isset($errors[$f]) ? ' aria-invalid="true" aria-describedby="err-' . $f . '"' : '';
$fieldError = static fn(string $f, string $text): string => isset($errors[$f]) ? '<span class="field__error" id="err-' . $f . '">' . adminIcon('alert-circle') . h($text) . '</span>' : '';

echo adminPageIntro(
    'The purposes a devotee can choose when giving online — each with its own name in Tamil and English, an optional suggested amount, and its place in the list. The key is stored with every donation, so it is set once and never changed.',
    '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="crud" aria-expanded="false">' . adminIcon('plus') . ' New category</button>'
    . '<a href="/admin/payments.php" class="btn btn--sm">' . adminIcon('landmark') . ' Online Payments</a>'
);
?>

<div class="admin-two-col admin-two-col--collapsible" id="crud" data-editing="<?= $formOpen ? '1' : '0' ?>">

  <section class="card card--solid card--static admin-form-box" id="new" aria-labelledby="dc-form-title">
    <h2 id="dc-form-title"><?= adminIcon($isEdit ? 'pencil' : 'plus') ?> <?= $isEdit ? 'Edit category' : 'New category' ?></h2>
    <form method="POST" action="<?= DC_BASE ?>">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save" />
      <input type="hidden" name="f" value="<?= h($filter) ?>" />
      <input type="hidden" name="q" value="<?= h($q) ?>" />
      <?php if ($isEdit): ?><input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" /><?php endif; ?>

      <label for="dc-slug">
        <span class="field__label">Key <?= $isEdit ? '' : '<span class="field__required" aria-hidden="true">*</span>' ?></span>
        <?php if ($isEdit): ?>
          <input id="dc-slug" type="text" value="<?= h((string) $editing['slug']) ?>" readonly aria-readonly="true" />
          <span class="field__hint">Stored with every donation already given to this purpose, so it cannot be changed.</span>
        <?php else: ?>
          <input id="dc-slug" name="slug" type="text" required aria-required="true" maxlength="40" autocomplete="off"
                 pattern="[a-z0-9_]{2,40}" placeholder="e.g. temple_development" value="<?= h((string) ($editing['slug'] ?? '')) ?>"<?= $invalid('slug') ?> />
          <?= $fieldError('slug', 'Use 2–40 lowercase letters, digits or underscores.') ?>
          <?= $fieldError('slug_taken', 'Another category already uses that key.') ?>
          <span class="field__hint">Lowercase letters, digits and underscores. Chosen once; it cannot be changed later.</span>
        <?php endif; ?>
      </label>

      <label for="dc-name-en">
        <span class="field__label">English name <span class="field__required" aria-hidden="true">*</span></span>
        <input id="dc-name-en" name="name_en" type="text" required aria-required="true" maxlength="120" autocomplete="off"
               placeholder="e.g. Temple Development" value="<?= h((string) ($editing['name_en'] ?? '')) ?>"<?= $invalid('name_en') ?> />
        <?= $fieldError('name_en', 'An English name is required.') ?>
      </label>

      <label for="dc-name-ta">
        <span class="field__label">Tamil name <span class="field__required" aria-hidden="true">*</span></span>
        <input id="dc-name-ta" name="name_ta" type="text" lang="ta" required aria-required="true" maxlength="120" autocomplete="off"
               placeholder="எ.கா. கோயில் மேம்பாடு" value="<?= h((string) ($editing['name_ta'] ?? '')) ?>"<?= $invalid('name_ta') ?> />
        <?= $fieldError('name_ta', 'A Tamil name is required.') ?>
      </label>

      <label for="dc-desc-en">
        <span class="field__label">English description <span class="field__optional">optional</span></span>
        <textarea id="dc-desc-en" name="description_en" rows="2" maxlength="500" data-counter><?= h((string) ($editing['description_en'] ?? '')) ?></textarea>
        <span class="field__hint">One line under the name on the donation page.</span>
      </label>

      <label for="dc-desc-ta">
        <span class="field__label">Tamil description <span class="field__optional">optional</span></span>
        <textarea id="dc-desc-ta" name="description_ta" rows="2" lang="ta" maxlength="500" data-counter><?= h((string) ($editing['description_ta'] ?? '')) ?></textarea>
      </label>

      <div class="form-grid">
        <label for="dc-amount">
          <span class="field__label">Suggested amount (₹) <span class="field__optional">optional</span></span>
          <input id="dc-amount" name="suggested_amount" type="text" inputmode="decimal" maxlength="13" autocomplete="off"
                 placeholder="e.g. 1000" value="<?= h((string) ($editing['suggested_amount'] ?? '')) ?>"<?= $invalid('suggested_amount') ?> />
          <?= $fieldError('suggested_amount', 'Give an amount between ₹1 and ₹99,99,99,999, or leave it empty.') ?>
          <span class="field__hint">Fills the amount box when a devotee picks this purpose. They can still change it.</span>
        </label>
        <label for="dc-sort">
          <span class="field__label">Sort order</span>
          <input id="dc-sort" name="sort_order" type="number" inputmode="numeric" step="1" min="-2147483648" max="2147483647"
                 value="<?= h((string) ($editing['sort_order'] ?? '0')) ?>" />
          <span class="field__hint">Lower shows first.</span>
        </label>
      </div>

      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= (!$editing || !empty($editing['is_active'])) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Active</strong><span class="switch__desc">Offered to devotees on the donation page. A hidden category still names the donations already given to it.</span></span>
      </label>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> <?= $isEdit ? 'Save changes' : 'Save category' ?></button>
        <?php if ($formOpen): ?><a href="<?= h($listUrl()) ?>" class="btn btn-ghost">Cancel</a><?php endif; ?>
      </div>
    </form>
  </section>

  <div class="admin-list">
    <form method="GET" action="<?= DC_BASE ?>" class="toolbar" role="search">
      <?php if ($filter !== $defaultFilter): ?><input type="hidden" name="f" value="<?= h($filter) ?>" /><?php endif; ?>
      <div class="toolbar__search">
        <?= adminIcon('search') ?>
        <label for="dc-q" class="sr-only">Search donation categories</label>
        <input id="dc-q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search by name, key or description…" autocomplete="off" />
        <button type="submit" class="sr-only">Search</button>
      </div>
      <nav class="filter-chips" aria-label="Filter categories">
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
    <div class="table-wrap" tabindex="0" role="region" aria-label="Donation categories">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Key</th>
            <th scope="col" class="num">Suggested</th>
            <th scope="col" class="num">Order</th>
            <th scope="col" class="num">Used by</th>
            <th scope="col">Status</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($rows as $c): $cid = (int) $c['id']; $uses = $usage[$cid] ?? 0; ?>
          <tr>
            <td>
              <span class="cell-title"><?= h($c['name']['en']) ?></span>
              <span class="cell-sub" lang="ta"><?= h($c['name']['ta']) ?></span>
              <?php if ($c['description']['en'] !== ''): ?><span class="cell-clip cell-sub"><?= h($c['description']['en']) ?></span><?php endif; ?>
            </td>
            <td><span class="tabular"><?= h($c['slug']) ?></span></td>
            <td class="num cell-money"><?= $c['suggested_amount'] !== null ? h(payAdminMoney($c['suggested_amount'], 'INR')) : '<span class="text-muted">—</span>' ?></td>
            <td class="num tabular"><?= (int) $c['sort_order'] ?></td>
            <td class="num tabular">
              <?php if ($uses > 0): ?>
                <a href="/admin/donations.php?purpose=<?= h($c['slug']) ?>"><?= $uses ?></a>
              <?php else: ?>
                <span class="text-muted">0</span>
              <?php endif; ?>
            </td>
            <td><?= $c['is_active'] ? adminBadge('Active', 'success') : adminBadge('Hidden', 'muted') ?></td>
            <td class="cell-actions">
              <?php
              $menu = [['label' => 'Edit', 'icon' => 'pencil', 'href' => $listUrl(['edit' => $cid])]];
              if ($c['is_active']) {
                  $menu[] = ['label' => 'Hide from the donation page', 'icon' => 'eye-off',
                             'form' => ['action' => 'hide', 'id' => $cid, 'f' => $filter, 'q' => $q],
                             'confirm' => 'Hide “' . $c['name']['en'] . '” from the donation page? Donations already given to it keep their name.',
                             'confirmLabel' => 'Hide'];
              }
              // A category that labels donations is never offered for deletion:
              // the only honest choice is to hide it.
              if ($uses === 0) {
                  $menu[] = 'divider';
                  $menu[] = ['label' => 'Delete', 'icon' => 'trash', 'danger' => true,
                             'form' => ['action' => 'delete', 'id' => $cid, 'f' => $filter, 'q' => $q],
                             'confirm' => 'Delete “' . $c['name']['en'] . '”? No donation uses it, so nothing is lost. This cannot be undone.'];
              }
              echo adminMenu($menu, 'Actions for ' . $c['name']['en']);
              ?>
            </td>
          </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>
    <p class="field__hint mt-2">A category that already labels donations cannot be deleted — hide it instead, so old donations, reports and receipts keep their name.</p>
    <?php elseif ($filtered): ?>
      <?= adminEmpty('search', 'No categories match', 'Try a different search term or filter.',
          '<a href="' . DC_BASE . '" class="btn btn--sm">' . adminIcon('x') . ' Clear filters</a>') ?>
    <?php else: ?>
      <?= adminEmpty('heart-hands', 'No donation categories yet', 'Add the first purpose devotees can give to. Migration 010 seeds thirteen of them.',
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' New category</a>') ?>
    <?php endif; ?>
  </div>

</div>

<?php adminFooter(); ?>
