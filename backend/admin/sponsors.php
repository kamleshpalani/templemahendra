<?php
// backend/admin/sponsors.php — Sponsors: devotees sponsoring poojas
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

$typeTones = ['pournami' => 'moon', 'amavasai' => '', 'ekadasi' => 'sage', 'sashti' => 'sage', 'special' => 'gold', 'monthly' => 'info', 'daily' => 'info'];

// ── Filters (GET, whitelisted) ───────────────────────────────────────────────
$get  = fn(string $k): string => is_string($_GET[$k] ?? null) ? $_GET[$k] : '';
$post = fn(string $k): string => is_string($_POST[$k] ?? null) ? $_POST[$k] : '';

$sortCols = ['created_at' => 's.created_at', 'name' => 's.name', 'pooja_date' => 'p.pooja_date'];
$q        = mb_substr(trim($get('q')), 0, 100);
$status   = in_array($get('status'), ['active', 'hidden'], true) ? $get('status') : '';
$poojaId  = max(0, (int) $get('pooja'));
$sort     = isset($sortCols[$get('sort')]) ? $get('sort') : 'created_at';
$dir      = in_array($get('dir'), ['asc', 'desc'], true) ? $get('dir') : ($sort === 'created_at' ? 'desc' : 'asc');
$page     = max(1, (int) $get('page'));
$perPage  = 25;

// Pooja filter (link from the Poojas page) — ignored when the pooja no longer exists
$filterPooja = null;
if ($poojaId > 0) {
    $stmt = $db->prepare('SELECT id, name_en, name_ta, pooja_date, pooja_type FROM poojas WHERE id = :id');
    $stmt->execute([':id' => $poojaId]);
    $filterPooja = $stmt->fetch() ?: null;
    if (!$filterPooja) $poojaId = 0;
}

$query   = ['q' => $q, 'status' => $status, 'pooja' => $poojaId > 0 ? $poojaId : null, 'sort' => $sort, 'dir' => $dir, 'page' => $page > 1 ? $page : null];
$listUrl = '/admin/sponsors.php' . adminQuery($query);

// ── Flash after redirect ─────────────────────────────────────────────────────
$msg    = '';
$errors = [];
$old    = null;
if (!empty($_SESSION['flash'])) {
    $msg = (string) $_SESSION['flash'];
    unset($_SESSION['flash']);
}
$alert    = fn(string $tone, string $text): string => '<p class="alert alert--' . $tone . '">' . h($text) . '</p>';
$redirect = function (string $flash) use ($listUrl): void {
    $_SESSION['flash'] = $flash;
    header('Location: ' . $listUrl);
    exit;
};

// ── Actions ──────────────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $msg = adminCsrfGuard();
    if ($msg === '') {
        $action = $post('action');

        if ($action === 'save') {
            $name      = sanitizeText($post('name'));
            $phone     = sanitizeText($post('phone'), 30);
            $note      = sanitizeText($post('note'), 1000);
            $pooja_id  = ((int) ($_POST['pooja_id'] ?? 0)) ?: null;
            $is_active = isset($_POST['is_active']) ? 1 : 0;
            $id        = (int) ($_POST['id'] ?? 0);

            if ($name === '') $errors['name'] = 'Sponsor name is required.';

            if ($errors) {
                $msg = $alert('error', 'Sponsor name is required.');
                $old = ['id' => $id, 'name' => $name, 'phone' => $phone, 'note' => $note, 'pooja_id' => $pooja_id, 'is_active' => $is_active];
            } elseif ($id > 0) {
                $db->prepare('UPDATE sponsors SET name=:n,phone=:ph,note=:nt,pooja_id=:pid,is_active=:a WHERE id=:id')
                   ->execute([':n' => $name, ':ph' => $phone, ':nt' => $note, ':pid' => $pooja_id, ':a' => $is_active, ':id' => $id]);
                $redirect($alert('success', 'Sponsor updated.'));
            } else {
                $db->prepare('INSERT INTO sponsors (name,phone,note,pooja_id,is_active) VALUES (:n,:ph,:nt,:pid,:a)')
                   ->execute([':n' => $name, ':ph' => $phone, ':nt' => $note, ':pid' => $pooja_id, ':a' => $is_active]);
                $redirect($alert('success', 'Sponsor added.'));
            }
        } elseif ($action === 'delete') {
            $id = (int) ($_POST['id'] ?? 0);
            if ($id > 0) {
                $db->prepare('DELETE FROM sponsors WHERE id=:id')->execute([':id' => $id]);
                $redirect($alert('success', 'Sponsor deleted.'));
            }
        } elseif ($action === 'toggle') {
            $id = (int) ($_POST['id'] ?? 0);
            if ($id > 0) {
                $db->prepare('UPDATE sponsors SET is_active = 1 - is_active WHERE id=:id')->execute([':id' => $id]);
                $stmt = $db->prepare('SELECT is_active FROM sponsors WHERE id=:id');
                $stmt->execute([':id' => $id]);
                $state = $stmt->fetchColumn();
                if ($state !== false) {
                    $redirect($alert('success', (int) $state ? 'Sponsor is now active.' : 'Sponsor hidden.'));
                }
            }
        }
    }
}

