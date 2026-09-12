<?php
// backend/admin/homepage_widgets.php — Homepage widgets: the cards shown on the public homepage.
// Actions (POST): save (create/update) · toggle (is_active) · delete. Flash-after-redirect on success.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db   = getDB();
$self = '/admin/homepage_widgets.php';

// ── Reference data ───────────────────────────────────────────────────────────
// value => [select label, badge label, badge tone]
$typeLabels = [
    'announcement'   => ['Announcement · அறிவிப்பு',       'Announcement',   'gold'],
    'upcoming_event' => ['Upcoming Event · நிகழ்வு',       'Upcoming Event', ''],
    'coming_soon'    => ['Coming Soon · விரைவில்',         'Coming Soon',    'sage'],
    'upcoming_pooja' => ['Upcoming Pooja · அடுத்த பூஜை',   'Upcoming Pooja', 'moon'],
    'calendar_pooja' => ['Calendar Pooja · பௌர்ணமி பூஜை', 'Calendar Pooja', 'moon'],
    'nalla_neram'    => ['Nalla Neram · நல்ல நேரம்',        'Nalla Neram',    'sage'],
    'sponsor'        => ['Sponsor · ஸ்பான்சர்',             'Sponsor',        'gold'],
];
$filters = ['active' => 'Active', 'off' => 'Off', 'pinned' => 'Pinned'];

// Content types the database column actually accepts. schema.sql predates
// 'upcoming_event', so on an un-migrated database that option is offered
// disabled and rejected with a field error instead of a generic DB failure.
$dbTypes = null;
try {
    $col = $db->query("SHOW COLUMNS FROM homepage_widgets LIKE 'content_type'")->fetch(PDO::FETCH_ASSOC);
    if ($col && preg_match_all("/'([^']*)'/", (string) ($col['Type'] ?? ''), $m) && $m[1]) {
        $dbTypes = $m[1];
    }
} catch (Throwable) {
    $dbTypes = null; // unknown → do not restrict
}
$typeSupported = static fn(string $t): bool => $dbTypes === null || in_array($t, $dbTypes, true);

$str        = static fn($v): string => is_string($v) ? $v : '';
$pickFilter = static fn($v) => is_string($v) && isset($filters[$v]) ? $v : '';

// ── List state (GET) ─────────────────────────────────────────────────────────
$filter = $pickFilter($_GET['f'] ?? '');
$q      = sanitizeText($str($_GET['q'] ?? ''), 100);
$page   = max(1, (int) ($_GET['page'] ?? 1));
$query  = ['f' => $filter, 'q' => $q];
$url    = static function (array $override = []) use ($self, $query): string {
    $qs = adminQuery($query, $override);
    return $self . ($qs === '?' ? '' : $qs);
};

// ── Flash carried over a redirect ────────────────────────────────────────────
$msg = '';
if (!empty($_SESSION['admin_flash']) && is_array($_SESSION['admin_flash'])) {
    $flash = $_SESSION['admin_flash'];
    unset($_SESSION['admin_flash']);
    $tone = in_array($flash['type'] ?? '', ['success', 'error', 'warning', 'info'], true) ? $flash['type'] : 'info';
    if (($flash['text'] ?? '') !== '') {
        $msg = '<p class="alert alert--' . $tone . '" role="' . ($tone === 'error' ? 'alert' : 'status') . '">' . h($flash['text']) . '</p>';
    }
}

