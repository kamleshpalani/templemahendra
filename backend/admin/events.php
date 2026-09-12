<?php
// backend/admin/events.php — Events: festivals and temple events shown on the public site.
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
$filters       = ['upcoming' => 'Upcoming', 'past' => 'Past', 'all' => 'All'];
$defaultFilter = 'upcoming';
$filter        = isset($filters[$str($_GET, 'f')]) ? $str($_GET, 'f') : $defaultFilter;
$q             = mb_substr(trim($str($_GET, 'q')), 0, 100);
$query         = ['f' => $filter === $defaultFilter ? '' : $filter, 'q' => $q];
$listUrl       = static fn(array $override = []): string => '/admin/events.php' . rtrim(adminQuery($query, $override), '?');

// ── Create / update / delete ─────────────────────────────────────────────────
$editing = null; // row shown in the form: from ?edit=ID, or the submitted values after a validation error
$errors  = [];   // field => true when server-side validation failed

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $msg    = adminCsrfGuard();
    $action = $str($_POST, 'action');
    $backF  = $str($_POST, 'f');
    $back   = '/admin/events.php' . (isset($filters[$backF]) && $backF !== $defaultFilter ? '?f=' . $backF : '');

    if ($msg === '' && $action === 'save') {
        $title_ta   = sanitizeText($str($_POST, 'title_ta'));
        $title_en   = sanitizeText($str($_POST, 'title_en'));
        $desc       = sanitizeText($str($_POST, 'description'), 2000);
        $event_date = $str($_POST, 'event_date');
        $active     = isset($_POST['is_active']) ? 1 : 0;
        $id         = (int) $str($_POST, 'id');

        if ($title_ta === '')                                     $errors['title_ta']   = true;
        if ($title_en === '')                                     $errors['title_en']   = true;
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $event_date))    $errors['event_date'] = true;

        if ($errors) {
            $msg     = '<p class="alert alert--error">All fields are required and date must be YYYY-MM-DD.</p>';
            $editing = ['id' => $id, 'title_ta' => $title_ta, 'title_en' => $title_en, 'description' => $desc, 'event_date' => $event_date, 'is_active' => $active];
        } else {
            if ($id > 0) {
                $db->prepare('UPDATE events SET title_ta=:ta,title_en=:en,description=:d,event_date=:dt,is_active=:a WHERE id=:id')
                   ->execute([':ta' => $title_ta, ':en' => $title_en, ':d' => $desc, ':dt' => $event_date, ':a' => $active, ':id' => $id]);
                $_SESSION['flash'] = '<p class="alert alert--success">Updated.</p>';
            } else {
                $db->prepare('INSERT INTO events (title_ta,title_en,description,event_date,is_active) VALUES (:ta,:en,:d,:dt,:a)')
                   ->execute([':ta' => $title_ta, ':en' => $title_en, ':d' => $desc, ':dt' => $event_date, ':a' => $active]);
                $_SESSION['flash'] = '<p class="alert alert--success">Created.</p>';
            }
            header('Location: ' . $back, true, 303);
            exit;
        }
    } elseif ($msg === '' && $action === 'delete') {
        $id = (int) $str($_POST, 'id');
        if ($id > 0) {
            $db->prepare('DELETE FROM events WHERE id=:id')->execute([':id' => $id]);
            $_SESSION['flash'] = '<p class="alert alert--success">Deleted.</p>';
        }
        header('Location: ' . $back, true, 303);
        exit;
    }
}

// ── Row being edited (?edit=ID) ──────────────────────────────────────────────
if ($editing === null && isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM events WHERE id=:id');
    $stmt->execute([':id' => (int) $str($_GET, 'edit')]);
    $editing = $stmt->fetch() ?: null;
    if ($editing === null && $msg === '') {
        $msg = '<p class="alert alert--warning">That event no longer exists.</p>';
    }
}
$isEdit   = !empty($editing['id']);
$formOpen = $editing !== null;