// ── Editing ──────────────────────────────────────────────────────────────────
$editing = null;
if (isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM sponsors WHERE id=:id');
    $stmt->execute([':id' => (int) $_GET['edit']]);
    $editing = $stmt->fetch() ?: null;
    if (!$editing) $msg .= $alert('warning', 'That sponsor no longer exists.');
}
$form = $old ?? $editing ?? ['id' => 0, 'name' => '', 'phone' => '', 'note' => '', 'pooja_id' => $poojaId > 0 ? $poojaId : null, 'is_active' => 1];
$isEditing = (int) ($form['id'] ?? 0) > 0;

// Poojas for the dropdown (active, latest first) — plus the currently linked one if it is not in that list
$poojas = $db->query(
    "SELECT id, name_ta, name_en, pooja_date FROM poojas
      WHERE is_active=1 ORDER BY pooja_date DESC LIMIT 50"
)->fetchAll();
$selectedPooja = (int) ($form['pooja_id'] ?? 0);
if ($selectedPooja > 0 && !in_array($selectedPooja, array_map(fn($p) => (int) $p['id'], $poojas), true)) {
    $stmt = $db->prepare('SELECT id, name_ta, name_en, pooja_date FROM poojas WHERE id = :id');
    $stmt->execute([':id' => $selectedPooja]);
    if ($extra = $stmt->fetch()) array_unshift($poojas, $extra);
}

