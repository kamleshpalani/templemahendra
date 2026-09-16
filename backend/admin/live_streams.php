<?php
// backend/admin/live_streams.php — Live Streaming (docs/live/SPEC-PHASE1.md §4.5):
// the live darshan broadcasts the committee schedules, goes live with, ends and
// archives, shown to devotees on /live-darshan.
//
// The page owns no stream logic. Validation is liveValidate(), every write is
// liveInsert() / liveUpdate() / liveSoftDelete() / liveRestore() /
// liveSetStatus() (backend/includes/live/store.php) — the same functions the
// admin JSON API calls — so the page, the API and Phase 3's poller can never
// disagree about a stream.
//
// Permissions (auth.php): reading needs live.view (viewer); creating, editing,
// deleting and restoring need live.manage (editor); the status buttons need
// live.publish (editor). requireAdminAuth() refuses a viewer's POST before this
// file's own handlers run; the explicit checks below keep each rule visible
// where its action lives.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/live.php';
require_once __DIR__ . '/includes/admin_layout.php';

const LIVE_ADMIN_BASE     = '/admin/live_streams.php';
const LIVE_ADMIN_PER_PAGE = 25;

$db         = getDB();
$tables     = liveTablesExist();
$me         = currentAdmin() ?? [];
$actor      = (string) ($me['username'] ?? 'admin');
$canManage  = adminCan('live.manage');
$canPublish = adminCan('live.publish');

/** String value from a request array ('' when missing or not scalar). */
$str = static fn(array $src, string $key): string => is_scalar($src[$key] ?? null) ? (string) $src[$key] : '';

/** Queue a flash for the page this request redirects to. */
function lsFlash(string $tone, string $text): void
{
    $_SESSION['flash'] = '<p class="alert alert--' . $tone . '" role="status">' . h($text) . '</p>';
}

/**
 * A row's "⋯" menu. Like adminMenu(), but a link may open in a new tab (the
 * public page) — items: ['label','icon', 'href' [, 'target'] | 'form' => […] [, 'confirm', 'danger']].
 */
function lsRowMenu(array $items, string $label): string
{
    static $n = 0;
    $id  = 'ls-menu-' . (++$n);
    $out = '<div class="dropdown row-menu">';
    $out .= '<button type="button" class="btn btn-ghost btn--icon btn--sm" aria-haspopup="menu" aria-expanded="false" aria-controls="' . $id . '" aria-label="' . h($label) . '" data-menu-toggle>' . adminIcon('more') . '</button>';
    $out .= '<div class="menu" id="' . $id . '" role="menu" hidden>';
    foreach ($items as $it) {
        if ($it === 'divider') { $out .= '<div class="menu__divider" role="separator"></div>'; continue; }
        $cls = 'menu__item' . (!empty($it['danger']) ? ' menu__item--danger' : '');
        $ico = !empty($it['icon']) ? adminIcon($it['icon']) : '';
        if (!empty($it['href'])) {
            $target = !empty($it['target']) ? ' target="' . h($it['target']) . '" rel="noopener"' : '';
            $out .= '<a class="' . $cls . '" role="menuitem" href="' . h($it['href']) . '"' . $target . '>' . $ico . h($it['label']) . '</a>';
        } elseif (!empty($it['form'])) {
            $out .= '<form method="POST" class="menu__form" action="' . h(LIVE_ADMIN_BASE) . '">' . csrfField();
            foreach ($it['form'] as $k => $v) {
                $out .= '<input type="hidden" name="' . h($k) . '" value="' . h((string) $v) . '" />';
            }
            $confirm = !empty($it['confirm']) ? ' data-confirm="' . h($it['confirm']) . '" data-confirm-label="' . h($it['confirmLabel'] ?? $it['label']) . '"' : '';
            $out .= '<button type="submit" class="' . $cls . '" role="menuitem"' . $confirm . '>' . $ico . h($it['label']) . '</button></form>';
        }
    }
    return $out . '</div></div>';
}

// ── Flash left by the previous request (POST → 303 → GET) ────────────────────
$msg = '';
if (!empty($_SESSION['flash'])) {
    $msg = (string) $_SESSION['flash'];
    unset($_SESSION['flash']);
}

// ── List filters (whitelisted; read from the request that carried them) ──────
$src     = $_SERVER['REQUEST_METHOD'] === 'POST' ? $_POST : $_GET; // a failed save must keep the list state
$filters = liveAdminFilters($src);
$query   = ['f' => $filters['f'] === 'all' ? '' : $filters['f'], 'q' => $filters['q'], 'sort' => $filters['sort'], 'dir' => $filters['dir']];
$listUrl = static fn(array $override = []): string => LIVE_ADMIN_BASE . rtrim(adminQuery($query, $override), '?');
$formState = ['f' => $filters['f'], 'q' => $filters['q'], 'sort' => $filters['sort'], 'dir' => $filters['dir']];

// ── Create / update / status / delete / restore ──────────────────────────────
$editing = null; // form values (input shape): from ?edit=ID, or the submitted values after a validation error
$errors  = [];   // field => message