// ── POST handlers ────────────────────────────────────────────────────────────
$errors = [];   // field => message (re-rendered inline)
$old    = null; // submitted values, re-shown when validation fails
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $msg = adminCsrfGuard();
    if ($msg === '') {
        $action = $str($_POST['action'] ?? '');
        // Return to the same filtered / searched view after the redirect
        $backF  = $pickFilter($_POST['f'] ?? '');
        $backQ  = adminQuery(['f' => $backF, 'q' => sanitizeText($str($_POST['q'] ?? ''), 100)]);
        $back   = $self . ($backQ === '?' ? '' : $backQ);

        $redirect = static function (string $type, string $text, string $to): void {
            $_SESSION['admin_flash'] = ['type' => $type, 'text' => $text];
            header('Location: ' . $to);
            exit;
        };

        if ($action === 'save') {
            $content_type = in_array($_POST['content_type'] ?? '', array_keys($typeLabels), true)
                ? $_POST['content_type'] : 'announcement';
            $source_type  = ($_POST['source_type'] ?? 'manual') === 'calendar' ? 'calendar' : 'manual';

            $title_ta       = sanitizeText($str($_POST['title_ta']       ?? ''), 300);
            $title_en       = sanitizeText($str($_POST['title_en']       ?? ''), 300);
            $description_ta = sanitizeText($str($_POST['description_ta'] ?? ''), 2000);
            $description_en = sanitizeText($str($_POST['description_en'] ?? ''), 2000);

            $linked_pooja_id   = ((int) ($_POST['linked_pooja_id']   ?? 0)) ?: null;
            $linked_sponsor_id = ((int) ($_POST['linked_sponsor_id'] ?? 0)) ?: null;
            $show_sponsor      = isset($_POST['show_sponsor'])     ? 1 : 0;
            $show_nalla_neram  = isset($_POST['show_nalla_neram']) ? 1 : 0;
            $is_pinned         = isset($_POST['is_pinned'])        ? 1 : 0;
            $is_active         = isset($_POST['is_active'])        ? 1 : 0;

            $start_date = sanitizeText($str($_POST['start_date'] ?? ''), 10) ?: null;
            $end_date   = sanitizeText($str($_POST['end_date']   ?? ''), 10) ?: null;
            $priority   = max(1, min(100, (int) ($_POST['priority'] ?? 10)));
            $id         = (int) ($_POST['id'] ?? 0);

            // Dates must be real calendar dates — MySQL (strict mode) would otherwise reject the row.
            $validDate = static fn(?string $d): bool => $d === null
                || (preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) === 1
                    && checkdate((int) substr($d, 5, 2), (int) substr($d, 8, 2), (int) substr($d, 0, 4)));
            if (!$validDate($start_date)) $errors['start_date'] = 'Enter a valid date (YYYY-MM-DD).';
            if (!$validDate($end_date))   $errors['end_date']   = 'Enter a valid date (YYYY-MM-DD).';
            if (!$errors && $start_date && $end_date && $end_date < $start_date) {
                $errors['end_date'] = 'End date must be on or after the start date.';
            }
            if (!$typeSupported($content_type)) {
                $errors['content_type'] = 'This content type is not enabled in the database yet — apply the latest schema update, or choose another type.';
            }

            $old = [
                'id'             => $id,               'content_type'      => $content_type,
                'source_type'    => $source_type,      'title_ta'          => $title_ta,
                'title_en'       => $title_en,         'description_ta'    => $description_ta,
                'description_en' => $description_en,   'linked_pooja_id'   => $linked_pooja_id,
                'linked_sponsor_id' => $linked_sponsor_id, 'show_sponsor'   => $show_sponsor,
                'show_nalla_neram'  => $show_nalla_neram,  'start_date'     => $start_date,
                'end_date'       => $end_date,         'priority'          => $priority,
                'is_pinned'      => $is_pinned,        'is_active'         => $is_active,
            ];

            if ($errors) {
                $msg = '<p class="alert alert--error" role="alert">Please fix the highlighted field'
                     . (count($errors) === 1 ? '' : 's') . ' and save again.</p>';
            } else {
                $fields = [
                    ':ct'  => $content_type,   ':src' => $source_type,
                    ':tta' => $title_ta,        ':ten' => $title_en,
                    ':dta' => $description_ta,  ':den' => $description_en,
                    ':pid' => $linked_pooja_id, ':sid' => $linked_sponsor_id,
                    ':ss'  => $show_sponsor,    ':sn'  => $show_nalla_neram,
                    ':sd'  => $start_date,      ':ed'  => $end_date,
                    ':pr'  => $priority,        ':pin' => $is_pinned,
                    ':act' => $is_active,
                ];
                try {
                    if ($id > 0) {
                        $db->prepare('UPDATE homepage_widgets SET
                            content_type=:ct, source_type=:src,
                            title_ta=:tta,    title_en=:ten,
                            description_ta=:dta, description_en=:den,
                            linked_pooja_id=:pid, linked_sponsor_id=:sid,
                            show_sponsor=:ss, show_nalla_neram=:sn,
                            start_date=:sd,   end_date=:ed,
                            priority=:pr,     is_pinned=:pin,
                            is_active=:act
                        WHERE id=:id')
                           ->execute(array_merge($fields, [':id' => $id]));
                        $redirect('success', 'Widget updated.', $back);
                    } else {
                        $db->prepare('INSERT INTO homepage_widgets
                            (content_type,source_type,title_ta,title_en,
                             description_ta,description_en,
                             linked_pooja_id,linked_sponsor_id,
                             show_sponsor,show_nalla_neram,
                             start_date,end_date,priority,is_pinned,is_active)
                            VALUES
                            (:ct,:src,:tta,:ten,:dta,:den,:pid,:sid,:ss,:sn,:sd,:ed,:pr,:pin,:act)')
                           ->execute($fields);
                        $redirect('success', 'Widget created.', $back);
                    }
                } catch (PDOException $e) {
                    error_log('homepage_widgets save failed: ' . $e->getMessage());
                    $msg = '<p class="alert alert--error" role="alert">The database rejected this widget, so nothing was saved. '
                         . 'Check that the content type is supported by your database and that the linked pooja / sponsor still exist.</p>';
                }
            }
        } elseif ($action === 'toggle') {
            $id  = (int) ($_POST['id']  ?? 0);
            $val = (int) ($_POST['val'] ?? 0);
            if ($id > 0) {
                $db->prepare('UPDATE homepage_widgets SET is_active=:v WHERE id=:id')
                   ->execute([':v' => $val ? 0 : 1, ':id' => $id]);
                $redirect('success', $val ? 'Widget turned off — it is no longer shown on the homepage.' : 'Widget activated — it is now live on the homepage.', $back);
            }
        } elseif ($action === 'delete') {
            $id = (int) ($_POST['id'] ?? 0);
            if ($id > 0) {
                $db->prepare('DELETE FROM homepage_widgets WHERE id=:id')->execute([':id' => $id]);
                $redirect('success', 'Deleted.', $back);
            }
        }
    }
}