// ── List ─────────────────────────────────────────────────────────────────────
$today  = (string) $db->query('SELECT CURDATE()')->fetchColumn(); // DB clock, so badges match the filter
$cap    = 500;
$where  = [];
$params = [];
switch ($filter) {
    case 'upcoming': $where[] = 'event_date >= :today'; $params[':today'] = $today; break;
    case 'past':     $where[] = 'event_date < :today';  $params[':today'] = $today; break;
}
if ($q !== '') {
    $like    = '%' . addcslashes($q, '%_\\') . '%';
    $where[] = '(title_en LIKE :q1 OR title_ta LIKE :q2 OR description LIKE :q3)';
    $params += [':q1' => $like, ':q2' => $like, ':q3' => $like];
}
$stmt = $db->prepare('SELECT * FROM events' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY event_date ASC LIMIT ' . ($cap + 1));
$stmt->execute($params);
$rows   = $stmt->fetchAll();
$capped = count($rows) > $cap;
if ($capped) $rows = array_slice($rows, 0, $cap);

$c = $db->query('SELECT COUNT(*) AS total,
                        COALESCE(SUM(event_date >= CURDATE()), 0) AS upcoming,
                        COALESCE(SUM(event_date < CURDATE()), 0)  AS past
                   FROM events')->fetch();
$chipCounts = ['upcoming' => (int) $c['upcoming'], 'past' => (int) $c['past'], 'all' => (int) $c['total']];

$shown      = count($rows);
$filtered   = $filter !== 'all' || $q !== '';
$countLabel = $filtered ? "$shown of {$chipCounts['all']} records" : "$shown record" . ($shown === 1 ? '' : 's');
if ($capped) $countLabel .= " · showing the first $cap";

$invalid    = static fn(string $f): string => isset($errors[$f]) ? ' aria-invalid="true" aria-describedby="err-' . $f . '"' : '';
$fieldError = static fn(string $f, string $text): string => isset($errors[$f]) ? '<span class="field__error" id="err-' . $f . '">' . adminIcon('alert-circle') . h($text) . '</span>' : '';

// ── Page ─────────────────────────────────────────────────────────────────────
adminHeader('Events', 'Worship', [
    'actions' => '<a href="/events" target="_blank" rel="noopener" class="btn btn-ghost btn--sm">' . adminIcon('external') . 'View on site</a>',
]);
echo $msg;
echo adminPageIntro(
    'Festivals and temple events listed on the public Events page — upcoming ones are also highlighted on the homepage, and past events stay in the archive.',
    '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="crud" aria-expanded="false">' . adminIcon('plus') . ' New event</button>'
    . '<a href="/admin/bulk_upload.php?entity=events" class="btn btn--sm">' . adminIcon('upload') . ' Import CSV / Excel</a>'
);
?>

<div class="admin-two-col admin-two-col--collapsible" id="crud" data-editing="<?= $formOpen ? '1' : '0' ?>">

  <section class="card card--solid card--static admin-form-box" id="new" aria-labelledby="form-title">
    <h2 id="form-title"><?= adminIcon($isEdit ? 'pencil' : 'plus') ?> <?= $isEdit ? 'Edit event' : 'New event' ?></h2>
    <form method="POST" action="/admin/events.php">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save" />
      <input type="hidden" name="f" value="<?= h($filter) ?>" />
      <?php if ($isEdit): ?><input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" /><?php endif; ?>

      <label for="title_en">
        <span class="field__label">English title <span class="field__required" aria-hidden="true">*</span></span>
        <input id="title_en" name="title_en" type="text" required aria-required="true" maxlength="300" autocomplete="off"
               placeholder="e.g. Thai Poosam" value="<?= h($editing['title_en'] ?? '') ?>"<?= $invalid('title_en') ?> />
        <?= $fieldError('title_en', 'English title is required.') ?>
      </label>

      <label for="title_ta">
        <span class="field__label">Tamil title <span class="field__required" aria-hidden="true">*</span></span>
        <input id="title_ta" name="title_ta" type="text" lang="ta" required aria-required="true" maxlength="300" autocomplete="off"
               placeholder="எ.கா. தைப்பூசம்" value="<?= h($editing['title_ta'] ?? '') ?>"<?= $invalid('title_ta') ?> />
        <?= $fieldError('title_ta', 'Tamil title is required.') ?>
      </label>

      <label for="event_date">
        <span class="field__label">Event date <span class="field__required" aria-hidden="true">*</span></span>
        <input id="event_date" name="event_date" type="date" required aria-required="true"
               value="<?= h($editing['event_date'] ?? '') ?>"<?= $invalid('event_date') ?> />
        <?= $fieldError('event_date', 'Enter a valid date (YYYY-MM-DD).') ?>
        <span class="field__hint">Events on or after today appear as upcoming.</span>
      </label>

      <label for="description">
        <span class="field__label">Description <span class="field__optional">optional</span></span>
        <textarea id="description" name="description" rows="4" maxlength="2000" data-counter><?= h($editing['description'] ?? '') ?></textarea>
        <span class="field__hint">Programme details, timings or special poojas for the day.</span>
      </label>

      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= (!$editing || !empty($editing['is_active'])) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Active</strong><span class="switch__desc">Visible on the public site. Hidden events stay saved.</span></span>
      </label>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> <?= $isEdit ? 'Save changes' : 'Save event' ?></button>
        <?php if ($formOpen): ?><a href="<?= h($listUrl()) ?>" class="btn btn-ghost">Cancel</a><?php endif; ?>
      </div>
    </form>
  </section>

  <div class="admin-list">
    <form method="GET" action="/admin/events.php" class="toolbar" role="search">
      <?php if ($filter !== $defaultFilter): ?><input type="hidden" name="f" value="<?= h($filter) ?>" /><?php endif; ?>
      <div class="toolbar__search">
        <?= adminIcon('search') ?>
        <label for="q" class="sr-only">Search events</label>
        <input id="q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search by title or description…" autocomplete="off" />
        <button type="submit" class="sr-only">Search</button>
      </div>
      <nav class="filter-chips" aria-label="Filter events">
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
            <th scope="col">Event</th>
            <th scope="col">Date</th>
            <th scope="col">Status</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($rows as $row): $rid = (int) $row['id']; $isPast = $row['event_date'] < $today; ?>
          <tr>
            <td>
              <span class="cell-title"><?= h($row['title_en']) ?></span>
              <span class="cell-sub" lang="ta"><?= h($row['title_ta']) ?></span>
            </td>
            <td class="cell-date"><time datetime="<?= h($row['event_date']) ?>"><?= adminFmtDate($row['event_date']) ?></time></td>
            <td>
              <span class="cluster">
                <?= $isPast ? adminBadge('Past', 'muted') : adminBadge($row['event_date'] === $today ? 'Today' : 'Upcoming', 'info') ?>
                <?= $row['is_active'] ? adminBadge('Active', 'success') : adminBadge('Hidden', 'muted') ?>
              </span>
            </td>
            <td class="cell-actions">
              <?= adminMenu([
                  ['label' => 'Edit', 'icon' => 'pencil', 'href' => $listUrl(['edit' => $rid])],
                  'divider',
                  ['label' => 'Delete', 'icon' => 'trash', 'danger' => true,
                   'form' => ['action' => 'delete', 'id' => $rid, 'f' => $filter],
                   'confirm' => 'Delete “' . $row['title_en'] . '”? This cannot be undone.'],
              ], 'Actions for ' . $row['title_en']) ?>
            </td>
          </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>
    <?php if ($capped): ?>
      <p class="field__hint mt-2">Only the first <?= $cap ?> events are listed. Use search or a filter to narrow the list.</p>
    <?php endif; ?>
    <?php elseif ($q !== '' || $filter === 'past'): ?>
      <?= adminEmpty('search', 'No events match', 'Try a different search term or filter.',
          '<a href="/admin/events.php?f=all" class="btn btn--sm">' . adminIcon('x') . ' Show all events</a>') ?>
    <?php elseif ($filter === 'upcoming' && $chipCounts['all'] > 0): ?>
      <?= adminEmpty('calendar', 'Nothing scheduled', 'There are no upcoming events. Add one to show it on the website.',
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' New event</a>'
          . '<a href="/admin/events.php?f=past" class="btn btn--sm">' . adminIcon('clock') . ' View past events</a>') ?>
    <?php else: ?>
      <?= adminEmpty('calendar', 'No events yet', 'Create your first festival or temple event, or import a list from a spreadsheet.',
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' New event</a>'
          . '<a href="/admin/bulk_upload.php?entity=events" class="btn btn--sm">' . adminIcon('upload') . ' Import CSV / Excel</a>') ?>
    <?php endif; ?>
  </div>

</div>

<?php adminFooter(); ?>