/** The submitted form as liveValidate() reads it; checkboxes become '1'/'0', non-text stays for the validator to report. */
$postedInput = static function (): array {
    $in = [];
    foreach (LIVE_INPUT_KEYS as $k) {
        if (isset(LIVE_FLAG_DEFAULTS[$k])) $in[$k] = isset($_POST[$k]) ? '1' : '0';
        else $in[$k] = $_POST[$k] ?? '';
    }
    return $in;
};
/** The same values, scalar-only, for re-filling the inputs (inert: every value is h()-escaped on output). */
$typedValues = static function (array $in, int $id): array {
    $out = ['id' => $id];
    foreach ($in as $k => $v) $out[$k] = is_scalar($v) ? (string) $v : '';
    return $out;
};

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // A multipart body larger than post_max_size reaches PHP with $_POST and
    // $_FILES emptied, which would otherwise trip the CSRF guard and wrongly
    // blame the admin's session. Detect it before the guard runs.
    if (!$_POST && !$_FILES && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
        $msg = '<p class="alert alert--error" role="alert">That upload was too large for the server (limit '
             . h((string) ini_get('post_max_size')) . '). Use a smaller image and try again.</p>';
        $editing = ['id' => 0];
    } else {
        $msg = adminCsrfGuard();
    }
    $action = $str($_POST, 'action');
    $back   = $listUrl();

    // A rejected token must not cost the admin their typing — reflect it back.
    if ($msg !== '' && $action === 'save') {
        $editing = $typedValues($postedInput(), (int) $str($_POST, 'id'));
    }

    if ($msg === '' && !$tables) {
        lsFlash('error', 'Live streaming is not installed yet: apply database migration 011_live_streams.sql first.');
        header('Location: ' . $back, true, 303);
        exit;
    }

    if ($msg === '' && $action === 'save') {
        requireAdminCan('live.manage');
        $id       = (int) $str($_POST, 'id');
        $existing = $id > 0 ? liveLoad($db, $id) : null;
        if ($id > 0 && $existing === null) {
            lsFlash('warning', 'That stream no longer exists (or is in the bin).');
            header('Location: ' . $back, true, 303);
            exit;
        }
        $in       = $postedInput();
        $uploaded = [];
        // Uploaded files win over the URL fields when both are given.
        foreach (['thumbnail' => 'thumbnail_url', 'banner' => 'banner_url'] as $file => $key) {
            if (!isset($_FILES[$file]) || !is_array($_FILES[$file])) continue;
            $r = liveStoreImage($_FILES[$file], $file);
            if ($r['ok']) {
                $in[$key] = $r['url'];
                $uploaded[$key] = $r['url'];
            } elseif ($r['error'] !== null) {
                $errors[$file] = $r['error'];
            }
        }
        $v = liveValidate($in, $existing, $db);
        $errors += $v['errors'];
        $statusChange = $existing !== null && (string) $v['values']['status'] !== (string) $existing['status'];
        if ($statusChange && !$canPublish && !isset($errors['status'])) {
            $errors['status'] = 'Your role cannot change a stream’s status.';
        }
        if (!$errors) {
            try {
                if ($existing !== null) {
                    liveUpdate($db, $id, $v['values'], $actor);
                    // A replaced upload of ours is removed; a pasted link or a gallery file is not ours to delete.
                    foreach ($uploaded as $key => $url) {
                        $old = (string) ($existing[$key] ?? '');
                        if ($old !== '' && $old !== $url && liveIsOwnUpload($old)) liveDeleteUpload($old);
                    }
                    lsFlash('success', $statusChange ? 'Updated. Status changed to ' . $v['values']['status'] . '.' : 'Updated.');
                } else {
                    liveInsert($db, $v['values'], $actor);
                    lsFlash('success', 'Created.');
                }
                header('Location: ' . $back, true, 303);
                exit;
            } catch (LiveTransitionException $e) {
                $errors['status'] = 'That status change is not allowed.';
            } catch (LiveValidationException $e) {
                // liveSetStatus() re-checked the stored row for the new status; nothing was saved.
                $errors += $e->fields;
            }
        }
        // Nothing was saved: the uploaded files would be orphans.
        foreach ($uploaded as $url) liveDeleteUpload($url);
        $editing = $typedValues($in, $id);
        foreach ($uploaded as $key => $url) $editing[$key] = (string) ($existing[$key] ?? ''); // the upload is gone; show what is stored
        $msg = '<p class="alert alert--error" role="alert" data-keep>Please correct the highlighted fields. Nothing has been saved.</p>';
    } elseif ($msg === '' && $action === 'status') {
        requireAdminCan('live.publish');
        $id = (int) $str($_POST, 'id');
        $to = strtoupper(trim($str($_POST, 'to')));
        try {
            $r = liveSetStatus($db, $id, $to, $actor);
            lsFlash($r['changed'] ? 'success' : 'info', $r['changed'] ? 'Status changed to ' . $r['to'] . '.' : 'Already ' . liveStatusLabel($r['to']) . '.');
        } catch (LiveTransitionException $e) {
            lsFlash('error', 'That status change is not allowed.');
        } catch (LiveValidationException $e) {
            // A draft without a video id or a start time cannot be published by a
            // button either: the same field rules the form applies, as one flash.
            $verb = match ($to) { 'LIVE' => 'go live', 'STARTING' => 'mark it as starting', default => 'publish' };
            lsFlash('error', 'Cannot ' . $verb . ' yet: ' . implode(' ', array_unique($e->fields)) . ' Edit the stream first.');
        } catch (RuntimeException $e) {
            lsFlash('warning', 'That stream no longer exists.');
        }
        header('Location: ' . $back, true, 303);
        exit;
    } elseif ($msg === '' && $action === 'delete') {
        requireAdminCan('live.manage');
        $id = (int) $str($_POST, 'id');
        $ok = liveSoftDelete($db, $id, $actor);
        lsFlash($ok ? 'success' : 'warning', $ok ? 'Deleted.' : 'That stream no longer exists.');
        header('Location: ' . $back, true, 303);
        exit;
    } elseif ($msg === '' && $action === 'restore') {
        requireAdminCan('live.manage');
        $id = (int) $str($_POST, 'id');
        if (liveRestore($db, $id, $actor)) lsFlash('success', 'Restored.');
        else lsFlash('warning', 'That stream is not in the bin.');
        header('Location: ' . $back, true, 303);
        exit;
    } elseif ($msg === '') {
        lsFlash('error', 'That action is not available on this page.');
        header('Location: ' . $back, true, 303);
        exit;
    }
}

