<?php
// backend/admin/announcements.php — Announcements: short notices for the homepage ticker.
//
// Since migration 020 a notice is written in Tamil and in English (brief §7)
// and may carry a publish window: it is public only between start_date and
// end_date, inclusive, when either is set. The old single-language `title` and
// `body` columns are kept in step (English, or Tamil when there is no English)
// so pages that still read them keep working for a release. A request that
// only sends the old `title` / `body` fields (an older client, a script) is
// accepted: the one text becomes both languages.
//
// "Also notify devotees" (new announcements only) turns the notice into a DRAFT
// notification campaign by email and WhatsApp (docs/registration/SPEC.md §6). It
// never sends anything by itself: a broadcast goes through the campaign flow —
// review, approval when the size or channels call for it, scheduling — on the
// Notifications page. An announcement is an update, so it reaches only the
// registered families who agreed to temple updates.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_guard.php';
require_once __DIR__ . '/../includes/devotee_notify.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

if (!publicGuardHasColumn('announcements', 'title_ta') || !publicGuardHasColumn('announcements', 'start_date')) {
    adminHeader('Announcements', 'Content');
    echo '<p class="alert alert--warning" role="alert">Bilingual announcements are not installed on this site yet: apply database migration <code>020_bilingual_content_events.sql</code> and reload.</p>';
    adminFooter();
    exit;
}

/**
 * Create the draft campaign for a new announcement and return the flash that
 * says what happened. Each language of the notice becomes that language's
 * translation; they can be refined in the composer before it is submitted.
 */
function announcementDraftNotification(array $words): string
{
    if (!devoteeNotifyReady()) {
        return '<p class="alert alert--warning" role="status">Created. Devotees were not notified: notifications are not installed on this site yet.</p>';
    }
    $admin = currentAdmin() ?? [];
    $text  = static function (string $title, string $body): array {
        $headline = mb_strlen($title) > 200 ? rtrim(mb_substr($title, 0, 199)) . '…' : $title;
        return ['title' => $headline, 'body' => $body !== '' ? $body : $title, 'cta_label' => null];
    };
    try {
        $save = notifyCampaignSave([
            'name'          => mb_substr('Announcement: ' . $words['title_en'], 0, 160),
            'category'      => 'announcement',
            'priority'      => 'normal',
            'channels'      => ['email', 'whatsapp'],
            'template_key'  => 'announcement',
            'audience'      => ['mode' => 'all_devotees'],
            'translations'  => ['ta' => $text($words['title_ta'], $words['body_ta']), 'en' => $text($words['title_en'], $words['body_en'])],
            'schedule_tz'   => 'temple',
            'recurrence'    => 'none',
        ], ['username' => (string) ($admin['username'] ?? 'admin'), 'role' => adminRole()]);
    } catch (Throwable $e) {
        error_log('[notify] draft campaign for an announcement failed: ' . $e->getMessage());
        $save = ['ok' => false, 'id' => null, 'errors' => ['_' => 'The notification service failed.']];
    }
    if (!$save['ok']) {
        return '<p class="alert alert--warning" role="alert">Created. The draft notification could not be made: '
            . h(implode(' ', $save['errors'])) . ' You can compose one on the Notifications page.</p>';
    }
    return '<p class="alert alert--success" role="status">Created. A draft email and WhatsApp notification to the families who agreed to temple updates is ready: '
        . '<a href="/admin/notifications.php?edit=' . (int) $save['id'] . '">review and submit it</a>. '
        . 'Nothing is sent until it goes through the notification flow.</p>';
}

/** String value from a request array ('' when missing or not scalar). */
$str = static fn(array $src, string $key): string => is_scalar($src[$key] ?? null) ? (string) $src[$key] : '';

/** The submitted form, as typed, for showing it again (every value is h()-escaped on output). */
$fromPost = static function () use ($str): array {
    $legacyTitle = $str($_POST, 'title');
    $legacyBody  = $str($_POST, 'body');
    return [
        'id'              => (int) $str($_POST, 'id'),
        'title_ta'        => $str($_POST, 'title_ta') !== '' ? $str($_POST, 'title_ta') : $legacyTitle,
        'title_en'        => $str($_POST, 'title_en') !== '' ? $str($_POST, 'title_en') : $legacyTitle,
        'body_ta'         => $str($_POST, 'body_ta') !== '' ? $str($_POST, 'body_ta') : $legacyBody,
        'body_en'         => $str($_POST, 'body_en') !== '' ? $str($_POST, 'body_en') : $legacyBody,
        'start_date'      => $str($_POST, 'start_date'),
        'end_date'        => $str($_POST, 'end_date'),
        'is_active'       => isset($_POST['is_active']) ? 1 : 0,
        'notify_devotees' => isset($_POST['notify_devotees']) ? 1 : 0,
    ];
};

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

