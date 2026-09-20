<?php
// backend/admin/calendar_entries.php — Temple Calendar: the committee's own
// entries on the public Panchangam calendar (brief §6 "Temple Calendar").
// Rows live in `calendar_entries` (migration 018) and are merged into
// /api/calendar: an "add" entry marks a date (or a span of dates) with a
// festival, pooja, holiday or any special day; a "hide" entry removes a
// computed observance (Pournami, Pradosham, …) on a date the temple does not
// follow the formula. Entries are shown / hidden with is_active.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/calendar_entries.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

/** String value from a request array ('' when missing or not scalar). */
$str = static fn(array $src, string $key): string => is_scalar($src[$key] ?? null) ? (string) $src[$key] : '';

if (!calendarEntriesTableExists()) {
    adminHeader('Temple Calendar', 'Worship');
    echo '<p class="alert alert--warning" role="alert">Calendar entries are not installed on this site yet: apply database migration <code>018_calendar_entries.sql</code> and reload.</p>';
    adminFooter();
    exit;
}

/** A well-formed calendar date (Y-m-d) or null. */
$validDate = static function (string $s): ?string {
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $s)) return null;
    $d = DateTimeImmutable::createFromFormat('!Y-m-d', $s);
    return $d && $d->format('Y-m-d') === $s && $d->format('Y') >= 2020 && $d->format('Y') <= 2035 ? $s : null;
};

// ── Flash left by the previous request (POST → 303 → GET) ────────────────────
$msg = '';
if (!empty($_SESSION['flash'])) {
    $msg = (string) $_SESSION['flash'];
    unset($_SESSION['flash']);
}

$filters       = ['upcoming' => 'Upcoming', 'past' => 'Past', 'hidden' => 'Hidden', 'suppress' => 'Suppressions', 'all' => 'All'];
$defaultFilter = 'upcoming';
$src           = $_SERVER['REQUEST_METHOD'] === 'POST' ? $_POST : $_GET;
$filter        = isset($filters[$str($src, 'f')]) ? $str($src, 'f') : $defaultFilter;
$query         = ['f' => $filter === $defaultFilter ? '' : $filter];
$listUrl       = static fn(array $override = []): string => '/admin/calendar_entries.php' . rtrim(adminQuery($query, $override), '?');

$editing = null;
$errors  = [];