// ── Not installed yet ────────────────────────────────────────────────────────
if (!$tables) {
    adminHeader('Live Streaming', 'Content');
    echo $msg;
    echo adminPageIntro('Live darshan broadcasts are not set up on this database yet.');
    echo '<section class="card card--static"><div class="card__body">'
       . '<div class="alert alert--info" data-keep><span class="alert__icon">' . adminIcon('info') . '</span><div class="alert__body">'
       . '<span class="alert__title">One migration away</span>'
       . 'Run <code>database/migrations/011_live_streams.sql</code> against this database to enable live streaming. '
       . 'Until then the public Live Darshan page shows that nothing is scheduled.'
       . '</div></div>'
       . '<pre class="cols">mysql --default-character-set=utf8mb4 -u &lt;user&gt; -p &lt;database&gt; &lt; database/migrations/011_live_streams.sql</pre>'
       . '</div></section>';
    adminFooter();
    exit;
}

// ── Row being edited (?edit=ID) ──────────────────────────────────────────────
$existingRow = null;
if ($editing === null && isset($_GET['edit'])) {
    $editId = (int) $str($_GET, 'edit');
    $row = $editId > 0 ? liveLoad($db, $editId, true) : null;
    if ($row === null) {
        if ($msg === '') $msg = '<p class="alert alert--warning" role="status">That stream no longer exists.</p>';
    } elseif ($row['deleted_at'] !== null) {
        if ($msg === '') $msg = '<p class="alert alert--warning" role="status">That stream is in the bin. Restore it from the Deleted list to edit it.</p>';
    } else {
        $existingRow = $row;
        $editing = liveRowToInput($row) + ['id' => (int) $row['id']];
    }
} elseif ($editing !== null && (int) ($editing['id'] ?? 0) > 0) {
    $existingRow = liveLoad($db, (int) $editing['id']);
}
$isEdit   = !empty($editing['id']);
$formOpen = $editing !== null;

// ── List ─────────────────────────────────────────────────────────────────────
$list       = liveListAdmin($db, $filters, $filters['page'], LIVE_ADMIN_PER_PAGE);
$counts     = liveAdminCounts($db);
$rows       = $list['rows'];
$temples    = liveTempleOptions($db);
$deities    = liveDeityOptions($db);
$filtered   = $filters['f'] !== 'all' || $filters['q'] !== '';
$countLabel = $filtered
    ? $list['total'] . ' of ' . $counts['all'] . ' record' . ($counts['all'] === 1 ? '' : 's')
    : $list['total'] . ' record' . ($list['total'] === 1 ? '' : 's');

// ── Form helpers ─────────────────────────────────────────────────────────────
$val        = static fn(string $k, string $default = ''): string => (string) ($editing[$k] ?? $default);
$invalid    = static fn(string $f): string => isset($errors[$f]) ? ' aria-invalid="true" aria-describedby="err-' . $f . '"' : '';
$fieldError = static fn(string $f): string => isset($errors[$f]) ? '<span class="field__error" id="err-' . $f . '">' . adminIcon('alert-circle') . h((string) $errors[$f]) . '</span>' : '';
$disabled   = $canManage ? '' : ' disabled';
$currentStatus  = $existingRow !== null ? (string) $existingRow['status'] : 'DRAFT';
$statusChoices  = $isEdit ? array_merge([$currentStatus], LIVE_TRANSITIONS[$currentStatus] ?? []) : LIVE_CREATE_STATUSES;
$slugLocked     = $isEdit && $currentStatus !== 'DRAFT';
$defaultTz      = $editing === null ? (string) (reset($temples)['timezone'] ?? liveTempleTz()) : $val('timezone', liveTempleTz());
$tzSelected     = liveIsTimezone($defaultTz) ? $defaultTz : liveTempleTz();
$parsedId       = $existingRow !== null ? (string) ($existingRow['provider_broadcast_id'] ?? '') : '';
$deitiesByTemple = [];
foreach ($deities as $d) $deitiesByTemple[$d['temple_id']][] = $d;

