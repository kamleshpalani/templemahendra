<?php
// backend/admin/events.php — Events: festivals and temple events shown on the public site.
//
// Since migration 020 an event has a type (festival / pooja / special / other),
// a featured flag that highlights it on the Events page, an optional last day
// for multi-day events, programme times, a venue and a picture, and its
// description is written in Tamil and in English (brief §6, §7). The old
// single-language `description` column is kept in step (English, or Tamil when
// there is no English) so pages that still read it keep working for a release;
// a request that only sends the old `description` field is accepted and the
// one text becomes both languages.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_guard.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

if (!publicGuardHasColumn('events', 'event_type') || !publicGuardHasColumn('events', 'description_ta')) {
    adminHeader('Events', 'Temple');
    echo '<p class="alert alert--warning" role="alert">Bilingual events are not installed on this site yet: apply database migration <code>020_bilingual_content_events.sql</code> and reload.</p>';
    adminFooter();
    exit;
}

/** The event types migration 020 defines, with their label and badge tone. */
const EVENT_TYPES = [
    'festival' => ['Festival', 'gold'],
    'pooja'    => ['Pooja', 'info'],
    'special'  => ['Special', 'warning'],
    'other'    => ['Other', ''],
];

/** String value from a request array ('' when missing or not scalar). */
$str = static fn(array $src, string $key): string => is_scalar($src[$key] ?? null) ? (string) $src[$key] : '';

/**
 * A programme time as MySQL stores it: '' when blank, 'HH:MM:SS' when it is a
 * 24-hour time, null when it is not a time at all.
 */
$timeOf = static function (string $v): ?string {
    $v = trim($v);
    if ($v === '') return '';
    if (!preg_match('/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/', $v, $m)) return null;
    return $m[1] . ':' . $m[2] . ':' . ($m[3] ?? '00');
};

/**
 * True when $url can be an event picture: an https address, or a path on this
 * site under /uploads/ or /images/. Nothing else — no javascript:, no data:,
 * no protocol-relative address, no dot-dot — because it ends up in an <img>
 * and in the share preview of the event page.
 */
function eventImageUrlOk(string $url): bool
{
    if ($url === '' || strlen($url) > 500 || preg_match('/[\x00-\x20\x7F\\\\]/', $url)) return false;
    if ($url[0] === '/') {
        return preg_match('#^/(uploads|images)/[A-Za-z0-9][A-Za-z0-9._/-]*\.(jpe?g|png|webp|gif|avif)$#i', $url) === 1 && !str_contains($url, '..') && !str_contains($url, '//');
    }
    if (stripos($url, 'https://') !== 0) return false;
    $p = parse_url($url);
    if (!is_array($p) || strtolower((string) ($p['scheme'] ?? '')) !== 'https' || empty($p['host'])) return false;
    if (isset($p['user']) || isset($p['pass'])) return false;
    return preg_match('/^[A-Za-z0-9.-]+$/', (string) $p['host']) === 1;
}

