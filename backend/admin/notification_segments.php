<?php
// backend/admin/notification_segments.php — saved audiences ("Donors in Tamil
// Nadu", "Volunteers") that notifications can reuse.
//
// A segment stores rules, not a list of people: it is worked out again every
// time a notification using it is sent, so devotees who joined since are
// included and closed accounts drop out.
//
// Because a notification's approval covered the audience it had at the time,
// a segment used by an approved, scheduled or sending notification is locked:
// its rules cannot change and it cannot be deleted until those finish or are
// cancelled. Its name and description can still be tidied.
require_once __DIR__ . '/../includes/auth.php';

function nsJson(array $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
    exit;
}

$nsMethod = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$nsAction = $nsMethod === 'POST' && is_string($_POST['action'] ?? null) ? $_POST['action'] : '';
$nsIsJson = ($nsMethod === 'POST' && $nsAction === 'estimate') || ($nsMethod === 'GET' && isset($_GET['devotee_search']));

if ($nsIsJson) {
    if (empty($_SESSION['admin_logged_in'])) nsJson(['error' => 'Your session has ended. Sign in again, then try once more.', 'code' => 'unauthenticated'], 401);
    if (!empty($_SESSION['admin_must_change'])) nsJson(['error' => 'Choose a new password on your profile page first.', 'code' => 'password_change'], 403);
    if (!adminCan('notifications.compose')) nsJson(['error' => 'Your role can read audiences but not change them.', 'code' => 'forbidden'], 403);
}
requireAdminAuth();

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/notify.php';
require_once __DIR__ . '/includes/admin_layout.php';
require_once __DIR__ . '/includes/notify_audience_form.php';

const NS_BASE      = '/admin/notification_segments.php';
const NS_PER_PAGE  = 25;
const NS_LOCKED_BY = ['approved', 'scheduled', 'sending'];

$db         = getDB();
$me         = currentAdmin() ?? [];
$actor      = ['username' => (string) ($me['username'] ?? 'admin'), 'role' => (string) ($me['role'] ?? 'viewer')];
$canCompose = adminCan('notifications.compose');

if (!notifyTablesExist()) {
    if ($nsIsJson) nsJson(['error' => 'Notifications are not switched on yet.', 'code' => 'notifications_disabled'], 503);
    adminHeader('Audiences', 'Communication');
    echo adminEmpty('users', 'Notifications are not switched on yet', 'Apply database/migrations/007_notifications.sql to save audiences and send notifications.');
    adminFooter();
    exit;
}

function nsFlash(string $tone, string $text): void
{
    $_SESSION['flash_segments'] = [$tone, $text];
}

function nsRedirect(string $url): never
{
    header('Location: ' . $url, true, 303);
    exit;
}