// ── Page ─────────────────────────────────────────────────────────────────────
adminHeader('Live Streaming', 'Content', [
    'actions' => '<a href="/live-darshan" target="_blank" rel="noopener" class="btn btn-ghost btn--sm">' . adminIcon('external') . 'Open /live-darshan</a>',
]);
echo $msg;
echo adminPageIntro(
    'Live darshan broadcasts on YouTube: schedule a stream, go live when the pooja starts and end it afterwards. Devotees watch on the public Live Darshan page; drafts stay private until published.',
    ($canManage ? '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="crud" aria-expanded="false">' . adminIcon('plus') . ' New live stream</button>' : '')
    . '<a href="/live-darshan" target="_blank" rel="noopener" class="btn btn--sm">' . adminIcon('external') . ' Open /live-darshan</a>'
);
?>

<div class="admin-two-col admin-two-col--wide-form admin-two-col--collapsible" id="crud" data-editing="<?= $formOpen ? '1' : '0' ?>">

  <section class="card card--solid card--static admin-form-box" id="new" aria-labelledby="form-title">
    <h2 id="form-title"><?= adminIcon($isEdit ? 'pencil' : 'plus') ?> <?= $isEdit ? 'Edit live stream' : 'New live stream' ?></h2>
    <?php if (!$canManage): ?>
      <p class="field__hint mb-4">Your role can read live streams but not change them.</p>
    <?php endif; ?>
    <form method="POST" action="<?= h(LIVE_ADMIN_BASE) ?>" enctype="multipart/form-data" id="live-form" novalidate>
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save" />
      <?php foreach ($formState as $k => $v): ?><input type="hidden" name="<?= h($k) ?>" value="<?= h((string) $v) ?>" /><?php endforeach; ?>
      <?php if ($isEdit): ?><input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" /><?php endif; ?>

      <?php if ($errors): ?>
      <div class="alert alert--error" role="alert" tabindex="-1" id="live-errors" data-keep data-focus-on-load>
        <span class="alert__icon"><?= adminIcon('alert-circle') ?></span>
        <div class="alert__body">
          <span class="alert__title"><?= count($errors) ?> thing<?= count($errors) === 1 ? ' needs' : 's need' ?> correcting. Nothing has been saved.</span>
          <ul>
            <?php foreach ($errors as $key => $message): ?>
              <li><a href="#<?= h((string) $key) ?>"><?= h((string) $message) ?></a></li>
            <?php endforeach; ?>
          </ul>
        </div>
      </div>
      <?php endif; ?>

      <fieldset<?= $disabled ?>>
        <legend>Titles</legend>
        <label for="title_en">
          <span class="field__label">English title <span class="field__required" aria-hidden="true">*</span></span>
          <input id="title_en" name="title_en" type="text" required aria-required="true" maxlength="300" autocomplete="off"
                 placeholder="e.g. Pournami Abhishekam – live darshan" value="<?= h($val('title_en')) ?>"<?= $invalid('title_en') ?> />
          <?= $fieldError('title_en') ?>
        </label>
        <label for="title_ta">
          <span class="field__label">Tamil title <span class="field__required" aria-hidden="true">*</span></span>
          <input id="title_ta" name="title_ta" type="text" lang="ta" required aria-required="true" maxlength="300" autocomplete="off"
                 placeholder="எ.கா. பௌர்ணமி அபிஷேகம் – நேரடி தரிசனம்" value="<?= h($val('title_ta')) ?>"<?= $invalid('title_ta') ?> />
          <?= $fieldError('title_ta') ?>
        </label>
        <label for="slug">
          <span class="field__label">Page address <span class="field__optional">/live-darshan/…</span></span>
          <input id="slug" name="slug" type="text" maxlength="120" autocomplete="off" spellcheck="false" autocapitalize="off"
                 pattern="(?![0-9]+$)[a-z0-9][a-z0-9-]{1,118}" placeholder="made from the English title"
                 value="<?= h($val('slug')) ?>"<?= $invalid('slug') ?><?= $slugLocked ? ' readonly' : '' ?> data-slug-target="<?= $isEdit ? '0' : '1' ?>" />
          <?= $fieldError('slug') ?>
          <span class="field__hint"><?= $slugLocked ? 'Locked after publishing so shared links keep working.' : 'Lowercase letters, numbers and hyphens (not digits only). Filled in from the English title; edit if you like.' ?></span>
        </label>
        <label for="description_en">
          <span class="field__label">English description <span class="field__optional">optional</span></span>
          <textarea id="description_en" name="description_en" rows="3" maxlength="5000" data-counter<?= $invalid('description_en') ?>><?= h($val('description_en')) ?></textarea>
          <?= $fieldError('description_en') ?>
        </label>
        <label for="description_ta">
          <span class="field__label">Tamil description <span class="field__optional">optional</span></span>
          <textarea id="description_ta" name="description_ta" lang="ta" rows="3" maxlength="5000" data-counter<?= $invalid('description_ta') ?>><?= h($val('description_ta')) ?></textarea>
          <?= $fieldError('description_ta') ?>
        </label>
      </fieldset>

      <fieldset<?= $disabled ?>>
        <legend>Temple and programme</legend>
        <div class="form-grid">
          <label for="temple_id">
            <span class="field__label">Temple <span class="field__required" aria-hidden="true">*</span></span>
            <select id="temple_id" name="temple_id" required aria-required="true"<?= $invalid('temple_id') ?>>
              <?php $templeSel = $val('temple_id', (string) (array_key_first($temples) ?? '')); ?>
              <?php foreach ($temples as $t): ?>
                <option value="<?= (int) $t['id'] ?>"<?= (string) $t['id'] === $templeSel ? ' selected' : '' ?>><?= h($t['short_name_en']) ?></option>
              <?php endforeach; ?>
            </select>
            <?= $fieldError('temple_id') ?>
          </label>
          <label for="deity_id">
            <span class="field__label">Deity <span class="field__optional">optional</span></span>
            <select id="deity_id" name="deity_id"<?= $invalid('deity_id') ?>>
              <option value="">— none —</option>
              <?php foreach ($deitiesByTemple as $tid => $list2): ?>
                <optgroup label="<?= h($temples[$tid]['short_name_en'] ?? ('Temple #' . (int) $tid)) ?>">
                  <?php foreach ($list2 as $d): ?>
                    <option value="<?= (int) $d['id'] ?>"<?= (string) $d['id'] === $val('deity_id') ? ' selected' : '' ?>><?= h($d['name_en']) ?> · <?= h($d['name_ta']) ?></option>
                  <?php endforeach; ?>
                </optgroup>
              <?php endforeach; ?>
            </select>
            <?= $fieldError('deity_id') ?>
          </label>
          <label for="event_type">
            <span class="field__label">Programme type</span>
            <select id="event_type" name="event_type"<?= $invalid('event_type') ?>>
              <?php $typeSel = $val('event_type', 'live_darshan'); ?>
              <?php foreach (LIVE_EVENT_TYPES as $key => $labels): ?>
                <option value="<?= h($key) ?>"<?= $key === $typeSel ? ' selected' : '' ?>><?= h($labels[1]) ?> · <?= h($labels[0]) ?></option>
              <?php endforeach; ?>
            </select>
            <?= $fieldError('event_type') ?>
          </label>
          <label for="status">
            <span class="field__label">Status</span>
            <?php $statusSel = in_array($val('status', $currentStatus), $statusChoices, true) ? $val('status', $currentStatus) : $currentStatus; ?>
            <select id="status" name="status"<?= $invalid('status') ?><?= $isEdit && !$canPublish ? ' disabled' : '' ?>>
              <?php foreach ($statusChoices as $s): ?>
                <option value="<?= h($s) ?>"<?= $s === $statusSel ? ' selected' : '' ?>><?= h(liveStatusLabel($s)) ?><?= $isEdit && $s === $currentStatus ? ' (current)' : '' ?></option>
              <?php endforeach; ?>
            </select>
            <?php if ($isEdit && !$canPublish): ?><input type="hidden" name="status" value="<?= h($currentStatus) ?>" /><?php endif; ?>
            <?= $fieldError('status') ?>
            <span class="field__hint"><?= $isEdit ? 'Only the changes allowed from the current status are offered; the buttons in the list do the same.' : 'Draft stays private; Scheduled appears on the public page.' ?></span>
          </label>
        </div>
      </fieldset>

      <fieldset<?= $disabled ?>>
        <legend>Video</legend>
        <div class="form-grid">
          <label for="provider">
            <span class="field__label">Streaming provider</span>
            <?php $provSel = $val('provider', 'youtube'); ?>
            <select id="provider" name="provider"<?= $invalid('provider') ?>>
              <?php foreach (LIVE_PROVIDERS as $key => $label): $on = liveProviderFor($key)->isConfigured(); ?>
                <option value="<?= h($key) ?>"<?= $key === $provSel ? ' selected' : '' ?><?= $on ? '' : ' disabled' ?>><?= h($label) ?><?= $on ? '' : ' — coming later' ?></option>
              <?php endforeach; ?>
            </select>
            <?= $fieldError('provider') ?>
          </label>
          <label for="provider_reference">
            <span class="field__label">Provider video ID</span>
            <input id="provider_reference" name="provider_reference" type="text" maxlength="500" autocomplete="off" spellcheck="false"
                   placeholder="Video ID or YouTube link" value="<?= h($val('provider_reference')) ?>"<?= $invalid('provider_reference') ?> />
            <?= $fieldError('provider_reference') ?>
            <span class="field__hint">
              <?php if ($parsedId !== ''): ?>
                Video ID <code><?= h($parsedId) ?></code> ·
                <a href="<?= h(liveYoutubeWatchUrl($parsedId)) ?>" target="_blank" rel="noopener">Preview on YouTube</a>
              <?php else: ?>
                Paste the video ID (11 characters) or any YouTube link to the broadcast. Required before publishing.
              <?php endif; ?>
            </span>
          </label>
        </div>
        <label for="playback_url">
          <span class="field__label">Playback URL <span class="field__optional">optional</span></span>
          <input id="playback_url" name="playback_url" type="text" inputmode="url" maxlength="500" autocomplete="off" spellcheck="false"
                 placeholder="https://…" value="<?= h($val('playback_url')) ?>"<?= $invalid('playback_url') ?> />
          <?= $fieldError('playback_url') ?>
          <span class="field__hint">Filled automatically for YouTube; override only if needed.</span>
        </label>
        <div class="form-grid">
          <div class="field<?= isset($errors['thumbnail']) || isset($errors['thumbnail_url']) ? ' field--error' : '' ?>">
            <label for="thumbnail_url">
              <span class="field__label">Thumbnail <span class="field__optional">optional</span></span>
              <input id="thumbnail_url" name="thumbnail_url" type="text" inputmode="url" maxlength="500" autocomplete="off" spellcheck="false"
                     placeholder="/uploads/… or https://…" value="<?= h($val('thumbnail_url')) ?>"<?= $invalid('thumbnail_url') ?> />
              <?= $fieldError('thumbnail_url') ?>
            </label>
            <label for="thumbnail">
              <span class="field__label">Upload a thumbnail</span>
              <input id="thumbnail" name="thumbnail" type="file" accept="image/jpeg,image/png,image/webp"<?= $invalid('thumbnail') ?> />
              <?= $fieldError('thumbnail') ?>
              <span class="field__hint">JPEG, PNG or WebP · ≤ <?= (int) UPLOAD_MAX_MB ?> MB, 16:9 recommended. An upload replaces the link above. Blank = the YouTube thumbnail.</span>
            </label>
            <?php if ($val('thumbnail_url') !== ''): ?>
              <img class="thumb" src="<?= h($val('thumbnail_url')) ?>" alt="Current thumbnail" loading="lazy" width="48" height="48" />
            <?php endif; ?>
          </div>
          <div class="field<?= isset($errors['banner']) || isset($errors['banner_url']) ? ' field--error' : '' ?>">
            <label for="banner_url">
              <span class="field__label">Banner <span class="field__optional">optional</span></span>
              <input id="banner_url" name="banner_url" type="text" inputmode="url" maxlength="500" autocomplete="off" spellcheck="false"
                     placeholder="/uploads/… or https://…" value="<?= h($val('banner_url')) ?>"<?= $invalid('banner_url') ?> />
              <?= $fieldError('banner_url') ?>
            </label>
            <label for="banner">
              <span class="field__label">Upload a banner</span>
              <input id="banner" name="banner" type="file" accept="image/jpeg,image/png,image/webp"<?= $invalid('banner') ?> />
              <?= $fieldError('banner') ?>
              <span class="field__hint">JPEG, PNG or WebP · ≤ <?= (int) UPLOAD_MAX_MB ?> MB, 16:9 recommended. Shown as the poster before the stream starts.</span>
            </label>
            <?php if ($val('banner_url') !== ''): ?>
              <img class="thumb" src="<?= h($val('banner_url')) ?>" alt="Current banner" loading="lazy" width="48" height="48" />
            <?php endif; ?>
          </div>
        </div>
      </fieldset>

      <fieldset<?= $disabled ?>>
        <legend>Schedule</legend>
        <div class="form-grid">
          <label for="scheduled_date">
            <span class="field__label">Date</span>
            <input id="scheduled_date" name="scheduled_date" type="date" value="<?= h($val('scheduled_date')) ?>"<?= $invalid('scheduled_date') ?> />
            <?= $fieldError('scheduled_date') ?>
          </label>
          <label for="start_time">
            <span class="field__label">Start time</span>
            <input id="start_time" name="start_time" type="time" value="<?= h($val('start_time')) ?>"<?= $invalid('start_time') ?> />
            <?= $fieldError('start_time') ?>
          </label>
          <label for="end_time">
            <span class="field__label">End time <span class="field__optional">optional</span></span>
            <input id="end_time" name="end_time" type="time" value="<?= h($val('end_time')) ?>"<?= $invalid('end_time') ?> />
            <?= $fieldError('end_time') ?>
          </label>
          <label for="end_date">
            <span class="field__label">End date <span class="field__optional">only if overnight</span></span>
            <input id="end_date" name="end_date" type="date" value="<?= h($val('end_date')) ?>"<?= $invalid('end_date') ?> />
            <?= $fieldError('end_date') ?>
          </label>
        </div>
        <label for="timezone">
          <span class="field__label">Time zone</span>
          <select id="timezone" name="timezone"<?= $invalid('timezone') ?>>
            <?php foreach (liveTimezoneGroups() as $region => $zones): ?>
              <optgroup label="<?= h($region) ?>">
                <?php foreach ($zones as $tz): ?>
                  <option value="<?= h($tz) ?>"<?= $tz === $tzSelected ? ' selected' : '' ?>><?= h($tz === 'Asia/Kolkata' ? 'Asia/Kolkata (IST)' : $tz) ?></option>
                <?php endforeach; ?>
              </optgroup>
            <?php endforeach; ?>
          </select>
          <?= $fieldError('timezone') ?>
          <span class="field__hint">The date and times above are in this zone. Required before publishing; a draft may leave the schedule blank.</span>
        </label>
      </fieldset>

      <fieldset<?= $disabled ?>>
        <legend>Options</legend>
        <?php
        $switches = [
            'is_featured'           => ['Featured', 'Highlighted among the upcoming darshans.'],
            'show_on_homepage'      => ['Show on homepage', 'Offered to the homepage once that block exists (Phase 2).'],
            'donations_enabled'     => ['Enable donations', 'Show the donate button beside the player.'],
            'notifications_enabled' => ['Enable notifications', 'Allow reminders for this stream (later phase).'],
            'sharing_enabled'       => ['Enable sharing', 'Show the share button on the stream page.'],
            'archive_enabled'       => ['Enable archive', 'Keep the recording in the archive after it ends (later phase).'],
        ];
        foreach ($switches as $flag => [$label, $desc]):
            $on = $editing === null ? (bool) LIVE_FLAG_DEFAULTS[$flag] : $val($flag) === '1'; ?>
          <label class="switch">
            <input type="checkbox" name="<?= h($flag) ?>" value="1"<?= $on ? ' checked' : '' ?> />
            <span class="switch__track" aria-hidden="true"></span>
            <span class="switch__label"><strong><?= h($label) ?></strong><span class="switch__desc"><?= h($desc) ?></span></span>
          </label>
        <?php endforeach; ?>
      </fieldset>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary"<?= $disabled ?>><?= adminIcon('check') ?> <?= $isEdit ? 'Save changes' : 'Save live stream' ?></button>
        <?php if ($formOpen): ?><a href="<?= h($listUrl()) ?>" class="btn btn-ghost">Cancel</a><?php endif; ?>
      </div>
    </form>
  </section>

  <div class="admin-list">
    <form method="GET" action="<?= h(LIVE_ADMIN_BASE) ?>" class="toolbar" role="search">
      <?php if ($filters['f'] !== 'all'): ?><input type="hidden" name="f" value="<?= h($filters['f']) ?>" /><?php endif; ?>
      <input type="hidden" name="sort" value="<?= h($filters['sort']) ?>" />
      <input type="hidden" name="dir" value="<?= h($filters['dir']) ?>" />
      <div class="toolbar__search">
        <?= adminIcon('search') ?>
        <label for="q" class="sr-only">Search live streams</label>
        <input id="q" type="search" name="q" value="<?= h($filters['q']) ?>" placeholder="Search by title, address or video ID…" autocomplete="off" maxlength="100" />
        <button type="submit" class="sr-only">Search</button>
      </div>
      <nav class="filter-chips" aria-label="Filter live streams">
        <?php foreach (LIVE_ADMIN_FILTERS as $key => $label): ?>
          <a class="chip" href="<?= h($listUrl(['f' => $key === 'all' ? '' : $key, 'page' => ''])) ?>"<?= $key === $filters['f'] ? ' aria-current="page"' : '' ?>>
            <?= h($label) ?> <span class="chip__count"><?= (int) ($counts[$key] ?? 0) ?></span>
          </a>
        <?php endforeach; ?>
      </nav>
      <?php if ($filters['q'] !== ''): ?>
        <a href="<?= h($listUrl(['q' => '', 'page' => ''])) ?>" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Clear search</a>
      <?php endif; ?>
      <span class="toolbar__count" aria-live="polite"><?= h($countLabel) ?></span>
    </form>

    <?php if ($rows): ?>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <?= adminSortLink('title', 'Title', $query) ?>
            <th scope="col">Temple / Deity</th>
            <th scope="col">Type</th>
            <?= adminSortLink('schedule', 'Schedule', $query) ?>
            <?= adminSortLink('status', 'Status', $query) ?>
            <th scope="col">Provider</th>
            <?= adminSortLink('updated', 'Updated', $query) ?>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($rows as $row):
              $rid      = (int) $row['id'];
              $status   = (string) $row['status'];
              $deleted  = $row['deleted_at'] !== null;
              $tz       = (string) $row['timezone'];
              $schedule = liveAdminSchedule($row);
              $typeLbl  = LIVE_EVENT_TYPES[$row['event_type']] ?? LIVE_EVENT_TYPES['other'];
              $menu     = [];
              if (!$deleted) {
                  $menu[] = ['label' => 'Edit', 'icon' => 'pencil', 'href' => $listUrl(['edit' => $rid])];
                  $menu[] = ['label' => 'View page', 'icon' => 'external', 'href' => '/live-darshan/' . rawurlencode((string) $row['slug']), 'target' => '_blank'];
                  if ($canPublish) {
                      $actions = liveAdminActions($row);
                      if ($actions) $menu[] = 'divider';
                      foreach ($actions as $a) {
                          $menu[] = ['label' => $a['label'], 'icon' => $a['icon'], 'danger' => $a['danger'],
                                     'form' => ['action' => 'status', 'id' => $rid, 'to' => $a['to']] + $formState,
                                     'confirm' => $a['confirm'], 'confirmLabel' => $a['label']];
                      }
                  }
                  if ($canManage) {
                      $menu[] = 'divider';
                      $menu[] = ['label' => 'Delete', 'icon' => 'trash', 'danger' => true,
                                 'form' => ['action' => 'delete', 'id' => $rid] + $formState,
                                 'confirm' => 'Delete “' . $row['title_en'] . '”? It leaves the public page and moves to the Deleted list, where it can be restored.'];
                  }
              } elseif ($canManage) {
                  $menu[] = ['label' => 'Restore', 'icon' => 'undo', 'form' => ['action' => 'restore', 'id' => $rid] + $formState,
                             'confirm' => 'Restore “' . $row['title_en'] . '” from the bin?'];
              }
          ?>
          <tr<?= $deleted ? ' class="row--muted"' : '' ?>>
            <td>
              <span class="cell-title"><?= h($row['title_en']) ?></span>
              <span class="cell-sub" lang="ta"><?= h($row['title_ta']) ?></span>
              <span class="cell-sub">/live-darshan/<?= h($row['slug']) ?></span>
            </td>
            <td>
              <span class="cell-title"><?= h($row['temple_short_name_en'] ?? '') ?></span>
              <?php if (!empty($row['deity_name_en'])): ?><span class="cell-sub"><?= h($row['deity_name_en']) ?></span><?php endif; ?>
            </td>
            <td><?= h($typeLbl[1]) ?></td>
            <td class="cell-date">
              <?php if ($schedule !== ''): ?>
                <time datetime="<?= h(str_replace(' ', 'T', (string) $row['scheduled_start_at']) . 'Z') ?>"><?= h($schedule) ?></time>
              <?php else: ?>
                <span class="text-muted">Not scheduled</span>
              <?php endif; ?>
              <?php if ($row['actual_start_at'] !== null): ?>
                <span class="cell-sub">actual <?= h(liveFromUtc((string) $row['actual_start_at'], $tz, 'd M · H:i')) ?><?= $row['actual_end_at'] !== null ? '–' . h(liveFromUtc((string) $row['actual_end_at'], $tz, 'H:i')) : '' ?> <?= h(liveZoneLabel($tz, (string) $row['actual_start_at'])) ?></span>
              <?php endif; ?>
            </td>
            <td>
              <span class="cluster">
                <?= adminBadge(liveStatusLabel($status), liveStatusTone($status), liveStatusIsLive($status)) ?>
                <?php if ($deleted) echo adminBadge('Deleted', 'muted'); ?>
                <?php if ($row['is_featured']) echo adminBadge('Featured', 'gold'); ?>
              </span>
              <?php if (!$deleted && !liveReadyToPublish($row) && in_array($status, ['DRAFT', 'CANCELLED', 'ERROR'], true)): ?>
                <span class="cell-sub">Add a video ID and a start time to publish</span>
              <?php endif; ?>
            </td>
            <td>
              <span class="cell-title"><?= h(LIVE_PROVIDERS[$row['provider']] ?? $row['provider']) ?></span>
              <?php if (!empty($row['provider_broadcast_id'])): ?><span class="cell-sub tabular"><?= h($row['provider_broadcast_id']) ?></span><?php endif; ?>
            </td>
            <td class="cell-date">
              <time datetime="<?= h(str_replace(' ', 'T', (string) $row['updated_at']) . 'Z') ?>"><?= h(liveFromUtc((string) $row['updated_at'], liveTempleTz(), 'd M Y · H:i')) ?></time>
              <?php if (!empty($row['updated_by'])): ?><span class="cell-sub"><?= h($row['updated_by']) ?></span><?php endif; ?>
            </td>
            <td class="cell-actions">
              <?php if ($menu) echo lsRowMenu($menu, 'Actions for ' . $row['title_en']); ?>
            </td>
          </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>
    <?= adminPagination($list['page'], $list['pages'], $query, $list['total'], LIVE_ADMIN_PER_PAGE) ?>
    <?php elseif ($filtered): ?>
      <?= adminEmpty('search', 'No live streams match', 'Try a different search term or filter.',
          '<a href="' . h(LIVE_ADMIN_BASE) . '" class="btn btn--sm">' . adminIcon('x') . ' Clear filters</a>') ?>
    <?php else: ?>
      <?= adminEmpty('activity', 'No live streams yet', 'Schedule the first live darshan: paste the YouTube video ID, set the date and time, and publish it when ready.',
          $canManage ? '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' New live stream</a>' : '') ?>
    <?php endif; ?>
  </div>

</div>

<script>
  // The page address follows the English title until the admin edits it by hand (create only).
  (function () {
    var title = document.getElementById('title_en');
    var slug  = document.getElementById('slug');
    if (!title || !slug || slug.getAttribute('data-slug-target') !== '1' || slug.readOnly) return;
    var touched = slug.value !== '';
    var make = function (s) {
      var out = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
      if (/^[0-9]+$/.test(out)) out += '-darshan'; // digits alone would be read as an id (liveSlugify does the same)
      return out.slice(0, 120);
    };
    slug.addEventListener('input', function () { touched = slug.value !== ''; });
    title.addEventListener('input', function () { if (!touched) slug.value = make(title.value); });
  })();
</script>

<?php adminFooter(); ?>