/** The submitted form, as typed, for showing it again (every value is h()-escaped on output). */
$fromPost = static function () use ($str): array {
    $legacyDesc = $str($_POST, 'description');
    return [
        'id'             => (int) $str($_POST, 'id'),
        'title_ta'       => $str($_POST, 'title_ta'),
        'title_en'       => $str($_POST, 'title_en'),
        'event_type'     => $str($_POST, 'event_type'),
        'event_date'     => $str($_POST, 'event_date'),
        'end_date'       => $str($_POST, 'end_date'),
        'start_time'     => $str($_POST, 'start_time'),
        'end_time'       => $str($_POST, 'end_time'),
        'venue_ta'       => $str($_POST, 'venue_ta'),
        'venue_en'       => $str($_POST, 'venue_en'),
        'description_ta' => $str($_POST, 'description_ta') !== '' ? $str($_POST, 'description_ta') : $legacyDesc,
        'description_en' => $str($_POST, 'description_en') !== '' ? $str($_POST, 'description_en') : $legacyDesc,
        'image_url'      => $str($_POST, 'image_url'),
        'is_featured'    => isset($_POST['is_featured']) ? 1 : 0,
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
$filters       = ['upcoming' => 'Upcoming', 'past' => 'Past', 'featured' => 'Featured', 'all' => 'All'];
$defaultFilter = 'upcoming';
$src           = $_SERVER['REQUEST_METHOD'] === 'POST' ? $_POST : $_GET; // a failed save must keep the list state
$filter        = isset($filters[$str($src, 'f')]) ? $str($src, 'f') : $defaultFilter;
$typeFilter    = isset(EVENT_TYPES[$str($src, 't')]) ? $str($src, 't') : '';
$q             = mb_substr(trim($str($src, 'q')), 0, 100);
$query         = ['f' => $filter === $defaultFilter ? '' : $filter, 't' => $typeFilter, 'q' => $q];
$listUrl       = static fn(array $override = []): string => '/admin/events.php' . rtrim(adminQuery($query, $override), '?');

// ── Create / update / toggle / feature / delete ──────────────────────────────
$editing = null; // row shown in the form: from ?edit=ID, or the submitted values after a validation error
$errors  = [];   // field => true when server-side validation failed

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $msg    = adminCsrfGuard();
    $action = $str($_POST, 'action');
    $back   = $listUrl();

    // A rejected token must not cost the admin their typing — reflect it back (inert: every value is h()-escaped).
    if ($msg !== '' && $action === 'save') $editing = $fromPost();

    if ($msg === '' && $action === 'save') {
        $in = $fromPost();
        // Lengths are clamped to the column definitions so nothing reaches MySQL out of bounds.
        $title_ta   = sanitizeText($in['title_ta'], 300); // VARCHAR(300)
        $title_en   = sanitizeText($in['title_en'], 300); // VARCHAR(300)
        $type       = $in['event_type'] === '' ? 'other' : $in['event_type'];
        $event_date = trim($in['event_date']);
        $end_date   = trim($in['end_date']);
        $start_time = $timeOf($in['start_time']);
        $end_time   = $timeOf($in['end_time']);
        $venue_ta   = sanitizeText($in['venue_ta'], 300);  // VARCHAR(300)
        $venue_en   = sanitizeText($in['venue_en'], 300);  // VARCHAR(300)
        $desc_ta    = sanitizeText($in['description_ta'], 5000);
        $desc_en    = sanitizeText($in['description_en'], 5000);
        $image_url  = trim($in['image_url']);
        $featured   = $in['is_featured'];
        $active     = $in['is_active'];
        $id         = $in['id'];

        if ($title_ta === '')                                        $errors['title_ta']   = true;
        if ($title_en === '')                                        $errors['title_en']   = true;
        if (!isset(EVENT_TYPES[$type]))                              $errors['event_type'] = true;
        if (!isValidDate($event_date))                               $errors['event_date'] = true;
        if ($end_date !== '' && (!isValidDate($end_date) || (isValidDate($event_date) && $end_date < $event_date))) $errors['end_date'] = true;
        if ($start_time === null)                                    $errors['start_time'] = true;
        if ($end_time === null)                                      $errors['end_time']   = true;
        // On a one-day event the programme cannot end before it starts.
        if ($start_time && $end_time && ($end_date === '' || $end_date === $event_date) && $end_time < $start_time) $errors['end_time'] = true;
        if ($image_url !== '' && !eventImageUrlOk($image_url))       $errors['image_url']  = true;

        $current = null;
        if ($id > 0 && !$errors) {
            $stmt = $db->prepare('SELECT id FROM events WHERE id = :id');
            $stmt->execute([':id' => $id]);
            $current = $stmt->fetch() ?: null;
            if ($current === null) $errors['id'] = true;
        }

        if ($errors) {
            $msg     = '<p class="alert alert--error">' . (isset($errors['id']) ? 'That event no longer exists.' : 'Please fix the highlighted fields.') . '</p>';
            $editing = $in;
        } else {
            $params = [
                ':ta' => $title_ta, ':en' => $title_en, ':ty' => $type,
                ':dta' => $desc_ta !== '' ? $desc_ta : null, ':den' => $desc_en !== '' ? $desc_en : null,
                ':d'   => $desc_en !== '' ? $desc_en : ($desc_ta !== '' ? $desc_ta : null), // legacy column: English, else Tamil
                ':dt'  => $event_date, ':ed' => $end_date !== '' ? $end_date : null,
                ':st'  => $start_time !== '' ? $start_time : null, ':et' => $end_time !== '' ? $end_time : null,
                ':vta' => $venue_ta !== '' ? $venue_ta : null, ':ven' => $venue_en !== '' ? $venue_en : null,
                ':img' => $image_url !== '' ? $image_url : null,
                ':fe'  => $featured, ':a' => $active,
            ];
            if ($current) {
                $params[':id'] = $id;
                $db->prepare('UPDATE events SET title_ta=:ta, title_en=:en, event_type=:ty, description=:d, description_ta=:dta, description_en=:den,
                                 event_date=:dt, end_date=:ed, start_time=:st, end_time=:et, venue_ta=:vta, venue_en=:ven, image_url=:img,
                                 is_featured=:fe, is_active=:a WHERE id=:id')->execute($params);
                adminAudit('event_updated', 'event:' . $id, $title_en . ' · ' . $event_date);
                $_SESSION['flash'] = '<p class="alert alert--success">Updated.</p>';
            } else {
                $db->prepare('INSERT INTO events (title_ta, title_en, event_type, description, description_ta, description_en, event_date, end_date,
                                 start_time, end_time, venue_ta, venue_en, image_url, is_featured, is_active)
                              VALUES (:ta, :en, :ty, :d, :dta, :den, :dt, :ed, :st, :et, :vta, :ven, :img, :fe, :a)')->execute($params);
                adminAudit('event_created', 'event:' . (int) $db->lastInsertId(), $title_en . ' · ' . $event_date);
                $_SESSION['flash'] = '<p class="alert alert--success">Created.</p>';
            }
            header('Location: ' . $back, true, 303);
            exit;
        }
    } elseif ($msg === '' && ($action === 'toggle' || $action === 'feature')) {
        $id   = (int) $str($_POST, 'id');
        $col  = $action === 'toggle' ? 'is_active' : 'is_featured';
        $stmt = $db->prepare("UPDATE events SET $col = 1 - $col WHERE id = :id");
        $stmt->execute([':id' => $id]);
        if ($stmt->rowCount()) {
            adminAudit($action === 'toggle' ? 'event_toggled' : 'event_featured', 'event:' . $id);
            $_SESSION['flash'] = '<p class="alert alert--success">' . ($action === 'toggle' ? 'Visibility changed.' : 'Featured changed.') . '</p>';
        }
        header('Location: ' . $back, true, 303);
        exit;
    } elseif ($msg === '' && $action === 'delete') {
        $id = (int) $str($_POST, 'id');
        if ($id > 0) {
            $gone = $db->prepare('SELECT title_en FROM events WHERE id=:id');
            $gone->execute([':id' => $id]);
            $goneTitle = $gone->fetchColumn();
            $db->prepare('DELETE FROM events WHERE id=:id')->execute([':id' => $id]);
            if ($goneTitle !== false) adminAudit('event_deleted', 'event:' . $id, (string) $goneTitle);
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
    case 'upcoming': $where[] = 'COALESCE(end_date, event_date) >= :today'; $params[':today'] = $today; break;
    case 'past':     $where[] = 'COALESCE(end_date, event_date) < :today';  $params[':today'] = $today; break;
    case 'featured': $where[] = 'is_featured = 1'; break;
}
if ($typeFilter !== '') {
    $where[] = 'event_type = :t';
    $params[':t'] = $typeFilter;
}
if ($q !== '') {
    $like    = '%' . addcslashes($q, '%_\\') . '%';
    $where[] = '(title_en LIKE :q1 OR title_ta LIKE :q2 OR description_ta LIKE :q3 OR description_en LIKE :q4 OR venue_ta LIKE :q5 OR venue_en LIKE :q6)';
    $params += [':q1' => $like, ':q2' => $like, ':q3' => $like, ':q4' => $like, ':q5' => $like, ':q6' => $like];
}
$stmt = $db->prepare('SELECT * FROM events' . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
    . ' ORDER BY ' . ($filter === 'past' ? 'event_date DESC' : 'event_date ASC') . ', id ASC LIMIT ' . ($cap + 1));
$stmt->execute($params);
$rows   = $stmt->fetchAll();
$capped = count($rows) > $cap;
if ($capped) $rows = array_slice($rows, 0, $cap);

$c = $db->query('SELECT COUNT(*) AS total,
                        COALESCE(SUM(COALESCE(end_date, event_date) >= CURDATE()), 0) AS upcoming,
                        COALESCE(SUM(COALESCE(end_date, event_date) < CURDATE()), 0)  AS past,
                        COALESCE(SUM(is_featured = 1), 0) AS featured
                   FROM events')->fetch();
$chipCounts = ['upcoming' => (int) $c['upcoming'], 'past' => (int) $c['past'], 'featured' => (int) $c['featured'], 'all' => (int) $c['total']];

$shown      = count($rows);
$filtered   = $filter !== 'all' || $typeFilter !== '' || $q !== '';
$countLabel = $filtered ? "$shown of {$chipCounts['all']} records" : "$shown record" . ($shown === 1 ? '' : 's');
if ($capped) $countLabel .= " · showing the first $cap";

$invalid    = static fn(string $f): string => isset($errors[$f]) ? ' aria-invalid="true" aria-describedby="err-' . $f . '"' : '';
$fieldError = static fn(string $f, string $text): string => isset($errors[$f]) ? '<span class="field__error" id="err-' . $f . '">' . adminIcon('alert-circle') . h($text) . '</span>' : '';
$hhmm       = static fn(?string $t): string => $t === null || $t === '' ? '' : substr($t, 0, 5);

// ── Page ─────────────────────────────────────────────────────────────────────
adminHeader('Events', 'Temple', [
    'actions' => '<a href="/events" target="_blank" rel="noopener" class="btn btn-ghost btn--sm">' . adminIcon('external') . 'View on site</a>',
]);
echo $msg;
echo adminPageIntro(
    'Festivals and temple events listed on the public Events page in Tamil and English — upcoming ones are also highlighted on the homepage, a featured event leads the Events page, and past events stay in the archive.',
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
      <input type="hidden" name="t" value="<?= h($typeFilter) ?>" />
      <input type="hidden" name="q" value="<?= h($q) ?>" />
      <?php if ($isEdit): ?><input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" /><?php endif; ?>

      <label for="title_ta">
        <span class="field__label">Title (Tamil) <span class="field__required" aria-hidden="true">*</span></span>
        <input id="title_ta" name="title_ta" type="text" lang="ta" required aria-required="true" maxlength="300" autocomplete="off"
               placeholder="எ.கா. தைப்பூசம்" value="<?= h($editing['title_ta'] ?? '') ?>"<?= $invalid('title_ta') ?> />
        <?= $fieldError('title_ta', 'Tamil title is required.') ?>
      </label>

      <label for="title_en">
        <span class="field__label">Title (English) <span class="field__required" aria-hidden="true">*</span></span>
        <input id="title_en" name="title_en" type="text" required aria-required="true" maxlength="300" autocomplete="off"
               placeholder="e.g. Thai Poosam" value="<?= h($editing['title_en'] ?? '') ?>"<?= $invalid('title_en') ?> />
        <?= $fieldError('title_en', 'English title is required.') ?>
      </label>

      <div class="form-grid">
        <label for="event_type">
          <span class="field__label">Type</span>
          <select id="event_type" name="event_type"<?= $invalid('event_type') ?>>
            <?php foreach (EVENT_TYPES as $key => [$label]): ?>
              <option value="<?= h($key) ?>"<?= ($editing['event_type'] ?? 'other') === $key ? ' selected' : '' ?>><?= h($label) ?></option>
            <?php endforeach; ?>
          </select>
          <?= $fieldError('event_type', 'Choose one of the listed types.') ?>
          <span class="field__hint">Festivals get their own filter on the Events page.</span>
        </label>
        <label for="image_url">
          <span class="field__label">Picture <span class="field__optional">optional</span></span>
          <input id="image_url" name="image_url" type="text" inputmode="url" spellcheck="false" maxlength="500" autocomplete="off"
                 placeholder="https://… or /uploads/…" value="<?= h($editing['image_url'] ?? '') ?>"<?= $invalid('image_url') ?> />
          <?= $fieldError('image_url', 'Use an https address or a picture under /uploads/ or /images/ on this site.') ?>
          <span class="field__hint">Shown on the event page and in shared-link previews.</span>
        </label>
      </div>

      <div class="form-grid">
        <label for="event_date">
          <span class="field__label">First day <span class="field__required" aria-hidden="true">*</span></span>
          <input id="event_date" name="event_date" type="date" required aria-required="true"
                 value="<?= h($editing['event_date'] ?? '') ?>"<?= $invalid('event_date') ?> />
          <?= $fieldError('event_date', 'Enter a valid date (YYYY-MM-DD).') ?>
          <span class="field__hint">Events on or after today appear as upcoming.</span>
        </label>
        <label for="end_date">
          <span class="field__label">Last day <span class="field__optional">optional</span></span>
          <input id="end_date" name="end_date" type="date" value="<?= h($editing['end_date'] ?? '') ?>"<?= $invalid('end_date') ?> />
          <?= $fieldError('end_date', 'The last day must be a valid date on or after the first day.') ?>
          <span class="field__hint">For a festival that runs several days.</span>
        </label>
      </div>

      <div class="form-grid">
        <label for="start_time">
          <span class="field__label">Starts at <span class="field__optional">optional</span></span>
          <input id="start_time" name="start_time" type="time" value="<?= h($hhmm($editing['start_time'] ?? '')) ?>"<?= $invalid('start_time') ?> />
          <?= $fieldError('start_time', 'Enter a time as HH:MM (24-hour).') ?>
        </label>
        <label for="end_time">
          <span class="field__label">Ends at <span class="field__optional">optional</span></span>
          <input id="end_time" name="end_time" type="time" value="<?= h($hhmm($editing['end_time'] ?? '')) ?>"<?= $invalid('end_time') ?> />
          <?= $fieldError('end_time', 'Enter a time as HH:MM (24-hour), not before the start.') ?>
        </label>
      </div>

      <label for="venue_ta">
        <span class="field__label">Venue (Tamil) <span class="field__optional">optional</span></span>
        <input id="venue_ta" name="venue_ta" type="text" lang="ta" maxlength="300" autocomplete="off"
               placeholder="எ.கா. கோயில் மண்டபம்" value="<?= h($editing['venue_ta'] ?? '') ?>" />
      </label>

      <label for="venue_en">
        <span class="field__label">Venue (English) <span class="field__optional">optional</span></span>
        <input id="venue_en" name="venue_en" type="text" maxlength="300" autocomplete="off"
               placeholder="e.g. Temple mandapam" value="<?= h($editing['venue_en'] ?? '') ?>" />
      </label>

      <label for="description_ta">
        <span class="field__label">Description (Tamil) <span class="field__optional">optional</span></span>
        <textarea id="description_ta" name="description_ta" rows="4" lang="ta" maxlength="5000" data-counter><?= h($editing['description_ta'] ?? '') ?></textarea>
        <span class="field__hint">Programme details, timings or special poojas for the day.</span>
      </label>

      <label for="description_en">
        <span class="field__label">Description (English) <span class="field__optional">optional</span></span>
        <textarea id="description_en" name="description_en" rows="4" maxlength="5000" data-counter><?= h($editing['description_en'] ?? '') ?></textarea>
      </label>

      <label class="switch">
        <input type="checkbox" name="is_featured" value="1"<?= !empty($editing['is_featured']) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Featured</strong><span class="switch__desc">Highlighted at the top of the Events page (the soonest featured upcoming event).</span></span>
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
        <input id="q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search by title, venue or description…" autocomplete="off" />
        <button type="submit" class="sr-only">Search</button>
      </div>
      <div class="toolbar__group">
        <label class="sr-only" for="event-t">Type</label>
        <select id="event-t" name="t" onchange="this.form.submit()">
          <option value="">All types</option>
          <?php foreach (EVENT_TYPES as $key => [$label]): ?>
            <option value="<?= h($key) ?>"<?= $typeFilter === $key ? ' selected' : '' ?>><?= h($label) ?></option>
          <?php endforeach; ?>
        </select>
      </div>
      <nav class="filter-chips" aria-label="Filter events">
        <?php foreach ($filters as $key => $label): ?>
          <a class="chip" href="<?= h($listUrl(['f' => $key === $defaultFilter ? '' : $key])) ?>"<?= $key === $filter ? ' aria-current="page"' : '' ?>>
            <?= h($label) ?> <span class="chip__count"><?= $chipCounts[$key] ?></span>
          </a>
        <?php endforeach; ?>
      </nav>
      <?php if ($q !== '' || $typeFilter !== ''): ?>
        <a href="<?= h($listUrl(['q' => '', 't' => ''])) ?>" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Clear</a>
      <?php endif; ?>
      <span class="toolbar__count" aria-live="polite"><?= h($countLabel) ?></span>
    </form>

    <?php if ($rows): ?>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col">Type</th>
            <th scope="col">When</th>
            <th scope="col">Status</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($rows as $row):
              $rid    = (int) $row['id'];
              $lastDay = $row['end_date'] ?? $row['event_date'];
              $isPast = $lastDay < $today;
              $isOn   = !$isPast && $row['event_date'] <= $today;
              [$typeLabel, $typeTone] = EVENT_TYPES[$row['event_type']] ?? EVENT_TYPES['other'];
              $venue = $row['venue_en'] ?? $row['venue_ta'];
              $times = trim($hhmm($row['start_time']) . ($row['end_time'] !== null ? ' – ' . $hhmm($row['end_time']) : ''));
          ?>
          <tr>
            <td>
              <span class="cell-title" lang="ta"><?= h($row['title_ta']) ?></span>
              <span class="cell-sub"><?= h($row['title_en']) ?><?= $venue !== null && $venue !== '' ? ' · ' . h($venue) : '' ?></span>
            </td>
            <td><?= adminBadge($typeLabel, $typeTone) ?></td>
            <td class="cell-date">
              <time datetime="<?= h($row['event_date']) ?>"><?= adminFmtDate($row['event_date']) ?></time>
              <?php if ($row['end_date'] !== null && $row['end_date'] !== $row['event_date']): ?> – <time datetime="<?= h($row['end_date']) ?>"><?= adminFmtDate($row['end_date']) ?></time><?php endif; ?>
              <?php if ($times !== ''): ?><span class="cell-sub"><?= h($times) ?></span><?php endif; ?>
            </td>
            <td>
              <span class="cluster">
                <?= $isPast ? adminBadge('Past', 'muted') : adminBadge($isOn ? ($row['event_date'] === $today ? 'Today' : 'On now') : 'Upcoming', 'info') ?>
                <?= $row['is_active'] ? adminBadge('Active', 'success') : adminBadge('Hidden', 'muted') ?>
                <?php if ($row['is_featured']) echo adminBadge('Featured', 'gold'); ?>
              </span>
            </td>
            <td class="cell-actions">
              <?= adminMenu([
                  ['label' => 'Edit', 'icon' => 'pencil', 'href' => $listUrl(['edit' => $rid])],
                  ['label' => 'View on site', 'icon' => 'external', 'href' => '/events/' . $rid],
                  ...(adminCan('notifications.compose') && $row['is_active'] && (string) $row['event_date'] >= date('Y-m-d')
                      ? [['label' => 'Announce to devotees', 'icon' => 'megaphone', 'href' => '/admin/notifications.php?new=1&from=event:' . $rid]] : []),
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
    <?php if ($capped): ?>
      <p class="field__hint mt-2">Only the first <?= $cap ?> events are listed. Use search or a filter to narrow the list.</p>
    <?php endif; ?>
    <?php elseif ($q !== '' || $typeFilter !== '' || $filter === 'past' || $filter === 'featured'): ?>
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