$fromPost = static fn(): array => [
    'id'             => (int) $str($_POST, 'id'),
    'mode'           => $str($_POST, 'mode') === 'hide' ? 'hide' : 'add',
    'entry_type'     => $str($_POST, 'entry_type'),
    'entry_date'     => $str($_POST, 'entry_date'),
    'end_date'       => $str($_POST, 'end_date'),
    'title_ta'       => $str($_POST, 'title_ta'),
    'title_en'       => $str($_POST, 'title_en'),
    'description_ta' => $str($_POST, 'description_ta'),
    'description_en' => $str($_POST, 'description_en'),
    'pooja_id'       => $str($_POST, 'pooja_id'),
    'event_id'       => $str($_POST, 'event_id'),
    'sort_order'     => $str($_POST, 'sort_order'),
    'is_active'      => isset($_POST['is_active']) ? 1 : 0,
];

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $msg    = adminCsrfGuard();
    $action = $str($_POST, 'action');
    $back   = $listUrl();

    if ($msg !== '' && $action === 'save') $editing = $fromPost();

    if ($msg === '' && $action === 'save') {
        $id      = (int) $str($_POST, 'id');
        $mode    = $str($_POST, 'mode') === 'hide' ? 'hide' : 'add';
        $type    = $str($_POST, 'entry_type');
        $date    = $validDate(trim($str($_POST, 'entry_date')));
        $endRaw  = trim($str($_POST, 'end_date'));
        $end     = $endRaw === '' ? null : $validDate($endRaw);
        $titleTa = sanitizeText($str($_POST, 'title_ta'), 300);
        $titleEn = sanitizeText($str($_POST, 'title_en'), 300);
        $descTa  = sanitizeText($str($_POST, 'description_ta'), 5000);
        $descEn  = sanitizeText($str($_POST, 'description_en'), 5000);
        $poojaRaw = $str($_POST, 'pooja_id');
        $eventRaw = $str($_POST, 'event_id');
        $order   = $str($_POST, 'sort_order');
        $active  = isset($_POST['is_active']) ? 1 : 0;

        if (!in_array($type, $mode === 'hide' ? CALENDAR_HIDE_TYPES : CALENDAR_ADD_TYPES, true)) $errors['entry_type'] = true;
        if ($date === null) $errors['entry_date'] = true;
        if ($endRaw !== '' && ($end === null || ($date !== null && $end < $date))) $errors['end_date'] = true;
        if ($mode === 'add') {
            if ($titleTa === '') $errors['title_ta'] = true;
            if ($titleEn === '') $errors['title_en'] = true;
        } else {
            $descTa = $descEn = '';
            $poojaRaw = $eventRaw = '';
        }
        if ($order !== '' && !preg_match('/^-?[0-9]{1,6}$/', $order)) $errors['sort_order'] = true;

        $poojaId = null;
        if ($poojaRaw !== '') {
            if (!ctype_digit($poojaRaw)) {
                $errors['pooja_id'] = true;
            } else {
                $stmt = $db->prepare('SELECT id FROM poojas WHERE id = :id');
                $stmt->execute([':id' => (int) $poojaRaw]);
                $poojaId = $stmt->fetchColumn() ? (int) $poojaRaw : null;
                if ($poojaId === null) $errors['pooja_id'] = true;
            }
        }
        $eventId = null;
        if ($eventRaw !== '') {
            if (!ctype_digit($eventRaw)) {
                $errors['event_id'] = true;
            } else {
                $stmt = $db->prepare('SELECT id FROM events WHERE id = :id');
                $stmt->execute([':id' => (int) $eventRaw]);
                $eventId = $stmt->fetchColumn() ? (int) $eventRaw : null;
                if ($eventId === null) $errors['event_id'] = true;
            }
        }

        $current = null;
        if ($id > 0 && !$errors) {
            $stmt = $db->prepare('SELECT * FROM calendar_entries WHERE id = :id');
            $stmt->execute([':id' => $id]);
            $current = $stmt->fetch() ?: null;
            if ($current === null) $errors['id'] = true;
        }

        if ($errors) {
            $msg = '<p class="alert alert--error" role="alert">' . h(isset($errors['id']) ? 'That entry no longer exists.' : 'Please fix the highlighted fields.') . '</p>';
            $editing = $fromPost();
        } else {
            $params = [
                ':mode' => $mode, ':type' => $type, ':d' => $date, ':e' => $end,
                ':ta' => $titleTa, ':en' => $titleEn,
                ':dta' => $descTa !== '' ? $descTa : null, ':den' => $descEn !== '' ? $descEn : null,
                ':p' => $poojaId, ':ev' => $eventId, ':o' => $order === '' ? 0 : (int) $order, ':a' => $active,
            ];
            $label = $mode === 'add' ? $titleEn : 'hide ' . $type . ' on ' . $date;
            if ($current) {
                $params[':id'] = $id;
                $db->prepare('UPDATE calendar_entries SET mode=:mode, entry_type=:type, entry_date=:d, end_date=:e, title_ta=:ta, title_en=:en,
                                 description_ta=:dta, description_en=:den, pooja_id=:p, event_id=:ev, sort_order=:o, is_active=:a WHERE id=:id')->execute($params);
                adminAudit('calendar_entry_updated', 'calendar_entry:' . $id, $label);
                $_SESSION['flash'] = '<p class="alert alert--success" role="status">Updated.</p>';
            } else {
                $db->prepare('INSERT INTO calendar_entries (mode, entry_type, entry_date, end_date, title_ta, title_en, description_ta, description_en, pooja_id, event_id, sort_order, is_active)
                              VALUES (:mode, :type, :d, :e, :ta, :en, :dta, :den, :p, :ev, :o, :a)')->execute($params);
                adminAudit('calendar_entry_created', 'calendar_entry:' . (int) $db->lastInsertId(), $label);
                $_SESSION['flash'] = '<p class="alert alert--success" role="status">Created.</p>';
            }
            header('Location: ' . $back, true, 303);
            exit;
        }
    } elseif ($msg === '' && $action === 'toggle') {
        $id   = (int) $str($_POST, 'id');
        $stmt = $db->prepare('UPDATE calendar_entries SET is_active = 1 - is_active WHERE id = :id');
        $stmt->execute([':id' => $id]);
        if ($stmt->rowCount()) {
            adminAudit('calendar_entry_toggled', 'calendar_entry:' . $id);
            $_SESSION['flash'] = '<p class="alert alert--success" role="status">Visibility changed.</p>';
        }
        header('Location: ' . $back, true, 303);
        exit;
    } elseif ($msg === '' && $action === 'delete') {
        $id   = (int) $str($_POST, 'id');
        $stmt = $db->prepare('SELECT title_en, mode, entry_type, entry_date FROM calendar_entries WHERE id = :id');
        $stmt->execute([':id' => $id]);
        if ($row = $stmt->fetch()) {
            $db->prepare('DELETE FROM calendar_entries WHERE id = :id')->execute([':id' => $id]);
            adminAudit('calendar_entry_deleted', 'calendar_entry:' . $id, $row['mode'] === 'add' ? (string) $row['title_en'] : 'hide ' . $row['entry_type'] . ' on ' . $row['entry_date']);
            $_SESSION['flash'] = '<p class="alert alert--success" role="status">Deleted.</p>';
        }
        header('Location: ' . $back, true, 303);
        exit;
    }
}

if ($editing === null && isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM calendar_entries WHERE id = :id');
    $stmt->execute([':id' => (int) $str($_GET, 'edit')]);
    $editing = $stmt->fetch() ?: null;
    if ($editing === null && $msg === '') $msg = '<p class="alert alert--warning" role="alert">That entry no longer exists.</p>';
}
if ($editing === null && isset($_GET['new'])) {
    $editing = ['mode' => $str($_GET, 'new') === 'hide' ? 'hide' : 'add', 'entry_type' => $str($_GET, 'new') === 'hide' ? 'pournami' : 'festival',
                'entry_date' => $validDate($str($_GET, 'date')) ?? '', 'is_active' => 1];
}
$isEdit   = !empty($editing['id']);
$formOpen = $editing !== null;
$formMode = ($editing['mode'] ?? 'add') === 'hide' ? 'hide' : 'add';

// ── Pickers ──────────────────────────────────────────────────────────────────
$poojas = $db->query('SELECT id, name_en, pooja_date FROM poojas ORDER BY pooja_date DESC, id DESC LIMIT 300')->fetchAll();
$events = $db->query('SELECT id, title_en, event_date FROM events ORDER BY event_date DESC, id DESC LIMIT 300')->fetchAll();

// ── List ─────────────────────────────────────────────────────────────────────
$today = (new DateTime('now', new DateTimeZone('Asia/Kolkata')))->format('Y-m-d');
$where = ['1=1'];
$params = [];
switch ($filter) {
    case 'upcoming': $where[] = 'COALESCE(c.end_date, c.entry_date) >= :today'; $where[] = 'c.is_active = 1'; $params[':today'] = $today; break;
    case 'past':     $where[] = 'COALESCE(c.end_date, c.entry_date) < :today'; $params[':today'] = $today; break;
    case 'hidden':   $where[] = 'c.is_active = 0'; break;
    case 'suppress': $where[] = "c.mode = 'hide'"; break;
}
$order = $filter === 'past' ? 'c.entry_date DESC, c.sort_order ASC, c.id DESC' : 'c.entry_date ASC, c.sort_order ASC, c.id ASC';
$stmt = $db->prepare('SELECT c.*, p.name_en AS pooja_name, e.title_en AS event_name
                        FROM calendar_entries c
                        LEFT JOIN poojas p ON p.id = c.pooja_id
                        LEFT JOIN events e ON e.id = c.event_id
                       WHERE ' . implode(' AND ', $where) . " ORDER BY $order LIMIT 300");
$stmt->execute($params);
$rows = $stmt->fetchAll();

$c = $db->prepare('SELECT COUNT(*) AS total,
                          COALESCE(SUM(is_active = 1 AND COALESCE(end_date, entry_date) >= :t1), 0) AS upcoming,
                          COALESCE(SUM(COALESCE(end_date, entry_date) < :t2), 0) AS past,
                          COALESCE(SUM(is_active = 0), 0) AS hidden,
                          COALESCE(SUM(mode = \'hide\'), 0) AS suppress
                     FROM calendar_entries');
$c->execute([':t1' => $today, ':t2' => $today]);
$c = $c->fetch();
$chipCounts = ['upcoming' => (int) $c['upcoming'], 'past' => (int) $c['past'], 'hidden' => (int) $c['hidden'], 'suppress' => (int) $c['suppress'], 'all' => (int) $c['total']];
$shown      = count($rows);
$countLabel = $filter !== 'all' ? "$shown of {$chipCounts['all']} entries" : "$shown entr" . ($shown === 1 ? 'y' : 'ies');

$invalid    = static fn(string $f): string => isset($errors[$f]) ? ' aria-invalid="true" aria-describedby="err-' . $f . '"' : '';
$fieldError = static fn(string $f, string $text): string => isset($errors[$f]) ? '<span class="field__error" id="err-' . $f . '">' . adminIcon('alert-circle') . h($text) . '</span>' : '';
$typeLabel  = static fn(string $t): string => CALENDAR_TYPE_LABELS[$t]['en'] ?? $t;

adminHeader('Temple Calendar', 'Worship', [
    'actions' => '<a href="/panchangam" target="_blank" rel="noopener" class="btn btn-ghost btn--sm">' . adminIcon('external') . 'View on site</a>',
]);
echo $msg;
echo adminPageIntro(
    'Your own entries on the public Panchangam calendar. Pournami, Amavasai, Ekadasi, Sashti, Pradosham and Chaturthi are computed from the moon; add festivals, poojas, holidays and special days here, or suppress a computed observance on a day the temple does not follow the formula. Hidden entries stay saved but are not applied.',
    '<a href="' . h($listUrl(['new' => 'add'])) . '#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' New entry</a>'
    . ' <a href="' . h($listUrl(['new' => 'hide'])) . '#new" class="btn btn-ghost btn--sm">' . adminIcon('eye-off') . ' Suppress an observance</a>'
);
?>

<div class="admin-two-col admin-two-col--collapsible" id="crud" data-editing="<?= $formOpen ? '1' : '0' ?>">

  <section class="card card--solid card--static admin-form-box" id="new" aria-labelledby="form-title">
    <h2 id="form-title"><?= adminIcon($isEdit ? 'pencil' : 'calendar') ?> <?= $isEdit ? 'Edit entry' : ($formMode === 'hide' ? 'Suppress a computed observance' : 'New calendar entry') ?></h2>
    <form method="POST" action="/admin/calendar_entries.php">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save" />
      <input type="hidden" name="f" value="<?= h($filter) ?>" />
      <input type="hidden" name="mode" value="<?= h($formMode) ?>" />
      <?php if ($isEdit): ?><input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" /><?php endif; ?>

      <?php if ($formMode === 'hide'): ?>
        <p class="field__hint">On the chosen day (or span of days) the selected computed observance is removed from the public calendar and from the homepage Pournami countdown. Your own entries on that day are kept.</p>
      <?php endif; ?>

      <label for="entry_type">
        <span class="field__label"><?= $formMode === 'hide' ? 'Observance to suppress' : 'Type' ?> <span class="field__required" aria-hidden="true">*</span></span>
        <select id="entry_type" name="entry_type" required<?= $invalid('entry_type') ?>>
          <?php foreach ($formMode === 'hide' ? CALENDAR_HIDE_TYPES : CALENDAR_ADD_TYPES as $t): ?>
            <option value="<?= h($t) ?>"<?= ($editing['entry_type'] ?? '') === $t ? ' selected' : '' ?>><?= h($typeLabel($t)) ?></option>
          <?php endforeach; ?>
        </select>
        <?= $fieldError('entry_type', 'Choose a type.') ?>
        <?php if ($formMode === 'add'): ?><span class="field__hint">Chooses the badge colour and glyph on the calendar.</span><?php endif; ?>
      </label>

      <div class="form-grid">
        <label for="entry_date">
          <span class="field__label"><?= $formMode === 'hide' ? 'Date' : 'Start date' ?> <span class="field__required" aria-hidden="true">*</span></span>
          <input id="entry_date" name="entry_date" type="date" required aria-required="true" min="2020-01-01" max="2035-12-31"
                 value="<?= h($editing['entry_date'] ?? '') ?>"<?= $invalid('entry_date') ?> />
          <?= $fieldError('entry_date', 'Enter a valid date between 2020 and 2035.') ?>
        </label>
        <label for="end_date">
          <span class="field__label">End date <span class="field__optional">optional</span></span>
          <input id="end_date" name="end_date" type="date" min="2020-01-01" max="2035-12-31"
                 value="<?= h($editing['end_date'] ?? '') ?>"<?= $invalid('end_date') ?> />
          <?= $fieldError('end_date', 'The end date must be a valid date on or after the start date.') ?>
          <span class="field__hint">Leave blank for a single day.</span>
        </label>
      </div>

      <?php if ($formMode === 'add'): ?>
      <label for="title_ta">
        <span class="field__label">Title (Tamil) <span class="field__required" aria-hidden="true">*</span></span>
        <input id="title_ta" name="title_ta" type="text" required aria-required="true" maxlength="300" lang="ta" autocomplete="off"
               placeholder="நவராத்திரி" value="<?= h($editing['title_ta'] ?? '') ?>"<?= $invalid('title_ta') ?> />
        <?= $fieldError('title_ta', 'The Tamil title is required.') ?>
      </label>

      <label for="title_en">
        <span class="field__label">Title (English) <span class="field__required" aria-hidden="true">*</span></span>
        <input id="title_en" name="title_en" type="text" required aria-required="true" maxlength="300" autocomplete="off"
               placeholder="Navaratri" value="<?= h($editing['title_en'] ?? '') ?>"<?= $invalid('title_en') ?> />
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

      <div class="form-grid">
        <label for="pooja_id">
          <span class="field__label">Linked pooja <span class="field__optional">optional</span></span>
          <select id="pooja_id" name="pooja_id"<?= $invalid('pooja_id') ?>>
            <option value="">— none —</option>
            <?php foreach ($poojas as $p): ?>
              <option value="<?= (int) $p['id'] ?>"<?= (string) ($editing['pooja_id'] ?? '') === (string) $p['id'] ? ' selected' : '' ?>><?= h($p['name_en']) ?> · <?= h($p['pooja_date']) ?></option>
            <?php endforeach; ?>
          </select>
          <?= $fieldError('pooja_id', 'Choose a pooja from the list.') ?>
        </label>
        <label for="event_id">
          <span class="field__label">Linked event <span class="field__optional">optional</span></span>
          <select id="event_id" name="event_id"<?= $invalid('event_id') ?>>
            <option value="">— none —</option>
            <?php foreach ($events as $e): ?>
              <option value="<?= (int) $e['id'] ?>"<?= (string) ($editing['event_id'] ?? '') === (string) $e['id'] ? ' selected' : '' ?>><?= h($e['title_en']) ?> · <?= h($e['event_date']) ?></option>
            <?php endforeach; ?>
          </select>
          <?= $fieldError('event_id', 'Choose an event from the list.') ?>
        </label>
      </div>

      <label for="sort_order">
        <span class="field__label">Order within the day</span>
        <input id="sort_order" name="sort_order" type="number" inputmode="numeric" min="-999999" max="999999" step="1"
               value="<?= h((string) ($editing['sort_order'] ?? '0')) ?>"<?= $invalid('sort_order') ?> />
        <?= $fieldError('sort_order', 'Order must be a whole number.') ?>
        <span class="field__hint">Smaller numbers come first when a day has several entries.</span>
      </label>
      <?php endif; ?>

      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= (!$editing || !empty($editing['is_active'])) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Applied</strong><span class="switch__desc"><?= $formMode === 'hide' ? 'The observance is removed from the public calendar on this day.' : 'Shown on the public calendar and in Upcoming Special Days.' ?></span></span>
      </label>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> <?= $isEdit ? 'Save changes' : ($formMode === 'hide' ? 'Suppress' : 'Add entry') ?></button>
        <?php if ($formOpen): ?><a href="<?= h($listUrl()) ?>" class="btn btn-ghost">Cancel</a><?php endif; ?>
      </div>
    </form>
  </section>

  <div class="admin-list">
    <div class="toolbar">
      <nav class="filter-chips" aria-label="Filter calendar entries">
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
            <th scope="col">Date</th>
            <th scope="col">Entry</th>
            <th scope="col">Type</th>
            <th scope="col">Links</th>
            <th scope="col">Status</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($rows as $row): $rid = (int) $row['id']; $isHide = $row['mode'] === 'hide'; ?>
          <tr>
            <td class="cell-num">
              <?= h($row['entry_date']) ?>
              <?php if ($row['end_date'] !== null): ?><span class="cell-muted">→ <?= h($row['end_date']) ?></span><?php endif; ?>
            </td>
            <td>
              <?php if ($isHide): ?>
                <span class="cell-title"><?= adminIcon('eye-off') ?> Suppress <?= h($typeLabel($row['entry_type'])) ?></span>
                <span class="cell-muted">Computed observance removed on this day</span>
              <?php else: ?>
                <span class="cell-title" lang="ta"><?= h($row['title_ta']) ?></span>
                <span class="cell-muted"><?= h($row['title_en']) ?></span>
              <?php endif; ?>
            </td>
            <td><?= $isHide ? adminBadge('Suppression', 'warning') : adminBadge($typeLabel($row['entry_type'])) ?></td>
            <td>
              <?php if ($row['pooja_name'] !== null): ?><span class="cell-muted"><?= adminIcon('flame') ?> <?= h($row['pooja_name']) ?></span><?php endif; ?>
              <?php if ($row['event_name'] !== null): ?><span class="cell-muted"><?= adminIcon('calendar') ?> <?= h($row['event_name']) ?></span><?php endif; ?>
              <?php if ($row['pooja_name'] === null && $row['event_name'] === null): ?><span class="cell-muted">—</span><?php endif; ?>
            </td>
            <td><?= $row['is_active'] ? adminBadge('Applied', 'success') : adminBadge('Hidden', 'muted') ?></td>
            <td class="cell-actions">
              <?= adminMenu([
                  ['label' => 'Edit', 'icon' => 'pencil', 'href' => $listUrl(['edit' => $rid])],
                  ['label' => $row['is_active'] ? 'Hide' : 'Apply', 'icon' => $row['is_active'] ? 'eye-off' : 'eye',
                   'form' => ['action' => 'toggle', 'id' => $rid, 'f' => $filter]],
                  'divider',
                  ['label' => 'Delete', 'icon' => 'trash', 'danger' => true,
                   'form' => ['action' => 'delete', 'id' => $rid, 'f' => $filter],
                   'confirm' => 'Delete this ' . ($isHide ? 'suppression' : 'entry “' . $row['title_en'] . '”') . '? This cannot be undone.'],
              ], 'Actions for ' . ($isHide ? 'suppression on ' . $row['entry_date'] : $row['title_en'])) ?>
            </td>
          </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>
    <?php elseif ($filter !== 'all' && $chipCounts['all'] > 0): ?>
      <?= adminEmpty('search', 'No entries match', 'Try another filter.',
          '<a href="' . h($listUrl(['f' => 'all'])) . '" class="btn btn--sm">' . adminIcon('x') . ' Show all</a>') ?>
    <?php else: ?>
      <?= adminEmpty('calendar', 'No calendar entries yet', 'Add the temple’s festivals, poojas and holidays and they appear on the public Panchangam calendar alongside the computed observances.',
          '<a href="' . h($listUrl(['new' => 'add'])) . '#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' New entry</a>') ?>
    <?php endif; ?>
  </div>

</div>

<?php adminFooter(); ?>