// ── Editing target (validation re-render wins over ?edit=) ───────────────────
$editing = null;
if ($old !== null) {
    $editing = $old;
} elseif (isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM homepage_widgets WHERE id=:id');
    $stmt->execute([':id' => (int) $_GET['edit']]);
    $editing = $stmt->fetch() ?: null;
    if ($editing === null && $msg === '') {
        $msg = '<p class="alert alert--warning" role="status">That widget no longer exists.</p>';
    }
}
$isEditing = $editing !== null && (int) ($editing['id'] ?? 0) > 0;
$formOpen  = $isEditing || $old !== null;

// ── List ─────────────────────────────────────────────────────────────────────
$where  = match ($filter) {
    'active' => ['w.is_active = 1'],
    'off'    => ['w.is_active = 0'],
    'pinned' => ['w.is_pinned = 1'],
    default  => [],
};
$params = [];
if ($q !== '') {
    $where[] = '(w.title_ta LIKE :q1 OR w.title_en LIKE :q2 OR w.description_ta LIKE :q3 OR w.description_en LIKE :q4)';
    $like = '%' . $q . '%';
    $params = [':q1' => $like, ':q2' => $like, ':q3' => $like, ':q4' => $like];
}
$perPage = 50;
$list = adminPaginate(
    $db,
    'SELECT w.*, p.name_ta AS pooja_name, s.name AS sponsor_name
       FROM homepage_widgets w
       LEFT JOIN poojas   p ON p.id = w.linked_pooja_id
       LEFT JOIN sponsors s ON s.id = w.linked_sponsor_id'
    . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
    . ' ORDER BY w.is_pinned DESC, w.priority ASC, w.id DESC',
    $params,
    $page,
    $perPage
);
$rows = $list['rows'];