// ── Data ─────────────────────────────────────────────────────────────────────
$kpi = $db->query("SELECT COUNT(*) AS total,
                          COALESCE(SUM(is_active = 1), 0) AS active,
                          COALESCE(SUM(pooja_id IS NOT NULL), 0) AS linked,
                          COALESCE(SUM(created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')), 0) AS this_month
                     FROM sponsors")->fetch();

$where  = [];
$params = [];
if ($q !== '')          { $where[] = '(s.name LIKE ? OR s.phone LIKE ? OR s.note LIKE ?)'; array_push($params, "%$q%", "%$q%", "%$q%"); }
if ($status === 'active') $where[] = 's.is_active = 1';
if ($status === 'hidden') $where[] = 's.is_active = 0';
if ($poojaId > 0)       { $where[] = 's.pooja_id = ?'; $params[] = $poojaId; }
$sql = 'SELECT s.*, p.name_en AS pooja_name_en, p.name_ta AS pooja_name_ta, p.pooja_date, p.pooja_type
          FROM sponsors s
          LEFT JOIN poojas p ON p.id = s.pooja_id'
     . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
     . ' ORDER BY ' . $sortCols[$sort] . ' ' . strtoupper($dir) . ', s.id DESC';
$list = adminPaginate($db, $sql, $params, $page, $perPage);

// Status chip counts (respecting search + pooja filter)
$countWhere  = [];
$countParams = [];
if ($q !== '')    { $countWhere[] = '(s.name LIKE ? OR s.phone LIKE ? OR s.note LIKE ?)'; array_push($countParams, "%$q%", "%$q%", "%$q%"); }
if ($poojaId > 0) { $countWhere[] = 's.pooja_id = ?'; $countParams[] = $poojaId; }
$stmt = $db->prepare('SELECT COALESCE(SUM(s.is_active = 1), 0) AS active, COALESCE(SUM(s.is_active = 0), 0) AS hidden FROM sponsors s' . ($countWhere ? ' WHERE ' . implode(' AND ', $countWhere) : ''));
$stmt->execute($countParams);
$statusCounts = $stmt->fetch();
$statusCounts = ['active' => (int) $statusCounts['active'], 'hidden' => (int) $statusCounts['hidden']];
$hasFilters   = $q !== '' || $status !== '' || $poojaId > 0;

$fieldAttrs = fn(string $k): string => isset($errors[$k]) ? ' aria-invalid="true" aria-describedby="s-' . $k . '-err"' : '';
$fieldError = fn(string $k): string => isset($errors[$k]) ? '<span class="field__error" id="s-' . $k . '-err">' . adminIcon('alert-circle') . h($errors[$k]) . '</span>' : '';
/** Turn a stored phone string into a dialable tel: href (digits and a leading +). */
$telHref = fn(string $phone): string => 'tel:' . (str_starts_with(trim($phone), '+') ? '+' : '') . preg_replace('/\D/', '', $phone);

// ── Page ─────────────────────────────────────────────────────────────────────
adminHeader('Sponsors', 'Worship', [
    'actions' => '<a href="/admin/poojas.php" class="btn btn-ghost btn--sm">' . adminIcon('flame') . 'Poojas</a>',
]);
echo $msg;
echo adminPageIntro(
    'Record the devotees and families sponsoring poojas, optionally linked to a scheduled pooja; active sponsors can be featured on the homepage.',
    '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="sponsor-panel" aria-expanded="false">' . adminIcon('plus') . ' New sponsor</button>' .
    '<a href="/admin/bulk_upload.php?entity=sponsors" class="btn btn--sm">' . adminIcon('upload') . ' Import CSV</a>'
);
echo adminKpi([
    ['label' => 'Sponsors',       'value' => (int) $kpi['total'],      'icon' => 'heart-hands', 'variant' => 'accent', 'sub' => (int) $kpi['active'] . ' active'],
    ['label' => 'Active',         'value' => (int) $kpi['active'],     'icon' => 'check-circle', 'href' => '/admin/sponsors.php?status=active'],
    ['label' => 'Linked to a pooja', 'value' => (int) $kpi['linked'],  'icon' => 'flame',       'href' => '/admin/poojas.php', 'sub' => 'Open the Poojas page to see who sponsors what'],
    ['label' => 'Added this month','value' => (int) $kpi['this_month'],'icon' => 'trending',    'href' => '/admin/sponsors.php?sort=created_at&dir=desc'],
]);
?>

<div class="admin-two-col admin-two-col--collapsible" id="sponsor-panel"<?= $isEditing ? ' data-editing="1"' : '' ?>>

  <section class="admin-form-box card card--static" id="new" aria-labelledby="sponsor-form-title">
    <h2 id="sponsor-form-title"><?= adminIcon($isEditing ? 'pencil' : 'plus', 'ico--sm') ?> <?= $isEditing ? 'Edit sponsor' : 'Add sponsor' ?></h2>
    <form method="POST" action="<?= h($listUrl) ?>">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save" />
      <?php if ($isEditing): ?><input type="hidden" name="id" value="<?= (int) $form['id'] ?>" /><?php endif; ?>

      <label for="s-name">
        <span class="field__label">Sponsor name <span class="field__required" aria-hidden="true">*</span></span>
        <input id="s-name" name="name" required aria-required="true" maxlength="200" autocomplete="off"
               value="<?= h($form['name']) ?>" placeholder="Murugan Family / ஸ்ரீ முருகன் குடும்பம்"<?= $fieldAttrs('name') ?> />
        <?= $fieldError('name') ?>
      </label>

      <label for="s-phone">
        Contact number
        <input id="s-phone" type="tel" name="phone" maxlength="30" autocomplete="off" inputmode="tel"
               value="<?= h($form['phone'] ?? '') ?>" placeholder="+91 98765 43210" />
        <span class="field__hint">Kept private — shown only here in the admin.</span>
      </label>

      <label for="s-pooja">
        Linked pooja
        <select id="s-pooja" name="pooja_id">
          <option value="">— None —</option>
          <?php foreach ($poojas as $p): ?>
            <option value="<?= (int) $p['id'] ?>"<?= $selectedPooja === (int) $p['id'] ? ' selected' : '' ?>><?= h($p['name_ta'] . ' (' . $p['name_en'] . ') · ' . adminFmtDate($p['pooja_date'])) ?></option>
          <?php endforeach; ?>
        </select>
        <span class="field__hint">Optional. Only active poojas are listed (latest 50).</span>
      </label>

      <label for="s-note">
        Note
        <textarea id="s-note" name="note" rows="3" maxlength="1000" data-counter placeholder="Dedication, message or special request…"><?= h($form['note'] ?? '') ?></textarea>
      </label>

      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= !empty($form['is_active']) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label">Active<span class="switch__desc">Hidden sponsors stay in the admin but are not featured on the website.</span></span>
      </label>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> <?= $isEditing ? 'Save changes' : 'Save sponsor' ?></button>
        <?php if ($isEditing): ?>
          <a href="<?= h($listUrl) ?>" class="btn btn-ghost">Cancel</a>
        <?php endif; ?>
      </div>
    </form>
  </section>

  <div class="admin-list">
    <form method="GET" action="/admin/sponsors.php" class="toolbar" role="search">
      <?php if ($status !== ''): ?><input type="hidden" name="status" value="<?= h($status) ?>" /><?php endif; ?>
      <?php if ($poojaId > 0): ?><input type="hidden" name="pooja" value="<?= $poojaId ?>" /><?php endif; ?>
      <input type="hidden" name="sort" value="<?= h($sort) ?>" />
      <input type="hidden" name="dir" value="<?= h($dir) ?>" />
      <div class="toolbar__search">
        <?= adminIcon('search') ?>
        <label class="sr-only" for="sponsor-q">Search sponsors by name, phone or note</label>
        <input id="sponsor-q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search name, phone or note…" autocomplete="off" />
      </div>
      <div class="toolbar__group">
        <button type="submit" class="btn btn--sm">Search</button>
        <?php if ($q !== ''): ?><a href="<?= h('/admin/sponsors.php' . adminQuery($query, ['q' => null, 'page' => null])) ?>" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Clear</a><?php endif; ?>
      </div>
      <span class="toolbar__count"><?= $list['total'] ?> record<?= $list['total'] === 1 ? '' : 's' ?></span>
    </form>

    <div class="filter-chips mb-4" role="group" aria-label="Filter by status">
      <a class="chip" href="<?= h('/admin/sponsors.php' . adminQuery($query, ['status' => null, 'page' => null])) ?>"<?= $status === '' ? ' aria-current="page"' : '' ?>>All <span class="chip__count"><?= $statusCounts['active'] + $statusCounts['hidden'] ?></span></a>
      <a class="chip" href="<?= h('/admin/sponsors.php' . adminQuery($query, ['status' => 'active', 'page' => null])) ?>"<?= $status === 'active' ? ' aria-current="page"' : '' ?>>Active <span class="chip__count"><?= $statusCounts['active'] ?></span></a>
      <a class="chip" href="<?= h('/admin/sponsors.php' . adminQuery($query, ['status' => 'hidden', 'page' => null])) ?>"<?= $status === 'hidden' ? ' aria-current="page"' : '' ?>>Hidden <span class="chip__count"><?= $statusCounts['hidden'] ?></span></a>
      <?php if ($filterPooja): ?>
        <a class="chip" aria-current="page" href="<?= h('/admin/sponsors.php' . adminQuery($query, ['pooja' => null, 'page' => null])) ?>" aria-label="Remove pooja filter: <?= h($filterPooja['name_en']) ?>">
          <?= adminIcon('flame', 'ico--xs') ?> <?= h($filterPooja['name_en']) ?> · <?= adminFmtDate($filterPooja['pooja_date']) ?> <?= adminIcon('x', 'ico--xs') ?>
        </a>
      <?php endif; ?>
    </div>

    <?php if ($list['rows']): ?>
      <div class="table-wrap">
        <table class="table" data-no-search>
          <thead>
            <tr>
              <?= adminSortLink('name', 'Sponsor', $query) ?>
              <th scope="col">Phone</th>
              <?= adminSortLink('pooja_date', 'Linked pooja', $query) ?>
              <?= adminSortLink('created_at', 'Added', $query) ?>
              <th scope="col">Status</th>
              <th scope="col" class="cell-actions"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <?php foreach ($list['rows'] as $row): $rid = (int) $row['id']; ?>
              <tr>
                <td>
                  <span class="cell-title"><?= h($row['name']) ?></span>
                  <?php if ($row['note'] !== null && $row['note'] !== ''): ?><span class="cell-sub cell-clip"><?= h($row['note']) ?></span><?php endif; ?>
                </td>
                <td>
                  <?php if ($row['phone'] !== null && $row['phone'] !== ''): ?>
                    <a href="<?= h($telHref($row['phone'])) ?>" class="nowrap"><?= adminIcon('phone', 'ico--xs') ?> <?= h($row['phone']) ?></a>
                  <?php else: ?>
                    <span class="text-muted">—</span>
                  <?php endif; ?>
                </td>
                <td>
                  <?php if ($row['pooja_id']): ?>
                    <?= adminBadge($row['pooja_name_en'] ?? 'Pooja #' . (int) $row['pooja_id'], $typeTones[$row['pooja_type'] ?? ''] ?? '') ?>
                    <?php if ($row['pooja_date']): ?><span class="cell-sub"><?= adminFmtDate($row['pooja_date']) ?></span><?php endif; ?>
                  <?php else: ?>
                    <span class="text-muted">—</span>
                  <?php endif; ?>
                </td>
                <td class="cell-date"><time datetime="<?= h($row['created_at']) ?>" data-tip="<?= h(adminFmtDate($row['created_at'], true)) ?>"><?= adminAgo($row['created_at']) ?></time></td>
                <td><?= $row['is_active'] ? adminBadge('Active', 'success') : adminBadge('Hidden', 'muted') ?></td>
                <td class="cell-actions">
                  <?= adminMenu([
                      ['label' => 'Edit', 'icon' => 'pencil', 'href' => '/admin/sponsors.php' . adminQuery($query, ['edit' => $rid]) . '#new'],
                      ['label' => $row['is_active'] ? 'Hide sponsor' : 'Activate sponsor', 'icon' => $row['is_active'] ? 'eye-off' : 'eye', 'form' => ['action' => 'toggle', 'id' => $rid], 'action' => $listUrl],
                      'divider',
                      ['label' => 'Delete', 'icon' => 'trash', 'danger' => true, 'form' => ['action' => 'delete', 'id' => $rid], 'action' => $listUrl,
                       'confirm' => 'Delete sponsor "' . $row['name'] . '"? This cannot be undone.'],
                  ], 'Actions for ' . $row['name']) ?>
                </td>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      </div>
      <?= adminPagination($list['page'], $list['pages'], $query, $list['total'], $perPage) ?>
    <?php elseif ($hasFilters): ?>
      <?= adminEmpty('filter', 'No sponsors match these filters', 'Try a different search, clear the status filter, or add a new sponsor.',
          '<a href="/admin/sponsors.php" class="btn btn--sm">' . adminIcon('x') . ' Clear filters</a>' .
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' Add sponsor</a>') ?>
    <?php else: ?>
      <?= adminEmpty('heart-hands', 'No sponsors yet', 'Add the devotees and families who sponsor poojas, or import a list from CSV.',
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' Add sponsor</a>' .
          '<a href="/admin/bulk_upload.php?entity=sponsors" class="btn btn--sm">' . adminIcon('upload') . ' Import CSV</a>') ?>
    <?php endif; ?>
  </div>

</div>
<?php adminFooter(); ?>
