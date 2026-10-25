<?php
// backend/admin/pages.php — Content → Pages: the CMS pages the public site reads
// (brief §15). Actions (POST): save · toggle · delete. Migration 025.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db   = getDB();
$self = '/admin/pages.php';

$ready = true;
try { $db->query('SELECT 1 FROM pages LIMIT 0')->closeCursor(); } catch (Throwable) { $ready = false; }

$str  = static fn($v): string => is_string($v) ? $v : '';
$q    = sanitizeText($str($_GET['q'] ?? ''), 100);
$page = max(1, (int) ($_GET['page'] ?? 1));
$query = ['q' => $q];
$url  = static function (array $override = []) use ($self, $query): string {
    $qs = adminQuery($query, $override);
    return $self . ($qs === '?' ? '' : $qs);
};

/** A URL-safe slug from an English title: "Temple History" → "temple-history". */
function pageSlugify(string $s): string
{
    $s = strtolower(trim($s));
    $s = preg_replace('/[^a-z0-9]+/', '-', $s) ?? '';
    return trim(mb_substr($s, 0, 80), '-');
}

$msg = '';
if (!empty($_SESSION['admin_flash']) && is_array($_SESSION['admin_flash'])) {
    $flash = $_SESSION['admin_flash'];
    unset($_SESSION['admin_flash']);
    $tone = in_array($flash['type'] ?? '', ['success', 'error', 'warning', 'info'], true) ? $flash['type'] : 'info';
    if (($flash['text'] ?? '') !== '') $msg = '<p class="alert alert--' . $tone . '" role="' . ($tone === 'error' ? 'alert' : 'status') . '">' . h($flash['text']) . '</p>';
}
$redirect = static function (string $type, string $text, string $to): void {
    $_SESSION['admin_flash'] = ['type' => $type, 'text' => $text];
    header('Location: ' . $to);
    exit;
};

