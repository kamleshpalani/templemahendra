<?php
// backend/admin/poojas.php — Poojas: Pournami, Amavasai, Ekadasi, Sashti and special poojas
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

// ── Vocabulary ───────────────────────────────────────────────────────────────
$typeLabels = [ // Tamil + English — used in the form select
    'pournami' => 'பௌர்ணமி (Pournami)',
    'amavasai' => 'அமாவாசை (Amavasai)',
    'ekadasi'  => 'ஏகாதசி (Ekadasi)',
    'sashti'   => 'சஷ்டி (Sashti)',
    'special'  => 'Special',
    'monthly'  => 'Monthly',
    'daily'    => 'Daily',
];
$typeEnglish = ['pournami' => 'Pournami', 'amavasai' => 'Amavasai', 'ekadasi' => 'Ekadasi', 'sashti' => 'Sashti', 'special' => 'Special', 'monthly' => 'Monthly', 'daily' => 'Daily'];
$typeTones   = ['pournami' => 'moon', 'amavasai' => '', 'ekadasi' => 'sage', 'sashti' => 'sage', 'special' => 'gold', 'monthly' => 'info', 'daily' => 'info'];
$types       = array_keys($typeLabels);

// ── Filters (GET, whitelisted) ───────────────────────────────────────────────
$get  = fn(string $k): string => is_string($_GET[$k] ?? null) ? $_GET[$k] : '';
$post = fn(string $k): string => is_string($_POST[$k] ?? null) ? $_POST[$k] : '';

$sortCols = ['pooja_date' => 'p.pooja_date', 'name_en' => 'p.name_en', 'pooja_type' => 'p.pooja_type'];
$type     = in_array($get('type'), $types, true) ? $get('type') : '';
$when     = in_array($get('when'), ['upcoming', 'past', 'all'], true) ? $get('when') : 'upcoming';
$q        = mb_substr(trim($get('q')), 0, 100);
$sort     = isset($sortCols[$get('sort')]) ? $get('sort') : 'pooja_date';
$dir      = in_array($get('dir'), ['asc', 'desc'], true) ? $get('dir') : ($when === 'upcoming' ? 'asc' : 'desc');
$page     = max(1, (int) $get('page'));
$perPage  = 25;
$query    = ['type' => $type, 'when' => $when === 'upcoming' ? null : $when, 'q' => $q, 'sort' => $sort, 'dir' => $dir, 'page' => $page > 1 ? $page : null];
$listUrl  = '/admin/poojas.php' . adminQuery($query);

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
            $name_ta   = sanitizeText($post('name_ta'), 200);   // poojas.name_ta is VARCHAR(200)
            $name_en   = sanitizeText($post('name_en'), 200);   // poojas.name_en is VARCHAR(200)
            $desc_ta   = sanitizeText($post('description_ta'), 2000);
            $desc_en   = sanitizeText($post('description_en'), 2000);
            $date      = sanitizeText($post('pooja_date'));
            $time      = sanitizeText($post('pooja_time'), 20);
            $ptype     = in_array($post('pooja_type'), $types, true) ? $post('pooja_type') : 'special';
            $is_active = isset($_POST['is_active']) ? 1 : 0;
            $id        = (int) ($_POST['id'] ?? 0);

            if ($name_ta === '') $errors['name_ta'] = 'Tamil name is required.';
            if ($name_en === '') $errors['name_en'] = 'English name is required.';
            if ($date === '') {
                $errors['pooja_date'] = 'Pooja date is required.';
            } elseif (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $date, $m) || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
                $errors['pooja_date'] = 'Enter a valid date.';
            }

            if ($errors) {
                $missing = $name_ta === '' || $name_en === '' || $date === '';
                $msg = $alert('error', $missing ? 'Tamil name, English name, and date are required.' : $errors['pooja_date']);
                $old = ['id' => $id, 'name_ta' => $name_ta, 'name_en' => $name_en, 'description_ta' => $desc_ta, 'description_en' => $desc_en,
                        'pooja_date' => $date, 'pooja_time' => $time, 'pooja_type' => $ptype, 'is_active' => $is_active];
            } elseif ($id > 0) {
                $db->prepare('UPDATE poojas SET name_ta=:ta,name_en=:en,description_ta=:dta,description_en=:den,
                              pooja_date=:dt,pooja_time=:tm,pooja_type=:typ,is_active=:a WHERE id=:id')
                   ->execute([':ta' => $name_ta, ':en' => $name_en, ':dta' => $desc_ta, ':den' => $desc_en,
                              ':dt' => $date, ':tm' => $time, ':typ' => $ptype, ':a' => $is_active, ':id' => $id]);
                $redirect($alert('success', 'Pooja updated.'));
            } else {
                $db->prepare('INSERT INTO poojas (name_ta,name_en,description_ta,description_en,
                              pooja_date,pooja_time,pooja_type,is_active) VALUES (:ta,:en,:dta,:den,:dt,:tm,:typ,:a)')
                   ->execute([':ta' => $name_ta, ':en' => $name_en, ':dta' => $desc_ta, ':den' => $desc_en,
                              ':dt' => $date, ':tm' => $time, ':typ' => $ptype, ':a' => $is_active]);
                $redirect($alert('success', 'Pooja created.'));
            }
        } elseif ($action === 'delete') {
            $id = (int) ($_POST['id'] ?? 0);
            if ($id > 0) {
                $stmt = $db->prepare('DELETE FROM poojas WHERE id=:id');
                $stmt->execute([':id' => $id]);
                $redirect($stmt->rowCount()
                    ? $alert('success', 'Pooja deleted.')
                    : $alert('warning', 'That pooja no longer exists.'));
            }
        } elseif ($action === 'toggle') {
            $id = (int) ($_POST['id'] ?? 0);
            if ($id > 0) {
                $db->prepare('UPDATE poojas SET is_active = 1 - is_active WHERE id=:id')->execute([':id' => $id]);
                $stmt = $db->prepare('SELECT is_active FROM poojas WHERE id=:id');
                $stmt->execute([':id' => $id]);
                $state = $stmt->fetchColumn();
                if ($state !== false) {
                    $redirect($alert('success', (int) $state ? 'Pooja is now visible on the website.' : 'Pooja hidden from the website.'));
                } else {
                    $redirect($alert('warning', 'That pooja no longer exists.'));
                }
            }
        }
    }
}