/** Notifications holding a segment's rules to their approval: id, name, status. */
function nsLockingCampaigns(PDO $db, int $segmentId): array
{
    $stmt = $db->prepare("SELECT id, name, status FROM notification_campaigns WHERE segment_id = :id AND status IN ('approved', 'scheduled', 'sending') ORDER BY id");
    $stmt->execute([':id' => $segmentId]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

/** "“Diwali greetings” (scheduled), “Temple closure” (sending)" */
function nsCampaignNames(array $rows): string
{
    return implode(', ', array_map(static fn($r) => '“' . $r['name'] . '” (' . $r['status'] . ')', array_slice($rows, 0, 5)))
        . (count($rows) > 5 ? ' and ' . (count($rows) - 5) . ' more' : '');
}

/* ── JSON: estimate, devotee search ─────────────────────────────────────── */

if ($nsIsJson) {
    try {
        if ($nsMethod === 'GET') {
            nsJson(['items' => adminAudienceFindDevotees($db, is_string($_GET['devotee_search']) ? $_GET['devotee_search'] : '', 20)]);
        }
        if (!csrfValid()) nsJson(['error' => 'Your session expired or the form was tampered with. Reload the page and try again.', 'code' => 'csrf'], 419);
        $est = adminAudienceEstimate($db, adminAudienceStateFromPost($_POST, false));
        if ($est['count'] === null) nsJson(['error' => $est['error'], 'code' => 'invalid', 'fields' => [$est['field'] => $est['error']]], 422);
        nsJson(['count' => $est['count'], 'approvalReason' => null]);
    } catch (Throwable $e) {
        error_log('[notify] segment estimate failed: ' . get_class($e) . ': ' . $e->getMessage());
        nsJson(['error' => 'That could not be worked out just now. Please try again.', 'code' => 'server_error'], 500);
    }
}

/* ── Posts ──────────────────────────────────────────────────────────────── */

$msg        = '';
$formState  = null;   // ['id','name','description','audience'] when re-rendering a POST
$formErrors = [];
$estimate   = null;
$found      = null;

if ($nsMethod === 'POST') {
    $postedId = is_scalar($_POST['id'] ?? null) && ctype_digit((string) $_POST['id']) ? (int) $_POST['id'] : 0;
    $refresh  = in_array($nsAction, ['add_rule', 'find_devotees', 'estimate_form'], true) || isset($_POST['remove_rule']) || isset($_POST['remove_devotee']);

    if (!$canCompose) {
        nsFlash('error', 'Your role can read audiences but not change them.');
        nsRedirect(NS_BASE);
    }

    if ($refresh || $nsAction === 'save') {
        $formState = [
            'id'          => $postedId > 0 ? $postedId : null,
            'name'        => is_string($_POST['name'] ?? null) ? mb_substr(trim((string) preg_replace('/\s+/u', ' ', $_POST['name'])), 0, 200) : '',
            'description' => is_string($_POST['description'] ?? null) ? mb_substr(trim($_POST['description']), 0, 600) : '',
            'audience'    => adminAudienceStateFromPost($_POST, false),
        ];
        if (!csrfValid()) {
            $formErrors['_'] = 'Your session expired or the form was tampered with. Nothing was saved - check the form and save again.';
        } elseif ($refresh) {
            if ($nsAction === 'estimate_form') $estimate = adminAudienceEstimate($db, $formState['audience']);
            if ($nsAction === 'find_devotees') {
                $formState['audience']['source'] = 'selected';
                $found = adminAudienceFindDevotees($db, $formState['audience']['lookup'], 20);
            }
        } else {
            $existing = null;
            if ($formState['id'] !== null) {
                $stmt = $db->prepare('SELECT * FROM notification_segments WHERE id = :id');
                $stmt->execute([':id' => $formState['id']]);
                $existing = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
                if ($existing === null) {
                    nsFlash('warning', 'That audience no longer exists.');
                    nsRedirect(NS_BASE);
                }
            }

            $name = $formState['name'];
            if ($name === '') $formErrors['name'] = 'Give the audience a name, such as “Donors in Tamil Nadu”.';
            elseif (mb_strlen($name) > 120) $formErrors['name'] = 'Keep the name under 120 characters.';
            if (mb_strlen($formState['description']) > 300) $formErrors['description'] = 'Keep the description under 300 characters.';

            $rules = null;
            try {
                $rules = notifyAudienceNormalize(adminAudienceToInput($formState['audience'])['audience'] ?? []);
            } catch (InvalidArgumentException $e) {
                $formErrors['audience'] = $e->getMessage();
            }

            if (!isset($formErrors['name'])) {
                $dupe = $db->prepare('SELECT id FROM notification_segments WHERE name = :n AND id <> :id LIMIT 1');
                $dupe->execute([':n' => $name, ':id' => (int) ($formState['id'] ?? 0)]);
                if ($dupe->fetchColumn() !== false) $formErrors['name'] = 'Another saved audience already has that name.';
            }

            $rulesJson = $rules !== null ? json_encode($rules, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null;
            $previous  = null;
            if ($existing !== null && $rules !== null) {
                $previous = json_decode((string) $existing['rules'], true);
                $old = null;
                try {
                    $old = is_array($previous) ? notifyAudienceNormalize($previous) : null;
                } catch (InvalidArgumentException) {
                    $old = null;
                }
                if ($old !== $rules) {
                    $locking = nsLockingCampaigns($db, (int) $existing['id']);
                    if ($locking) {
                        $formErrors['audience'] = 'Its rules cannot change while ' . nsCampaignNames($locking)
                            . ' use' . (count($locking) === 1 ? 's' : '') . ' it: their approval covered these rules. Save the new rules as a separate audience instead, or wait until they finish.';
                    }
                } else {
                    $previous = null; // unchanged: nothing to record
                }
            }

            if (!$formErrors) {
                $now = notifyNow();
                $description = $formState['description'] !== '' ? $formState['description'] : null;
                if ($existing === null) {
                    $db->prepare(
                        'INSERT INTO notification_segments (name, description, rules, created_by, updated_by, created_at, updated_at)
                         VALUES (:n, :d, :r, :by, :by2, :now, :now2)'
                    )->execute([':n' => $name, ':d' => $description, ':r' => $rulesJson, ':by' => $actor['username'], ':by2' => $actor['username'], ':now' => $now, ':now2' => $now]);
                    $sid = (int) $db->lastInsertId();
                } else {
                    $sid = (int) $existing['id'];
                    $db->prepare('UPDATE notification_segments SET name = :n, description = :d, rules = :r, updated_by = :by, updated_at = :now WHERE id = :id')
                       ->execute([':n' => $name, ':d' => $description, ':r' => $rulesJson, ':by' => $actor['username'], ':now' => $now, ':id' => $sid]);
                }
                notifyAudit(null, 'segment_saved', $actor, array_filter([
                    'segment_id'     => $sid,
                    'name'           => $name,
                    'created'        => $existing === null,
                    'rules'          => $rules,
                    'previous_rules' => $previous,
                    'previous_name'  => $existing !== null && $existing['name'] !== $name ? $existing['name'] : null,
                ], static fn($v) => $v !== null));
                nsFlash('success', ($existing === null ? 'Saved the audience “' : 'Updated “') . $name . '”.');
                nsRedirect(NS_BASE);
            }
        }
    } elseif ($nsAction === 'delete') {
        if (!csrfValid()) {
            nsFlash('error', 'Your session expired or the form was tampered with. Nothing was deleted - please try again.');
            nsRedirect(NS_BASE);
        }
        $stmt = $db->prepare('SELECT * FROM notification_segments WHERE id = :id');
        $stmt->execute([':id' => $postedId]);
        $seg = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$seg) {
            nsFlash('warning', 'That audience no longer exists.');
            nsRedirect(NS_BASE);
        }
        $locking = nsLockingCampaigns($db, (int) $seg['id']);
        if ($locking) {
            nsFlash('error', '“' . $seg['name'] . '” cannot be deleted while ' . nsCampaignNames($locking) . ' use' . (count($locking) === 1 ? 's' : '') . ' it. Cancel them or wait until they have been sent.');
            nsRedirect(NS_BASE);
        }
        try {
            $db->beginTransaction();
            // Drafts and notifications awaiting approval keep working: they get
            // their own copy of the rules instead of pointing at nothing.
            $conv = $db->prepare("UPDATE notification_campaigns SET audience = :r, segment_id = NULL WHERE segment_id = :id AND status IN ('draft', 'review')");
            $conv->execute([':r' => $seg['rules'], ':id' => (int) $seg['id']]);
            $converted = $conv->rowCount();
            $db->prepare('DELETE FROM notification_segments WHERE id = :id')->execute([':id' => (int) $seg['id']]);
            $db->commit();
        } catch (Throwable $e) {
            if ($db->inTransaction()) $db->rollBack();
            error_log('[notify] deleting segment failed: ' . $e->getMessage());
            nsFlash('error', 'The audience could not be deleted just now. Please try again.');
            nsRedirect(NS_BASE);
        }
        notifyAudit(null, 'segment_saved', $actor, ['segment_id' => (int) $seg['id'], 'name' => $seg['name'], 'deleted' => true,
                                                   'rules' => json_decode((string) $seg['rules'], true), 'drafts_given_own_copy' => $converted]);
        nsFlash('success', 'Deleted “' . $seg['name'] . '”.' . ($converted ? ' ' . $converted . ' draft' . ($converted === 1 ? ' keeps' : 's keep') . ' its own copy of the rules.' : ''));
        nsRedirect(NS_BASE);
    } else {
        nsFlash('error', 'That is not something an audience can do.');
        nsRedirect(NS_BASE);
    }
}

if (!empty($_SESSION['flash_segments']) && is_array($_SESSION['flash_segments'])) {
    [$fTone, $fText] = $_SESSION['flash_segments'] + [null, null];
    unset($_SESSION['flash_segments']);
    $fTone = in_array($fTone, ['success', 'error', 'warning', 'info'], true) ? $fTone : 'info';
    $msg .= '<p class="alert alert--' . $fTone . '" role="' . ($fTone === 'error' ? 'alert' : 'status') . '">' . h((string) $fText) . '</p>';
}

$gets   = static fn(string $k): string => is_string($_GET[$k] ?? null) ? trim($_GET[$k]) : '';
$fields = notifyAudienceFields();

/* ── Form: ?new=1, ?edit=<id>, or a POST being re-rendered ─────────────── */

if ($formState === null && ($gets('new') !== '' || $gets('edit') !== '')) {
    requireAdminCan('notifications.compose');
    if ($gets('edit') !== '') {
        $stmt = $db->prepare('SELECT * FROM notification_segments WHERE id = :id');
        $stmt->execute([':id' => (int) $gets('edit')]);
        $seg = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$seg) {
            nsFlash('warning', 'That audience no longer exists.');
            nsRedirect(NS_BASE);
        }
        $formState = ['id' => (int) $seg['id'], 'name' => (string) $seg['name'], 'description' => (string) ($seg['description'] ?? ''),
                      'audience' => adminAudienceStateFrom(null, json_decode((string) $seg['rules'], true))];
    } else {
        $formState = ['id' => null, 'name' => '', 'description' => '', 'audience' => adminAudienceBlank()];
    }
}

if ($formState !== null) {
    $isEdit  = $formState['id'] !== null;
    $locking = $isEdit ? nsLockingCampaigns($db, (int) $formState['id']) : [];
    $usedBy  = 0;
    if ($isEdit) {
        $stmt = $db->prepare('SELECT COUNT(*) FROM notification_campaigns WHERE segment_id = :id');
        $stmt->execute([':id' => $formState['id']]);
        $usedBy = (int) $stmt->fetchColumn();
    }
    $errors = $formErrors;
    $errAttr = static function (string $key, string $hint = '') use ($errors): string {
        $ids = array_filter([$hint, isset($errors[$key]) ? 'ns-err-' . $key : '']);
        return (isset($errors[$key]) ? ' aria-invalid="true"' : '') . ($ids ? ' aria-describedby="' . implode(' ', $ids) . '"' : '');
    };
    $errText = static fn(string $key): string => isset($errors[$key])
        ? '<span class="field__error" id="ns-err-' . $key . '">' . adminIcon('alert-circle') . h((string) $errors[$key]) . '</span>' : '';
    $targets = ['name' => 'ns-name', 'description' => 'ns-description', 'audience' => 'nc-audience'];

    $title = $isEdit ? 'Edit audience' : 'New audience';
    adminHeader($title, 'Communication', [
        'wide'    => true,
        'actions' => '<a href="' . NS_BASE . '" class="btn btn-ghost btn--sm">' . adminIcon('arrow-left') . 'All audiences</a>',
    ]);
    echo $msg;
    ?>
<div class="nc-page">
  <?php if ($errors): ?>
    <div class="alert alert--error nc-error-summary" role="alert" tabindex="-1" id="nc-error-summary" data-keep>
      <div class="alert__body">
        <p class="alert__title">Nothing was saved. Please fix <?= count($errors) === 1 ? 'this' : 'these ' . count($errors) . ' things' ?>:</p>
        <ul class="nc-error-summary__list">
          <?php foreach ($errors as $key => $text): ?>
            <li><?php if (isset($targets[$key])): ?><a href="#<?= $targets[$key] ?>"><?= h((string) $text) ?></a><?php else: ?><?= h((string) $text) ?><?php endif; ?></li>
          <?php endforeach; ?>
        </ul>
      </div>
    </div>
  <?php endif; ?>

  <?php if ($locking): ?>
    <div class="callout callout--maroon mb-4" role="note">
      <?= adminIcon('lock') ?>
      <p><strong>Its rules are locked.</strong> <?= h(nsCampaignNames($locking)) ?> <?= count($locking) === 1 ? 'uses' : 'use' ?> this audience and <?= count($locking) === 1 ? 'was' : 'were' ?> approved for these rules. You can still change the name and description.</p>
    </div>
  <?php endif; ?>

  <form method="POST" action="<?= NS_BASE ?>" class="nc-composer" id="ns-form" novalidate data-nc-segment-form aria-label="<?= h($title) ?>">
    <?= csrfField() ?>
    <button type="submit" name="action" value="save" class="sr-only" tabindex="-1">Save audience</button>
    <?php if ($isEdit): ?><input type="hidden" name="id" value="<?= (int) $formState['id'] ?>" /><?php endif; ?>

    <div class="nc-main nc-main--narrow">
      <section class="card card--solid card--static nc-card" aria-labelledby="ns-about-h">
        <h2 class="nc-card__title" id="ns-about-h"><?= adminIcon('pencil') ?>About this audience</h2>
        <label for="ns-name">
          <span class="field__label">Name <span class="field__required" aria-hidden="true">*</span></span>
          <input id="ns-name" name="name" type="text" maxlength="120" required aria-required="true" autocomplete="off"
                 value="<?= h($formState['name']) ?>" placeholder="e.g. Donors in Tamil Nadu"<?= $errAttr('name') ?> />
          <?= $errText('name') ?>
        </label>
        <label for="ns-description">
          <span class="field__label">Description <span class="field__optional">optional</span></span>
          <textarea id="ns-description" name="description" rows="2" maxlength="300" data-counter<?= $errAttr('description', 'ns-description-hint') ?>><?= h($formState['description']) ?></textarea>
          <?= $errText('description') ?>
          <span class="field__hint" id="ns-description-hint">Who this is for and why, so the next committee member picks the right one.</span>
        </label>
        <?php if ($isEdit): ?>
          <p class="field__hint">Used by <?= $usedBy ?> notification<?= $usedBy === 1 ? '' : 's' ?>.</p>
        <?php endif; ?>
      </section>

      <?= adminAudienceForm($db, $formState['audience'], [
          'segments'      => null,
          'errors'        => $errors,
          'fields'        => $fields,
          'found'         => $found,
          'estimate'      => $estimate['count'] ?? null,
          'estimateError' => $estimate['error'] ?? null,
          'legend'        => 'Who is in this audience',
      ]) ?>

      <div class="card card--solid card--static nc-card nc-submitbar">
        <div class="form-actions">
          <button type="submit" name="action" value="save" class="btn btn-primary"><?= adminIcon('check') ?> Save audience</button>
          <a href="<?= NS_BASE ?>" class="btn btn-ghost">Cancel</a>
        </div>
        <p class="field__hint">The rules are worked out again whenever a notification using this audience is sent.</p>
      </div>
    </div>
  </form>
</div>
<script src="/admin/assets/notify-campaigns.js" defer></script>
    <?php
    adminFooter();
    exit;
}

/* ── List ───────────────────────────────────────────────────────────────── */

$q     = mb_substr($gets('q'), 0, 100);
$page  = max(1, (int) $gets('page'));
$query = ['q' => $q];
$where = '';
$params = [];
if ($q !== '') {
    $where = ' WHERE (name LIKE :q1 OR description LIKE :q2)';
    $like  = '%' . addcslashes($q, '%_\\') . '%';
    $params = [':q1' => $like, ':q2' => $like];
}
$list = adminPaginate($db, 'SELECT id, name, description, rules, created_by, updated_by, created_at, updated_at FROM notification_segments' . $where . ' ORDER BY name, id', $params, $page, NS_PER_PAGE);
$rows = $list['rows'];

// How many notifications use each segment on this page, in one query.
$usage = [];
if ($rows) {
    $marks = [];
    $ids   = [];
    foreach ($rows as $i => $r) {
        $marks[] = ':s' . $i;
        $ids[':s' . $i] = (int) $r['id'];
    }
    $stmt = $db->prepare(
        "SELECT segment_id, COUNT(*) AS total, COALESCE(SUM(status IN ('approved', 'scheduled', 'sending')), 0) AS locked
           FROM notification_campaigns WHERE segment_id IN (" . implode(',', $marks) . ') GROUP BY segment_id'
    );
    $stmt->execute($ids);
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) $usage[(int) $r['segment_id']] = $r;
}

adminHeader('Audiences', 'Communication', [
    'actions' => $canCompose ? '<a href="' . NS_BASE . '?new=1" class="btn btn-primary btn--sm">' . adminIcon('plus') . 'New audience</a>' : '',
    'wide'    => true,
]);
echo $msg;
echo adminPageIntro(
    'Saved groups of devotees to send notifications to, such as donors in Tamil Nadu or everyone tagged “volunteer”. '
    . 'An audience is a set of rules, worked out again each time it is used.' . ($canCompose ? '' : ' You have read access.'),
    '<a href="/admin/notifications.php" class="btn btn-ghost btn--sm">' . adminIcon('bell') . 'Notifications</a>'
);
?>
<div class="nc-page">
  <form method="GET" action="<?= NS_BASE ?>" class="toolbar" role="search" aria-label="Find audiences">
    <div class="toolbar__search">
      <?= adminIcon('search') ?>
      <label for="ns-q" class="sr-only">Search audiences</label>
      <input id="ns-q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search by name or description…" autocomplete="off" maxlength="100" />
    </div>
    <div class="toolbar__group">
      <button type="submit" class="btn btn--sm"><?= adminIcon('search') ?> Search</button>
      <?php if ($q !== ''): ?><a href="<?= NS_BASE ?>" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Clear</a><?php endif; ?>
    </div>
    <span class="toolbar__count" aria-live="polite"><?= $list['total'] ?> audience<?= $list['total'] === 1 ? '' : 's' ?></span>
  </form>

  <?php if ($rows): ?>
  <div class="table-wrap">
    <table class="table nc-list-table" data-no-search>
      <caption class="sr-only">Saved audiences</caption>
      <thead>
        <tr>
          <th scope="col">Audience</th>
          <th scope="col">Rules</th>
          <th scope="col" class="text-right">Devotees now</th>
          <th scope="col">Used by</th>
          <th scope="col">Changed</th>
          <th scope="col"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <?php foreach ($rows as $row):
          $sid   = (int) $row['id'];
          $rules = json_decode((string) $row['rules'], true);
          $desc  = adminAudienceDescribe(is_array($rules) ? $rules : null, $fields);
          $count = null;
          if ($desc['ok']) {
              try {
                  $count = notifyAudienceCount($rules);
              } catch (Throwable) {
                  $count = null;
              }
          }
          $use    = $usage[$sid] ?? ['total' => 0, 'locked' => 0];
          $locked = (int) $use['locked'] > 0;

          $menu = [];
          if ($canCompose) {
              $menu[] = ['label' => 'Edit', 'href' => NS_BASE . '?edit=' . $sid, 'icon' => 'pencil'];
              $menu[] = ['label' => 'New notification to this audience', 'href' => '/admin/notifications.php?new=1&segment=' . $sid, 'icon' => 'bell'];
              if (!$locked) {
                  $menu[] = 'divider';
                  $menu[] = ['label' => 'Delete', 'icon' => 'trash', 'danger' => true, 'form' => ['action' => 'delete', 'id' => $sid],
                             'confirm' => 'Delete the audience “' . $row['name'] . '”?' . ((int) $use['total'] > 0 ? ' Drafts using it keep their own copy of the rules.' : ''),
                             'confirmLabel' => 'Delete audience'];
              }
          }
        ?>
        <tr>
          <td>
            <span class="cell-title"><?= h((string) $row['name']) ?></span>
            <?php if ($row['description']): ?><span class="cell-sub"><?= h((string) $row['description']) ?></span><?php endif; ?>
          </td>
          <td>
            <?= h($desc['summary']) ?>
            <?php if ($desc['items']): ?>
              <ul class="nc-rule-list">
                <?php foreach (array_slice($desc['items'], 0, 4) as $item): ?><li><?= h($item) ?></li><?php endforeach; ?>
                <?php if (count($desc['items']) > 4): ?><li><?= count($desc['items']) - 4 ?> more</li><?php endif; ?>
              </ul>
            <?php endif; ?>
          </td>
          <td class="cell-num text-right"><?= $count !== null ? number_format($count) : '<span class="cell-sub">—</span>' ?></td>
          <td>
            <?= (int) $use['total'] ?> notification<?= (int) $use['total'] === 1 ? '' : 's' ?>
            <?php if ($locked): ?><span class="cell-sub"><?= adminIcon('lock', 'ico--xs') ?> <?= (int) $use['locked'] ?> approved or sending: locked</span><?php endif; ?>
          </td>
          <td class="cell-date">
            <?= h(notifyFromUtc((string) $row['updated_at'], notifyTempleTz(), 'd M Y')) ?>
            <span class="cell-sub">by <?= h((string) ($row['updated_by'] ?: $row['created_by'] ?: 'system')) ?></span>
          </td>
          <td class="cell-actions"><?= $menu ? adminMenu($menu, 'Actions for ' . $row['name']) : '' ?></td>
        </tr>
        <?php endforeach; ?>
      </tbody>
    </table>
  </div>
  <?= adminPagination($list['page'], $list['pages'], $query, $list['total'], NS_PER_PAGE) ?>
  <?php elseif ($q !== ''): ?>
    <?= adminEmpty('search', 'No audiences match', 'Try a different search.', '<a href="' . NS_BASE . '" class="btn btn-primary btn--sm">' . adminIcon('x') . 'Clear search</a>') ?>
  <?php else: ?>
    <?= adminEmpty('users', 'No saved audiences yet',
        'Save a group once, such as “Donors in Tamil Nadu” or “Volunteers”, and pick it whenever you send a notification.',
        $canCompose ? '<a href="' . NS_BASE . '?new=1" class="btn btn-primary btn--sm">' . adminIcon('plus') . 'New audience</a>' : '') ?>
  <?php endif; ?>
</div>
<?php adminFooter(); ?>