$errors = [];
$old    = null;
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $ready) {
    $msg = adminCsrfGuard();
    if ($msg === '') {
        $action = $str($_POST['action'] ?? '');
        $back   = $url(['page' => null]);

        if ($action === 'save') {
            $id        = (int) ($_POST['id'] ?? 0);
            $title_ta  = sanitizeText($str($_POST['title_ta'] ?? ''), 300);
            $title_en  = sanitizeText($str($_POST['title_en'] ?? ''), 300);
            $slugIn    = pageSlugify($str($_POST['slug'] ?? ''));
            $slug      = $slugIn !== '' ? $slugIn : pageSlugify($title_en);
            $body_ta   = mb_substr(trim(strip_tags($str($_POST['body_ta'] ?? ''))), 0, 60000);
            $body_en   = mb_substr(trim(strip_tags($str($_POST['body_en'] ?? ''))), 0, 60000);
            $mt_ta     = sanitizeText($str($_POST['meta_title_ta'] ?? ''), 200);
            $mt_en     = sanitizeText($str($_POST['meta_title_en'] ?? ''), 200);
            $md_ta     = sanitizeText($str($_POST['meta_description_ta'] ?? ''), 500);
            $md_en     = sanitizeText($str($_POST['meta_description_en'] ?? ''), 500);
            $order     = max(-1000, min(1000, (int) ($_POST['sort_order'] ?? 0)));
            $is_active = isset($_POST['is_active']) ? 1 : 0;

            if ($title_ta === '') $errors['title_ta'] = 'The Tamil title is required.';
            if ($title_en === '') $errors['title_en'] = 'The English title is required.';
            if ($slug === '' || !preg_match('/^[a-z0-9][a-z0-9-]{0,78}$/', $slug)) $errors['slug'] = 'The address may only hold lowercase letters, digits and hyphens.';
            if (!$errors) {
                $dup = $db->prepare('SELECT id FROM pages WHERE slug = :s AND id <> :id');
                $dup->execute([':s' => $slug, ':id' => $id]);
                if ($dup->fetchColumn()) $errors['slug'] = 'Another page already uses this address.';
            }

            $old = compact('id', 'title_ta', 'title_en', 'slug', 'body_ta', 'body_en', 'order', 'is_active')
                 + ['meta_title_ta' => $mt_ta, 'meta_title_en' => $mt_en, 'meta_description_ta' => $md_ta, 'meta_description_en' => $md_en, 'sort_order' => $order];

            if ($errors) {
                $msg = '<p class="alert alert--error" role="alert">Please fix the highlighted field' . (count($errors) === 1 ? '' : 's') . ' and save again.</p>';
            } else {
                $params = [
                    ':slug' => $slug, ':tta' => $title_ta, ':ten' => $title_en,
                    ':bta' => $body_ta !== '' ? $body_ta : null, ':ben' => $body_en !== '' ? $body_en : null,
                    ':mtta' => $mt_ta !== '' ? $mt_ta : null, ':mten' => $mt_en !== '' ? $mt_en : null,
                    ':mdta' => $md_ta !== '' ? $md_ta : null, ':mden' => $md_en !== '' ? $md_en : null,
                    ':ord' => $order, ':act' => $is_active, ':by' => (string) ($_SESSION['admin_user'] ?? 'admin'),
                ];
                if ($id > 0) {
                    $db->prepare('UPDATE pages SET slug=:slug, title_ta=:tta, title_en=:ten, body_ta=:bta, body_en=:ben,
                                  meta_title_ta=:mtta, meta_title_en=:mten, meta_description_ta=:mdta, meta_description_en=:mden,
                                  sort_order=:ord, is_active=:act, updated_by=:by WHERE id=:id')
                       ->execute($params + [':id' => $id]);
                    adminAudit('page_updated', 'page:' . $id, $slug . ' · ' . $title_en);
                    $redirect('success', 'Page saved.', $back);
                } else {
                    $db->prepare('INSERT INTO pages (slug, title_ta, title_en, body_ta, body_en, meta_title_ta, meta_title_en, meta_description_ta, meta_description_en, sort_order, is_active, updated_by)
                                  VALUES (:slug, :tta, :ten, :bta, :ben, :mtta, :mten, :mdta, :mden, :ord, :act, :by)')
                       ->execute($params);
                    adminAudit('page_created', 'page:' . (int) $db->lastInsertId(), $slug . ' · ' . $title_en);
                    $redirect('success', 'Page created.', $back);
                }
            }
        } elseif ($action === 'toggle') {
            $id = (int) ($_POST['id'] ?? 0);
            if ($id > 0) {
                $db->prepare('UPDATE pages SET is_active = 1 - is_active WHERE id = :id')->execute([':id' => $id]);
                $st = $db->prepare('SELECT is_active, slug FROM pages WHERE id = :id');
                $st->execute([':id' => $id]);
                if ($row = $st->fetch()) {
                    adminAudit('page_toggled', 'page:' . $id, $row['slug'] . ' · ' . ((int) $row['is_active'] ? 'shown' : 'hidden'));
                    $redirect('success', (int) $row['is_active'] ? 'Page is now shown on the website.' : 'Page hidden from the website.', $back);
                }
                $redirect('warning', 'That page no longer exists.', $back);
            }
        } elseif ($action === 'delete') {
            $id = (int) ($_POST['id'] ?? 0);
            if ($id > 0) {
                $gone = $db->prepare('SELECT slug FROM pages WHERE id = :id');
                $gone->execute([':id' => $id]);
                $slug = $gone->fetchColumn();
                $del = $db->prepare('DELETE FROM pages WHERE id = :id');
                $del->execute([':id' => $id]);
                if ($del->rowCount()) adminAudit('page_deleted', 'page:' . $id, (string) $slug);
                $redirect($del->rowCount() ? 'success' : 'warning', $del->rowCount() ? 'Page deleted.' : 'That page no longer exists.', $back);
            }
        }
    }
}

$editing = null;
if ($old !== null) {
    $editing = $old;
} elseif ($ready && isset($_GET['edit'])) {
    $st = $db->prepare('SELECT * FROM pages WHERE id = :id');
    $st->execute([':id' => (int) $_GET['edit']]);
    $editing = $st->fetch() ?: null;
    if ($editing === null && $msg === '') $msg = '<p class="alert alert--warning" role="status">That page no longer exists.</p>';
}
$isEditing = $editing !== null && (int) ($editing['id'] ?? 0) > 0;
$formOpen  = $isEditing || $old !== null;

$rows = [];
$list = ['rows' => [], 'total' => 0, 'pages' => 1, 'page' => 1];
if ($ready) {
    $where = [];
    $params = [];
    if ($q !== '') {
        $where[] = '(slug LIKE :q1 OR title_ta LIKE :q2 OR title_en LIKE :q3)';
        $like = '%' . $q . '%';
        $params = [':q1' => $like, ':q2' => $like, ':q3' => $like];
    }
    $list = adminPaginate($db, 'SELECT * FROM pages' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY sort_order ASC, id ASC', $params, $page, 50);
    $rows = $list['rows'];
}

$v   = static fn(string $k, $d = '') => (string) ($editing[$k] ?? $d);
$err = static function (string $field, string $id) use ($errors): string {
    return empty($errors[$field]) ? '' : '<span class="field__error" id="' . $id . '" role="alert">' . adminIcon('alert-circle') . h($errors[$field]) . '</span>';
};
$invalid = static fn(string $field, string $errId): string => empty($errors[$field]) ? '' : ' aria-invalid="true" aria-describedby="' . $errId . '"';

adminHeader('Pages', 'Content', ['actions' => '<a href="/about" target="_blank" rel="noopener" class="btn btn--sm">' . adminIcon('external') . 'About page</a>']);
echo $msg;
echo adminPageIntro(
    'Write the pages the public site reads — the About page shows the <em>mission</em> and <em>history</em> pages first; any other page is available to the site at /api/pages/&lt;address&gt;. Bodies are plain text: leave a blank line between paragraphs.',
    $ready ? '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="page-editor" aria-expanded="false">' . adminIcon('plus') . 'New page</button>' : ''
);
if (!$ready): ?>
  <div class="callout"><?= adminIcon('alert') ?><p>Run <code>database/migrations/025_cms_pages_settings.sql</code> against this database to enable CMS pages.</p></div>
<?php adminFooter(); exit; endif; ?>

<div class="admin-two-col admin-two-col--wide-form admin-two-col--collapsible" id="page-editor" data-editing="<?= $formOpen ? '1' : '0' ?>">
  <section class="admin-form-box card card--static" id="new" aria-labelledby="page-form-title">
    <h2 id="page-form-title"><?= adminIcon($isEditing ? 'pencil' : 'plus', 'ico--sm') ?> <?= $isEditing ? 'Edit page' : 'New page' ?></h2>
    <form method="POST" action="<?= h($self) ?>">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save" />
      <?php if ($isEditing): ?><input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" /><?php endif; ?>
      <div class="form-grid">
        <div class="field<?= isset($errors['title_ta']) ? ' field--error' : '' ?>">
          <label class="field__label" for="pg-title-ta">Title (Tamil) <span class="field__required" aria-hidden="true">*</span></label>
          <input id="pg-title-ta" name="title_ta" lang="ta" required maxlength="300" value="<?= h($v('title_ta')) ?>"<?= $invalid('title_ta', 'pg-title-ta-err') ?> />
          <?= $err('title_ta', 'pg-title-ta-err') ?>
        </div>
        <div class="field<?= isset($errors['title_en']) ? ' field--error' : '' ?>">
          <label class="field__label" for="pg-title-en">Title (English) <span class="field__required" aria-hidden="true">*</span></label>
          <input id="pg-title-en" name="title_en" required maxlength="300" value="<?= h($v('title_en')) ?>"<?= $invalid('title_en', 'pg-title-en-err') ?> />
          <?= $err('title_en', 'pg-title-en-err') ?>
        </div>
      </div>
      <div class="field<?= isset($errors['slug']) ? ' field--error' : '' ?>">
        <label class="field__label" for="pg-slug">Address</label>
        <input id="pg-slug" name="slug" maxlength="80" value="<?= h($v('slug')) ?>" placeholder="made from the English title when empty" aria-describedby="pg-slug-hint"<?= $invalid('slug', 'pg-slug-err') ?> />
        <?= $err('slug', 'pg-slug-err') ?>
        <span class="field__hint" id="pg-slug-hint">Lowercase letters, digits and hyphens. <code>mission</code> and <code>history</code> are read by the About page.</span>
      </div>
      <div class="form-grid">
        <div class="field">
          <label class="field__label" for="pg-body-ta">Body (Tamil)</label>
          <textarea id="pg-body-ta" name="body_ta" lang="ta" rows="10" data-counter><?= h($v('body_ta')) ?></textarea>
        </div>
        <div class="field">
          <label class="field__label" for="pg-body-en">Body (English)</label>
          <textarea id="pg-body-en" name="body_en" rows="10" data-counter><?= h($v('body_en')) ?></textarea>
        </div>
      </div>
      <fieldset>
        <legend>Search engines &amp; shared links <span class="field__optional">optional</span></legend>
        <div class="form-grid">
          <div class="field"><label class="field__label" for="pg-mt-ta">Meta title (Tamil)</label><input id="pg-mt-ta" name="meta_title_ta" lang="ta" maxlength="200" value="<?= h($v('meta_title_ta')) ?>" /></div>
          <div class="field"><label class="field__label" for="pg-mt-en">Meta title (English)</label><input id="pg-mt-en" name="meta_title_en" maxlength="200" value="<?= h($v('meta_title_en')) ?>" /></div>
          <div class="field"><label class="field__label" for="pg-md-ta">Meta description (Tamil)</label><textarea id="pg-md-ta" name="meta_description_ta" lang="ta" rows="2" maxlength="500"><?= h($v('meta_description_ta')) ?></textarea></div>
          <div class="field"><label class="field__label" for="pg-md-en">Meta description (English)</label><textarea id="pg-md-en" name="meta_description_en" rows="2" maxlength="500"><?= h($v('meta_description_en')) ?></textarea></div>
        </div>
      </fieldset>
      <div class="form-grid">
        <div class="field">
          <label class="field__label" for="pg-order">Order</label>
          <input id="pg-order" type="number" name="sort_order" min="-1000" max="1000" inputmode="numeric" value="<?= (int) $v('sort_order', 0) ?>" />
        </div>
      </div>
      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= (int) ($editing['is_active'] ?? 1) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Shown on the website</strong><span class="switch__desc">Hidden pages stay here but answer 404 publicly.</span></span>
      </label>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> <?= $isEditing ? 'Save changes' : 'Save page' ?></button>
        <?php if ($formOpen): ?><a href="<?= h($url()) ?>" class="btn btn-ghost">Cancel</a><?php endif; ?>
      </div>
    </form>
  </section>

  <div class="admin-list">
    <form method="GET" action="<?= h($self) ?>" class="toolbar" role="search">
      <div class="toolbar__search">
        <?= adminIcon('search') ?>
        <label class="sr-only" for="pg-q">Search pages</label>
        <input id="pg-q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search by address or title…" autocomplete="off" />
      </div>
      <button type="submit" class="btn btn-ghost btn--sm" data-no-loading>Search</button>
      <span class="toolbar__count"><?= (int) $list['total'] ?> page<?= $list['total'] === 1 ? '' : 's' ?></span>
    </form>
    <?php if (!$rows): ?>
      <?= adminEmpty('file', 'No pages yet', 'Create the mission and history pages the About page reads, or any page the site should offer.', '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . 'New page</a>') ?>
    <?php else: ?>
      <div class="table-wrap">
        <table class="table" data-no-search>
          <thead><tr><th scope="col">Address</th><th scope="col">Title</th><th scope="col">Body</th><th scope="col">Status</th><th scope="col">Updated</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
          <?php foreach ($rows as $row): $rid = (int) $row['id']; $hasBody = trim((string) $row['body_ta'] . (string) $row['body_en']) !== ''; ?>
            <tr>
              <td><code>/<?= h($row['slug']) ?></code></td>
              <td><span class="cell-title" lang="ta"><?= h($row['title_ta']) ?></span><span class="cell-sub"><?= h($row['title_en']) ?></span></td>
              <td><?= $hasBody ? adminBadge('Written', 'success') : adminBadge('Empty — built-in text shows', 'muted') ?></td>
              <td><?= (int) $row['is_active'] ? adminBadge('Shown', 'success') : adminBadge('Hidden', 'muted') ?></td>
              <td class="cell-date"><time datetime="<?= h($row['updated_at']) ?>"><?= adminAgo($row['updated_at']) ?></time></td>
              <td class="cell-actions"><?= adminMenu([
                  ['label' => 'Edit', 'href' => $url(['edit' => $rid, 'page' => null]), 'icon' => 'pencil'],
                  ['label' => (int) $row['is_active'] ? 'Hide from website' : 'Show on website', 'icon' => (int) $row['is_active'] ? 'eye-off' : 'eye', 'form' => ['action' => 'toggle', 'id' => $rid]],
                  'divider',
                  ['label' => 'Delete', 'icon' => 'trash', 'danger' => true, 'form' => ['action' => 'delete', 'id' => $rid], 'confirm' => 'Delete the page "' . $row['title_en'] . '"? This cannot be undone.'],
              ], 'Actions for ' . $row['title_en']) ?></td>
            </tr>
          <?php endforeach; ?>
          </tbody>
        </table>
      </div>
      <?php if ($list['pages'] > 1) echo adminPagination($list['page'], $list['pages'], $query, $list['total'], 50); ?>
    <?php endif; ?>
  </div>
</div>
<?php adminFooter(); ?>