// ── Editing ──────────────────────────────────────────────────────────────────
$editing = null;
if (isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM poojas WHERE id=:id');
    $stmt->execute([':id' => (int) $_GET['edit']]);
    $editing = $stmt->fetch() ?: null;
    if (!$editing) $msg .= $alert('warning', 'That pooja no longer exists.');
}
$form = $old ?? $editing ?? ['id' => 0, 'name_ta' => '', 'name_en' => '', 'description_ta' => '', 'description_en' => '',
                             'pooja_date' => '', 'pooja_time' => '', 'pooja_type' => 'special', 'is_active' => 1];
$isEditing = (int) ($form['id'] ?? 0) > 0;

// ── Data ─────────────────────────────────────────────────────────────────────
$dbToday = (string) $db->query('SELECT CURDATE()')->fetchColumn();

$kpi  = $db->query("SELECT COUNT(*) AS total,
                           COALESCE(SUM(pooja_date >= CURDATE() AND is_active = 1), 0) AS upcoming,
                           COALESCE(SUM(pooja_date >= CURDATE() AND pooja_date < DATE_ADD(CURDATE(), INTERVAL 30 DAY) AND is_active = 1), 0) AS next30,
                           COALESCE(SUM(is_active = 0), 0) AS hidden
                      FROM poojas")->fetch();
$next = $db->query("SELECT name_en, pooja_date FROM poojas WHERE is_active = 1 AND pooja_date >= CURDATE() ORDER BY pooja_date ASC, id ASC LIMIT 1")->fetch();
$linkedSponsors = (int) $db->query("SELECT COUNT(*) FROM sponsors WHERE pooja_id IS NOT NULL")->fetchColumn();

$whenSql = $when === 'upcoming' ? 'p.pooja_date >= CURDATE()' : ($when === 'past' ? 'p.pooja_date < CURDATE()' : '');

// Type chip counts — same predicates as the table (minus the type itself) so a chip
// never advertises rows that clicking it will not produce.
$typeCounts = [];
$cntWhere   = [];
$cntParams  = [];
if ($whenSql)   $cntWhere[] = $whenSql;
if ($q !== '') { $cntWhere[] = '(p.name_ta LIKE ? OR p.name_en LIKE ?)'; $cntParams[] = "%$q%"; $cntParams[] = "%$q%"; }
$cnt = $db->prepare('SELECT p.pooja_type, COUNT(*) AS c FROM poojas p'
     . ($cntWhere ? ' WHERE ' . implode(' AND ', $cntWhere) : '') . ' GROUP BY p.pooja_type');
$cnt->execute($cntParams);
foreach ($cnt->fetchAll() as $r) {
    $typeCounts[$r['pooja_type']] = (int) $r['c'];
}
$allCount = array_sum($typeCounts);

$where  = [];
$params = [];
if ($whenSql)      $where[] = $whenSql;
if ($type !== '') { $where[] = 'p.pooja_type = ?'; $params[] = $type; }
if ($q !== '')    { $where[] = '(p.name_ta LIKE ? OR p.name_en LIKE ?)'; $params[] = "%$q%"; $params[] = "%$q%"; }
$sql  = 'SELECT p.*, (SELECT COUNT(*) FROM sponsors s WHERE s.pooja_id = p.id) AS sponsor_count FROM poojas p'
      . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
      . ' ORDER BY ' . $sortCols[$sort] . ' ' . strtoupper($dir) . ', p.id DESC';
$list = adminPaginate($db, $sql, $params, $page, $perPage);
$hasFilters = $type !== '' || $q !== '' || $when !== 'all';

/** "Today" / "In 9 days" / "3 days ago" relative to the database's current date. */
$relDay = function (string $iso) use ($dbToday): string {
    try {
        $diff = (int) (new DateTimeImmutable($dbToday))->diff(new DateTimeImmutable($iso))->format('%r%a');
    } catch (Throwable) {
        return '';
    }
    if ($diff === 0)  return 'Today';
    if ($diff === 1)  return 'Tomorrow';
    if ($diff === -1) return 'Yesterday';
    return $diff > 0 ? "In $diff days" : abs($diff) . ' days ago';
};
$fieldAttrs = fn(string $k): string => isset($errors[$k]) ? ' aria-invalid="true" aria-describedby="p-' . $k . '-err"' : '';
$fieldError = fn(string $k): string => isset($errors[$k]) ? '<span class="field__error" id="p-' . $k . '-err">' . adminIcon('alert-circle') . h($errors[$k]) . '</span>' : '';

// ── Page ─────────────────────────────────────────────────────────────────────
adminHeader('Poojas', 'Worship', [
    'actions' => '<a href="/admin/sponsors.php" class="btn btn-ghost btn--sm">' . adminIcon('heart-hands') . 'Sponsors</a>',
]);
echo $msg;
echo adminPageIntro(
    'Schedule the Pournami, Amavasai, Ekadasi, Sashti and special poojas shown on the public website; hidden poojas stay here but are not published.',
    '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="pooja-panel" aria-expanded="false">' . adminIcon('plus') . ' New pooja</button>' .
    '<a href="/admin/bulk_upload.php?entity=poojas" class="btn btn--sm">' . adminIcon('upload') . ' Import CSV</a>'
);
echo adminKpi([
    ['label' => 'Upcoming',       'value' => (int) $kpi['upcoming'], 'icon' => 'flame',    'variant' => 'accent', 'sub' => $next ? 'Next: ' . adminFmtDate($next['pooja_date']) . ' · ' . $next['name_en'] : 'Nothing scheduled'],
    ['label' => 'Next 30 days',   'value' => (int) $kpi['next30'],   'icon' => 'calendar', 'href' => '/admin/poojas.php'],
    ['label' => 'Hidden',         'value' => (int) $kpi['hidden'],   'icon' => 'eye-off',  'href' => '/admin/poojas.php?when=all', 'sub' => 'Not shown on the website'],
    ['label' => 'All poojas',     'value' => (int) $kpi['total'],    'icon' => 'layers',   'href' => '/admin/poojas.php?when=all', 'sub' => $linkedSponsors . ' sponsor' . ($linkedSponsors === 1 ? '' : 's') . ' linked'],
]);
?>

<div class="admin-two-col admin-two-col--collapsible" id="pooja-panel"<?= $isEditing ? ' data-editing="1"' : '' ?>>

  <section class="admin-form-box card card--static" id="new" aria-labelledby="pooja-form-title">
    <h2 id="pooja-form-title"><?= adminIcon($isEditing ? 'pencil' : 'plus', 'ico--sm') ?> <?= $isEditing ? 'Edit pooja' : 'Add pooja' ?></h2>
    <form method="POST" action="<?= h($listUrl) ?>">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save" />
      <?php if ($isEditing): ?><input type="hidden" name="id" value="<?= (int) $form['id'] ?>" /><?php endif; ?>

      <label for="p-name_ta">
        <span class="field__label">Tamil name <span class="field__required" aria-hidden="true">*</span></span>
        <input id="p-name_ta" name="name_ta" lang="ta" required aria-required="true" maxlength="200"
               value="<?= h($form['name_ta']) ?>" placeholder="பௌர்ணமி பூஜை"<?= $fieldAttrs('name_ta') ?> />
        <?= $fieldError('name_ta') ?>
      </label>

      <label for="p-name_en">
        <span class="field__label">English name <span class="field__required" aria-hidden="true">*</span></span>
        <input id="p-name_en" name="name_en" required aria-required="true" maxlength="200"
               value="<?= h($form['name_en']) ?>" placeholder="Pournami Pooja"<?= $fieldAttrs('name_en') ?> />
        <?= $fieldError('name_en') ?>
      </label>

      <div class="form-grid">
        <label for="p-pooja_date">
          <span class="field__label">Date <span class="field__required" aria-hidden="true">*</span></span>
          <input id="p-pooja_date" type="date" name="pooja_date" required aria-required="true"
                 value="<?= h($form['pooja_date']) ?>"<?= $fieldAttrs('pooja_date') ?> />
          <?= $fieldError('pooja_date') ?>
        </label>
        <label for="p-pooja_time">
          Time
          <input id="p-pooja_time" name="pooja_time" maxlength="20" value="<?= h($form['pooja_time']) ?>" placeholder="07:00 AM" autocomplete="off" />
          <span class="field__hint">Shown as typed, e.g. 07:00 AM</span>
        </label>
      </div>

      <label for="p-pooja_type">
        <span class="field__label">Type <span class="field__required" aria-hidden="true">*</span></span>
        <select id="p-pooja_type" name="pooja_type" required aria-required="true">
          <?php foreach ($typeLabels as $val => $lbl): ?>
            <option value="<?= h($val) ?>"<?= ($form['pooja_type'] ?? 'special') === $val ? ' selected' : '' ?>><?= h($lbl) ?></option>
          <?php endforeach; ?>
        </select>
      </label>

      <label for="p-description_ta">
        Description (Tamil)
        <textarea id="p-description_ta" name="description_ta" lang="ta" rows="3" maxlength="2000" data-counter><?= h($form['description_ta'] ?? '') ?></textarea>
      </label>

      <label for="p-description_en">
        Description (English)
        <textarea id="p-description_en" name="description_en" rows="3" maxlength="2000" data-counter><?= h($form['description_en'] ?? '') ?></textarea>
      </label>

      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= !empty($form['is_active']) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label">Visible on the website<span class="switch__desc">Hidden poojas stay in the admin but are not published.</span></span>
      </label>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> <?= $isEditing ? 'Save changes' : 'Save pooja' ?></button>
        <?php if ($isEditing): ?>
          <a href="<?= h($listUrl) ?>" class="btn btn-ghost">Cancel</a>
        <?php endif; ?>
      </div>
    </form>
  </section>

  <div class="admin-list">
    <form method="GET" action="/admin/poojas.php" class="toolbar" role="search">
      <?php if ($type !== ''): ?><input type="hidden" name="type" value="<?= h($type) ?>" /><?php endif; ?>
      <?php if ($when !== 'upcoming'): ?><input type="hidden" name="when" value="<?= h($when) ?>" /><?php endif; ?>
      <input type="hidden" name="sort" value="<?= h($sort) ?>" />
      <input type="hidden" name="dir" value="<?= h($dir) ?>" />
      <div class="toolbar__search">
        <?= adminIcon('search') ?>
        <label class="sr-only" for="pooja-q">Search poojas by name</label>
        <input id="pooja-q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search by name…" autocomplete="off" />
      </div>
      <div class="toolbar__group">
        <button type="submit" class="btn btn--sm">Search</button>
        <?php if ($q !== ''): ?><a href="<?= h('/admin/poojas.php' . adminQuery($query, ['q' => null, 'page' => null])) ?>" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Clear</a><?php endif; ?>
      </div>
      <nav class="tabs" aria-label="Show poojas by date">
        <?php foreach (['upcoming' => 'Upcoming', 'past' => 'Past', 'all' => 'All dates'] as $w => $lbl): ?>
          <a class="tab" href="<?= h('/admin/poojas.php' . adminQuery($query, ['when' => $w === 'upcoming' ? null : $w, 'sort' => null, 'dir' => null, 'page' => null])) ?>"<?= $when === $w ? ' aria-current="page"' : '' ?>><?= $lbl ?></a>
        <?php endforeach; ?>
      </nav>
      <span class="toolbar__count"><?= $list['total'] ?> record<?= $list['total'] === 1 ? '' : 's' ?></span>
    </form>

    <div class="filter-chips mb-4" role="group" aria-label="Filter by pooja type">
      <a class="chip" href="<?= h('/admin/poojas.php' . adminQuery($query, ['type' => null, 'page' => null])) ?>"<?= $type === '' ? ' aria-current="page"' : '' ?>>All <span class="chip__count"><?= $allCount ?></span></a>
      <?php foreach ($typeEnglish as $val => $lbl): ?>
        <a class="chip" href="<?= h('/admin/poojas.php' . adminQuery($query, ['type' => $val, 'page' => null])) ?>"<?= $type === $val ? ' aria-current="page"' : '' ?>><?= h($lbl) ?> <span class="chip__count"><?= $typeCounts[$val] ?? 0 ?></span></a>
      <?php endforeach; ?>
    </div>

    <?php if ($list['rows']): ?>
      <div class="table-wrap">
        <table class="table" data-no-search>
          <thead>
            <tr>
              <?= adminSortLink('pooja_date', 'Date', $query) ?>
              <?= adminSortLink('name_en', 'Pooja', $query) ?>
              <?= adminSortLink('pooja_type', 'Type', $query) ?>
              <th scope="col" class="num">Sponsors</th>
              <th scope="col">Status</th>
              <th scope="col" class="cell-actions"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <?php foreach ($list['rows'] as $row): $rid = (int) $row['id']; $when_txt = $relDay($row['pooja_date']); ?>
              <tr>
                <td>
                  <time class="cell-title" datetime="<?= h($row['pooja_date']) ?>"><?= adminFmtDate($row['pooja_date']) ?></time>
                  <span class="cell-sub"><?= $row['pooja_time'] !== null && $row['pooja_time'] !== '' ? h($row['pooja_time']) . ' · ' : '' ?><?= h($when_txt) ?></span>
                </td>
                <td>
                  <span class="cell-title" lang="ta"><?= h($row['name_ta']) ?></span>
                  <span class="cell-sub"><?= h($row['name_en']) ?></span>
                </td>
                <td><?= adminBadge($typeEnglish[$row['pooja_type']] ?? $row['pooja_type'], $typeTones[$row['pooja_type']] ?? '') ?></td>
                <td class="num">
                  <?php if ((int) $row['sponsor_count'] > 0): ?>
                    <a href="/admin/sponsors.php?pooja=<?= $rid ?>" data-tip="View sponsors"><?= (int) $row['sponsor_count'] ?></a>
                  <?php else: ?>
                    <span class="text-muted">—</span>
                  <?php endif; ?>
                </td>
                <td><?= $row['is_active'] ? adminBadge('Active', 'success') : adminBadge('Hidden', 'muted') ?></td>
                <td class="cell-actions">
                  <?= adminMenu([
                      ['label' => 'Edit', 'icon' => 'pencil', 'href' => '/admin/poojas.php' . adminQuery($query, ['edit' => $rid]) . '#new'],
                      ['label' => $row['is_active'] ? 'Hide from website' : 'Show on website', 'icon' => $row['is_active'] ? 'eye-off' : 'eye', 'form' => ['action' => 'toggle', 'id' => $rid], 'action' => $listUrl],
                      ['label' => 'Sponsors', 'icon' => 'heart-hands', 'href' => '/admin/sponsors.php?pooja=' . $rid],
                      'divider',
                      ['label' => 'Delete', 'icon' => 'trash', 'danger' => true, 'form' => ['action' => 'delete', 'id' => $rid], 'action' => $listUrl,
                       'confirm' => 'Delete "' . $row['name_en'] . '" on ' . adminFmtDate($row['pooja_date']) . '? Linked sponsors are kept but unlinked.'],
                  ], 'Actions for ' . $row['name_en']) ?>
                </td>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      </div>
      <?= adminPagination($list['page'], $list['pages'], $query, $list['total'], $perPage) ?>
    <?php elseif ($hasFilters): ?>
      <?= adminEmpty('filter', $when === 'upcoming' && $type === '' && $q === '' ? 'No upcoming poojas' : 'No poojas match these filters',
          'Try another type, clear the search, or show all dates.',
          '<a href="/admin/poojas.php?when=all" class="btn btn--sm">' . adminIcon('layers') . ' Show all poojas</a>' .
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' Add pooja</a>') ?>
    <?php else: ?>
      <?= adminEmpty('flame', 'No poojas scheduled yet', 'Add the first Pournami or Amavasai pooja with the form, or import a CSV of dates.',
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' Add pooja</a>' .
          '<a href="/admin/bulk_upload.php?entity=poojas" class="btn btn--sm">' . adminIcon('upload') . ' Import CSV</a>') ?>
    <?php endif; ?>
  </div>

</div>
<?php adminFooter(); ?>