// ── Create / update / toggle / delete ────────────────────────────────────────
$editing = null; // row shown in the form: from ?edit=ID, or the submitted values after a validation error
$errors  = [];   // field => true when server-side validation failed

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $msg    = adminCsrfGuard();
    $action = $str($_POST, 'action');
    $backF  = $str($_POST, 'f');
    $back   = '/admin/announcements.php' . (isset($filters[$backF]) && $backF !== $defaultFilter ? '?f=' . $backF : '');

    // A rejected token must not cost the admin their typing — reflect it back (inert: every value is h()-escaped).
    if ($msg !== '' && $action === 'save') {
        $editing = $fromPost();
    }

    if ($msg === '' && $action === 'save') {
        $in = $fromPost();
        // Lengths are clamped to the column definitions so nothing reaches MySQL out of bounds.
        $title_ta   = sanitizeText($in['title_ta'], 300); // VARCHAR(300)
        $title_en   = sanitizeText($in['title_en'], 300); // VARCHAR(300)
        $body_ta    = sanitizeText($in['body_ta'], 2000);
        $body_en    = sanitizeText($in['body_en'], 2000);
        $start_date = trim($in['start_date']);
        $end_date   = trim($in['end_date']);
        $is_active  = $in['is_active'];
        $id         = $in['id'];
        // Offered only when creating: an edit must not quietly start a second broadcast.
        $notifyDevotees = $id === 0 && isset($_POST['notify_devotees']);

        // A notice needs a title in at least one language; the other language
        // repeats it until the committee translates it.
        if ($title_ta === '' && $title_en === '') { $errors['title_ta'] = true; $errors['title_en'] = true; }
        if ($title_ta === '') $title_ta = $title_en;
        if ($title_en === '') $title_en = $title_ta;
        if ($start_date !== '' && !isValidDate($start_date)) $errors['start_date'] = true;
        if ($end_date !== '' && !isValidDate($end_date))     $errors['end_date'] = true;
        if (!$errors && $start_date !== '' && $end_date !== '' && $end_date < $start_date) $errors['end_date'] = true;

        if ($errors) {
            $msg = '<p class="alert alert--error">' . (isset($errors['title_ta'])
                ? 'A title is required, in Tamil or in English.'
                : 'Dates must be YYYY-MM-DD and the last day may not come before the first.') . '</p>';
            $editing = $in;
        } else {
            $params = [
                ':ta' => $title_ta, ':en' => $title_en,
                ':t'  => $title_en !== '' ? $title_en : $title_ta,     // legacy column: English, else Tamil
                ':bta' => $body_ta !== '' ? $body_ta : null, ':ben' => $body_en !== '' ? $body_en : null,
                ':b'  => $body_en !== '' ? $body_en : ($body_ta !== '' ? $body_ta : null),
                ':sd' => $start_date !== '' ? $start_date : null, ':ed' => $end_date !== '' ? $end_date : null,
                ':a'  => $is_active,
            ];
            if ($id > 0) {
                $params[':id'] = $id;
                $db->prepare('UPDATE announcements SET title=:t, title_ta=:ta, title_en=:en, body=:b, body_ta=:bta, body_en=:ben,
                                 start_date=:sd, end_date=:ed, is_active=:a WHERE id=:id')->execute($params);
                adminAudit('announcement_updated', 'announcement:' . $id, $params[':t']);
                $_SESSION['flash'] = '<p class="alert alert--success">Updated.</p>';
            } else {
                $db->prepare('INSERT INTO announcements (title, title_ta, title_en, body, body_ta, body_en, start_date, end_date, is_active, created_at)
                              VALUES (:t, :ta, :en, :b, :bta, :ben, :sd, :ed, :a, CURRENT_TIMESTAMP)')->execute($params);
                adminAudit('announcement_created', 'announcement:' . (int) $db->lastInsertId(), $params[':t']);
                $_SESSION['flash'] = $notifyDevotees
                    ? announcementDraftNotification(['title_ta' => $title_ta, 'title_en' => $title_en, 'body_ta' => $body_ta, 'body_en' => $body_en])
                    : '<p class="alert alert--success">Created.</p>';
            }
            header('Location: ' . $back, true, 303);
            exit;
        }
    } elseif ($msg === '' && $action === 'toggle') {
        $id   = (int) $str($_POST, 'id');
        $stmt = $db->prepare('UPDATE announcements SET is_active = 1 - is_active WHERE id = :id');
        $stmt->execute([':id' => $id]);
        if ($stmt->rowCount()) {
            adminAudit('announcement_toggled', 'announcement:' . $id);
            $_SESSION['flash'] = '<p class="alert alert--success">Visibility changed.</p>';
        }
        header('Location: ' . $back, true, 303);
        exit;
    } elseif ($msg === '' && $action === 'delete') {
        $id = (int) $str($_POST, 'id');
        if ($id > 0) {
            $gone = $db->prepare('SELECT title FROM announcements WHERE id=:id');
            $gone->execute([':id' => $id]);
            $goneTitle = $gone->fetchColumn();
            $db->prepare('DELETE FROM announcements WHERE id=:id')->execute([':id' => $id]);
            if ($goneTitle !== false) adminAudit('announcement_deleted', 'announcement:' . $id, (string) $goneTitle);
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
$today  = (new DateTime('now', new DateTimeZone('Asia/Kolkata')))->format('Y-m-d'); // temple time, as the public feed
$cap    = 500;
$where  = [];
$params = [];
switch ($filter) {
    case 'active': $where[] = 'is_active = 1'; break;
    case 'hidden': $where[] = 'is_active = 0'; break;
}
if ($q !== '') {
    $like    = '%' . addcslashes($q, '%_\\') . '%';
    $where[] = '(title_ta LIKE :q1 OR title_en LIKE :q2 OR body_ta LIKE :q3 OR body_en LIKE :q4 OR title LIKE :q5 OR body LIKE :q6)';
    $params += [':q1' => $like, ':q2' => $like, ':q3' => $like, ':q4' => $like, ':q5' => $like, ':q6' => $like];
}
$stmt = $db->prepare('SELECT * FROM announcements' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY created_at DESC, id DESC LIMIT ' . ($cap + 1));
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

/** Scheduled (not yet), Expired (no longer) or '' (current) for a row's window. */
$windowState = static function (array $row) use ($today): string {
    if ($row['start_date'] !== null && $row['start_date'] > $today) return 'Scheduled';
    if ($row['end_date'] !== null && $row['end_date'] < $today)     return 'Expired';
    return '';
};

// ── Page ─────────────────────────────────────────────────────────────────────
adminHeader('Announcements', 'Content', [
    'actions' => '<a href="/" target="_blank" rel="noopener" class="btn btn-ghost btn--sm">' . adminIcon('external') . 'View on site</a>',
]);
echo $msg;
echo adminPageIntro(
    'Short notices that scroll in the homepage ticker — newest first, in Tamil and English. Hidden announcements stay saved but are not shown to visitors; a notice with a publish window appears only between those dates.',
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

      <label for="title_ta">
        <span class="field__label">Title (Tamil) <span class="field__required" aria-hidden="true">*</span></span>
        <input id="title_ta" name="title_ta" type="text" lang="ta" required aria-required="true" maxlength="300" autocomplete="off"
               placeholder="எ.கா. கும்பாபிஷேக ஏற்பாடுகள் தொடங்குகின்றன" value="<?= h($editing['title_ta'] ?? '') ?>"<?= $invalid('title_ta') ?> />
        <?= $fieldError('title_ta', 'A title is required, in Tamil or in English.') ?>
        <span class="field__hint">This is the line that scrolls in the ticker — keep it short.</span>
      </label>

      <label for="title_en">
        <span class="field__label">Title (English) <span class="field__optional">optional</span></span>
        <input id="title_en" name="title_en" type="text" maxlength="300" autocomplete="off"
               placeholder="e.g. Kumbabhishekam preparations begin" value="<?= h($editing['title_en'] ?? '') ?>"<?= $invalid('title_en') ?> />
        <?= $fieldError('title_en', 'A title is required, in Tamil or in English.') ?>
        <span class="field__hint">Shown when a visitor reads the site in English. Left blank, the Tamil title is used.</span>
      </label>

      <label for="body_ta">
        <span class="field__label">Body (Tamil) <span class="field__optional">optional</span></span>
        <textarea id="body_ta" name="body_ta" rows="4" lang="ta" maxlength="2000" data-counter><?= h($editing['body_ta'] ?? '') ?></textarea>
        <span class="field__hint">Extra detail shown when a visitor opens the announcement.</span>
      </label>

      <label for="body_en">
        <span class="field__label">Body (English) <span class="field__optional">optional</span></span>
        <textarea id="body_en" name="body_en" rows="4" maxlength="2000" data-counter><?= h($editing['body_en'] ?? '') ?></textarea>
      </label>

      <div class="form-grid">
        <label for="start_date">
          <span class="field__label">Show from <span class="field__optional">optional</span></span>
          <input id="start_date" name="start_date" type="date" value="<?= h($editing['start_date'] ?? '') ?>"<?= $invalid('start_date') ?> />
          <?= $fieldError('start_date', 'Enter a valid date (YYYY-MM-DD).') ?>
          <span class="field__hint">Left blank, the notice is shown at once.</span>
        </label>
        <label for="end_date">
          <span class="field__label">Show until <span class="field__optional">optional</span></span>
          <input id="end_date" name="end_date" type="date" value="<?= h($editing['end_date'] ?? '') ?>"<?= $invalid('end_date') ?> />
          <?= $fieldError('end_date', 'Enter a valid last day, on or after the first.') ?>
          <span class="field__hint">Last day it is shown, inclusive. Left blank, it stays until hidden.</span>
        </label>
      </div>

      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= (!$editing || !empty($editing['is_active'])) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Active</strong><span class="switch__desc">Shown in the homepage ticker. Hidden announcements stay saved.</span></span>
      </label>

      <?php if (!$isEdit && devoteeNotifyReady()): ?>
      <label class="switch">
        <input type="checkbox" name="notify_devotees" value="1"<?= !empty($editing['notify_devotees']) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Also notify devotees</strong><span class="switch__desc">Creates a draft email and WhatsApp notification to the families who agreed to temple updates, for you to review. Nothing is sent until it is submitted from the Notifications page.</span></span>
      </label>
      <?php endif; ?>

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
            <th scope="col">Window</th>
            <th scope="col">Status</th>
            <th scope="col">Created</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($rows as $row): $rid = (int) $row['id']; $state = $windowState($row); $bodyText = $row['body_en'] ?? $row['body_ta'] ?? $row['body']; ?>
          <tr>
            <td>
              <span class="cell-title" lang="ta"><?= h($row['title_ta'] !== '' ? $row['title_ta'] : $row['title']) ?></span>
              <?php if ($row['title_en'] !== '' && $row['title_en'] !== $row['title_ta']): ?><span class="cell-sub"><?= h($row['title_en']) ?></span><?php endif; ?>
            </td>
            <td><?= $bodyText !== null && $bodyText !== '' ? '<span class="cell-clip">' . h($bodyText) . '</span>' : '<span class="cell-muted">—</span>' ?></td>
            <td class="cell-date">
              <?php if ($row['start_date'] === null && $row['end_date'] === null): ?>
                <span class="cell-muted">Always</span>
              <?php else: ?>
                <?= $row['start_date'] !== null ? adminFmtDate($row['start_date']) : 'Now' ?> – <?= $row['end_date'] !== null ? adminFmtDate($row['end_date']) : 'no end' ?>
              <?php endif; ?>
            </td>
            <td>
              <span class="cluster">
                <?= $row['is_active'] ? adminBadge('Active', 'success') : adminBadge('Hidden', 'muted') ?>
                <?php if ($state !== ''): ?><?= adminBadge($state, $state === 'Scheduled' ? 'info' : 'warning') ?><?php endif; ?>
              </span>
            </td>
            <td class="cell-date"><time datetime="<?= h($row['created_at']) ?>"><?= adminFmtDate($row['created_at'], true) ?></time></td>
            <td class="cell-actions">
              <?= adminMenu([
                  ['label' => 'Edit', 'icon' => 'pencil', 'href' => $listUrl(['edit' => $rid])],
                  ['label' => $row['is_active'] ? 'Hide' : 'Show', 'icon' => $row['is_active'] ? 'eye-off' : 'eye',
                   'form' => ['action' => 'toggle', 'id' => $rid, 'f' => $filter]],
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