$counts = $db->query('SELECT COUNT(*) AS total,
                             COALESCE(SUM(is_active = 1), 0) AS active,
                             COALESCE(SUM(is_active = 0), 0) AS inactive,
                             COALESCE(SUM(is_pinned = 1), 0) AS pinned
                        FROM homepage_widgets')->fetch();
$chipCounts = ['' => (int) $counts['total'], 'active' => (int) $counts['active'], 'off' => (int) $counts['inactive'], 'pinned' => (int) $counts['pinned']];

$poojas = $db->query(
    "SELECT id,name_ta,name_en,pooja_date FROM poojas
      WHERE is_active=1 ORDER BY pooja_date DESC LIMIT 50"
)->fetchAll();

$sponsors = $db->query(
    "SELECT id, name FROM sponsors WHERE is_active=1 ORDER BY name ASC LIMIT 50"
)->fetchAll();

// ── View helpers ─────────────────────────────────────────────────────────────
$v   = static fn(string $k, $default = '') => (string) ($editing[$k] ?? $default);
$sel = static fn($a, $b): string => (string) $a === (string) $b ? ' selected' : '';
$chk = static fn(string $k, int $default = 0): string => (int) ($editing[$k] ?? $default) ? ' checked' : '';
$err = static function (string $field, string $id) use ($errors): string {
    if (empty($errors[$field])) return '';
    return '<span class="field__error" id="' . $id . '" role="alert">' . adminIcon('alert-circle') . h($errors[$field]) . '</span>';
};
// aria-describedby points at the hint (when there is one), plus the error span only when one is rendered
$invalid = static function (string $field, ?string $hintId, string $errId) use ($errors): string {
    $ids = array_filter([$hintId, !empty($errors[$field]) ? $errId : null]);
    return (!empty($errors[$field]) ? ' aria-invalid="true"' : '')
         . ($ids ? ' aria-describedby="' . implode(' ', $ids) . '"' : '');
};

$actions = '<a href="/" target="_blank" rel="noopener" class="btn btn--sm">' . adminIcon('external') . 'Preview homepage</a>';
adminHeader('Homepage Widgets', 'Content', ['actions' => $actions]);
echo $msg;
echo adminPageIntro(
    'Compose the cards shown on the public homepage — announcements, the next pooja, sponsors and Nalla Neram — and control their order, visibility and schedule.',
    '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="widget-editor" aria-expanded="false">' . adminIcon('plus') . 'New widget</button>'
);
?>

<div class="admin-two-col admin-two-col--wide-form admin-two-col--collapsible" id="widget-editor" data-editing="<?= $formOpen ? '1' : '0' ?>">

  <!-- ── Editor ──────────────────────────────────────────────────────── -->
  <section class="admin-form-box card card--static" aria-labelledby="widget-form-title">
    <h2 id="widget-form-title"><?= adminIcon($isEditing ? 'pencil' : 'plus', 'ico--sm') ?> <?= $isEditing ? 'Edit widget #' . (int) $editing['id'] : 'New widget' ?></h2>

    <form method="POST" action="<?= h($self) ?>" id="new">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save" />
      <input type="hidden" name="f" value="<?= h($filter) ?>" />
      <input type="hidden" name="q" value="<?= h($q) ?>" />
      <?php if ($isEditing): ?>
        <input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" />
      <?php endif; ?>

      <fieldset>
        <legend>Type &amp; source</legend>
        <div class="form-grid">
          <div class="field<?= isset($errors['content_type']) ? ' field--error' : '' ?>">
            <label class="field__label" for="hw-type">Content type <span class="field__required" aria-hidden="true">*</span></label>
            <select id="hw-type" name="content_type" required aria-required="true"<?= $invalid('content_type', null, 'hw-type-err') ?>>
              <?php foreach ($typeLabels as $val => [$label]): $ok = $typeSupported($val); ?>
                <option value="<?= h($val) ?>"<?= $sel($v('content_type', 'announcement'), $val) ?><?= $ok ? '' : ' disabled' ?>><?= h($label . ($ok ? '' : ' — not enabled in database')) ?></option>
              <?php endforeach; ?>
            </select>
            <?= $err('content_type', 'hw-type-err') ?>
          </div>
          <div class="field">
            <label class="field__label" for="hw-source">Data source</label>
            <select id="hw-source" name="source_type" aria-describedby="hw-source-hint">
              <option value="manual"<?= $sel($v('source_type', 'manual'), 'manual') ?>>Manual — show exactly what I enter</option>
              <option value="calendar"<?= $sel($v('source_type', 'manual'), 'calendar') ?>>Calendar — auto-select the next pooja</option>
            </select>
          </div>
        </div>
        <span class="field__hint" id="hw-source-hint">Calendar shows the linked pooja while it is still upcoming, then switches automatically to the next pooja on the Poojas calendar (Pournami first) together with its sponsor. Leave the titles empty to use the pooja's own name.</span>
      </fieldset>

      <fieldset>
        <legend>Content</legend>
        <div class="form-grid">
          <div class="field">
            <label class="field__label" for="hw-title-ta">Title (Tamil)</label>
            <input id="hw-title-ta" name="title_ta" maxlength="300" lang="ta" value="<?= h($v('title_ta')) ?>" placeholder="பௌர்ணமி பூஜை அறிவிப்பு" />
          </div>
          <div class="field">
            <label class="field__label" for="hw-title-en">Title (English)</label>
            <input id="hw-title-en" name="title_en" maxlength="300" value="<?= h($v('title_en')) ?>" placeholder="Pournami Pooja Announcement" />
          </div>
          <div class="field">
            <label class="field__label" for="hw-desc-ta">Description (Tamil)</label>
            <textarea id="hw-desc-ta" name="description_ta" rows="3" maxlength="2000" lang="ta" data-counter><?= h($v('description_ta')) ?></textarea>
          </div>
          <div class="field">
            <label class="field__label" for="hw-desc-en">Description (English)</label>
            <textarea id="hw-desc-en" name="description_en" rows="3" maxlength="2000" data-counter><?= h($v('description_en')) ?></textarea>
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Links</legend>
        <div class="form-grid">
          <div class="field">
            <label class="field__label" for="hw-pooja">Link to pooja <span class="field__optional">optional</span></label>
            <select id="hw-pooja" name="linked_pooja_id">
              <option value="">— None —</option>
              <?php foreach ($poojas as $p): ?>
                <option value="<?= (int) $p['id'] ?>"<?= $sel($v('linked_pooja_id'), $p['id']) ?>><?= h($p['name_ta'] . ' — ' . $p['name_en'] . ' · ' . adminFmtDate($p['pooja_date'])) ?></option>
              <?php endforeach; ?>
            </select>
          </div>
          <div class="field">
            <label class="field__label" for="hw-sponsor">Link to sponsor <span class="field__optional">optional</span></label>
            <select id="hw-sponsor" name="linked_sponsor_id">
              <option value="">— None —</option>
              <?php foreach ($sponsors as $sp): ?>
                <option value="<?= (int) $sp['id'] ?>"<?= $sel($v('linked_sponsor_id'), $sp['id']) ?>><?= h($sp['name']) ?></option>
              <?php endforeach; ?>
            </select>
          </div>
        </div>
        <span class="field__hint">Active poojas are listed newest first; active sponsors alphabetically. Manage them under Worship.</span>
      </fieldset>

      <fieldset>
        <legend>Display</legend>
        <label class="switch">
          <input type="checkbox" name="show_sponsor" value="1"<?= $chk('show_sponsor') ?> />
          <span class="switch__track" aria-hidden="true"></span>
          <span class="switch__label">Show sponsor details<span class="switch__desc">Displays the linked sponsor's name on the card.</span></span>
        </label>
        <label class="switch">
          <input type="checkbox" name="show_nalla_neram" value="1"<?= $chk('show_nalla_neram') ?> />
          <span class="switch__track" aria-hidden="true"></span>
          <span class="switch__label">Show today's Nalla Neram<span class="switch__desc" lang="ta">இன்றைய நல்ல நேரம்</span></span>
        </label>
      </fieldset>

      <fieldset>
        <legend>Schedule</legend>
        <div class="form-grid">
          <div class="field<?= isset($errors['start_date']) ? ' field--error' : '' ?>">
            <label class="field__label" for="hw-start">Start date</label>
            <input id="hw-start" type="date" name="start_date" value="<?= h($v('start_date')) ?>"<?= $invalid('start_date', 'hw-start-hint', 'hw-start-err') ?> />
            <?= $err('start_date', 'hw-start-err') ?>
            <span class="field__hint" id="hw-start-hint">For an Upcoming Event this is the <strong>event date shown on the card</strong>. Otherwise the widget appears from this day.</span>
          </div>
          <div class="field<?= isset($errors['end_date']) ? ' field--error' : '' ?>">
            <label class="field__label" for="hw-end">End date</label>
            <input id="hw-end" type="date" name="end_date" value="<?= h($v('end_date')) ?>"<?= $invalid('end_date', 'hw-end-hint', 'hw-end-err') ?> />
            <?= $err('end_date', 'hw-end-err') ?>
            <span class="field__hint" id="hw-end-hint">Hidden automatically after this day. Leave both empty to show always.</span>
          </div>
        </div>
        <div class="field">
          <label class="field__label" for="hw-priority">Priority</label>
          <input id="hw-priority" type="number" name="priority" min="1" max="100" inputmode="numeric" value="<?= (int) $v('priority', 10) ?>" aria-describedby="hw-priority-hint" />
          <span class="field__hint" id="hw-priority-hint">1 = highest, 100 = lowest. Pinned widgets always come before everything else.</span>
        </div>
      </fieldset>

      <label class="switch">
        <input type="checkbox" name="is_pinned" value="1"<?= $chk('is_pinned') ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label">Pin this widget<span class="switch__desc">Always shown first, regardless of priority.</span></span>
      </label>
      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= $chk('is_active', $editing === null ? 1 : 0) ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label">Active<span class="switch__desc">Visible on the homepage within its schedule.</span></span>
      </label>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> <?= $isEditing ? 'Save changes' : 'Save widget' ?></button>
        <?php if ($formOpen): ?>
          <a href="<?= h($url()) ?>" class="btn btn-ghost">Cancel</a>
        <?php endif; ?>
      </div>
    </form>
  </section>

  <!-- ── List ────────────────────────────────────────────────────────── -->
  <div class="admin-list">
    <form method="GET" action="<?= h($self) ?>" class="toolbar" role="search">
      <div class="toolbar__search">
        <?= adminIcon('search') ?>
        <label class="sr-only" for="hw-q">Search widgets</label>
        <input id="hw-q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search titles and descriptions…" autocomplete="off" />
      </div>
      <?php if ($filter !== ''): ?><input type="hidden" name="f" value="<?= h($filter) ?>" /><?php endif; ?>
      <button type="submit" class="btn btn-ghost btn--sm" data-no-loading>Search</button>
      <nav class="filter-chips" aria-label="Filter by status">
        <?php foreach (['' => 'All'] + $filters as $key => $label): ?>
          <a class="chip" href="<?= h($url(['f' => $key, 'page' => null])) ?>"<?= $filter === $key ? ' aria-current="page"' : '' ?>><?= h($label) ?> <span class="chip__count"><?= $chipCounts[$key] ?></span></a>
        <?php endforeach; ?>
      </nav>
      <span class="toolbar__count"><?= (int) $list['total'] ?> record<?= $list['total'] === 1 ? '' : 's' ?></span>
    </form>

    <?php if (!$rows): ?>
      <?php if ($filter !== '' || $q !== ''): ?>
        <?= adminEmpty('filter', 'No widgets match', 'Try another status or clear the search to see every widget.', '<a href="' . h($self) . '" class="btn btn--sm">' . adminIcon('x') . 'Clear filters</a>') ?>
      <?php else: ?>
        <?= adminEmpty('layers', 'No widgets yet', 'The homepage falls back to the next pooja from the calendar until you create your first card. Start with an announcement or a Calendar Pooja widget.', '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . 'New widget</a>') ?>
      <?php endif; ?>
    <?php else: ?>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Type</th>
              <th scope="col">Title</th>
              <th scope="col">Source</th>
              <th scope="col">Pooja</th>
              <th scope="col" class="num">Priority</th>
              <th scope="col">Active</th>
              <th scope="col">Dates</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <?php foreach ($rows as $row):
                $rid   = (int) $row['id'];
                $type  = $typeLabels[$row['content_type']] ?? null;
                $name  = $row['title_ta'] ?: ($row['title_en'] ?: ($row['source_type'] === 'calendar' ? 'Next pooja (auto)' : 'Widget #' . $rid));
            ?>
            <tr>
              <td class="num">
                <?php if ($row['is_pinned']): ?>
                  <?= adminIcon('pin', 'ico--sm') ?><span class="sr-only">Pinned</span>
                <?php else: ?>
                  <?= $rid ?>
                <?php endif; ?>
              </td>
              <td><?= $type ? adminBadge($type[1], $type[2]) : adminBadge((string) $row['content_type'], 'muted') ?></td>
              <td>
                <?php if ($row['title_ta']): ?>
                  <span class="cell-title" lang="ta"><?= h($row['title_ta']) ?></span>
                  <?php if ($row['title_en']): ?><span class="cell-sub"><?= h($row['title_en']) ?></span><?php endif; ?>
                <?php elseif ($row['title_en']): ?>
                  <span class="cell-title"><?= h($row['title_en']) ?></span>
                <?php else: ?>
                  <span class="cell-title text-muted">—</span>
                  <span class="cell-sub"><?= $row['source_type'] === 'calendar' ? 'Title comes from the next pooja' : 'No title' ?></span>
                <?php endif; ?>
              </td>
              <td><?= $row['source_type'] === 'calendar' ? adminBadge('Auto', 'info') : adminBadge('Manual', 'muted') ?></td>
              <td>
                <?php if ($row['pooja_name']): ?><span lang="ta"><?= h($row['pooja_name']) ?></span><?php else: ?><span class="text-muted">—</span><?php endif; ?>
                <?php if ($row['sponsor_name']): ?><span class="cell-sub">Sponsor: <?= h($row['sponsor_name']) ?></span><?php endif; ?>
              </td>
              <td class="num"><?= (int) $row['priority'] ?></td>
              <td>
                <form method="POST" action="<?= h($self) ?>">
                  <?= csrfField() ?>
                  <input type="hidden" name="action" value="toggle" />
                  <input type="hidden" name="id" value="<?= $rid ?>" />
                  <input type="hidden" name="val" value="<?= (int) $row['is_active'] ?>" />
                  <input type="hidden" name="f" value="<?= h($filter) ?>" />
                  <input type="hidden" name="q" value="<?= h($q) ?>" />
                  <?php if ($row['is_active']): ?>
                    <button type="submit" class="btn btn-success btn--xs" aria-label="Deactivate widget: <?= h($name) ?>"><?= adminIcon('check', 'ico--xs') ?>Active</button>
                  <?php else: ?>
                    <button type="submit" class="btn btn-ghost btn--xs" aria-label="Activate widget: <?= h($name) ?>">Off</button>
                  <?php endif; ?>
                </form>
              </td>
              <td class="cell-date">
                <?php if ($row['start_date'] && $row['end_date']): ?>
                  From <?= adminFmtDate($row['start_date']) ?><br />To <?= adminFmtDate($row['end_date']) ?>
                <?php elseif ($row['start_date']): ?>
                  From <?= adminFmtDate($row['start_date']) ?>
                <?php elseif ($row['end_date']): ?>
                  Until <?= adminFmtDate($row['end_date']) ?>
                <?php else: ?>
                  Always
                <?php endif; ?>
              </td>
              <td class="cell-actions">
                <?= adminMenu([
                    ['label' => 'Edit', 'href' => $url(['edit' => $rid, 'page' => null]), 'icon' => 'pencil'],
                    'divider',
                    ['label' => 'Delete', 'icon' => 'trash', 'danger' => true,
                     'form' => ['action' => 'delete', 'id' => $rid, 'f' => $filter, 'q' => $q],
                     'confirm' => 'Delete "' . $name . '"? It disappears from the homepage immediately and cannot be undone.'],
                ], 'Actions for ' . $name) ?>
              </td>
            </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      </div>
      <?php if ($list['pages'] > 1): ?>
        <?= adminPagination($list['page'], $list['pages'], $query, $list['total'], $perPage) ?>
      <?php endif; ?>
    <?php endif; ?>

    <div class="callout mt-4">
      <?= adminIcon('info') ?>
      <p><strong>Priority rules.</strong> Pinned widgets always come first; the rest are ordered by priority (1 = highest). Use low numbers for Announcements, then Upcoming and Calendar Poojas, then Sponsors and Nalla Neram. Widgets outside their start/end dates are hidden automatically, the homepage shows at most 15 cards, and if no widget is active the next pooja from the calendar is shown instead.</p>
    </div>
  </div>

</div>
<?php adminFooter(); ?>
