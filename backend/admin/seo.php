<?php
// backend/admin/seo.php — System → SEO: per-address overrides of the title,
// description, preview image and robots directive (brief §15, §22).
// Migration 025 (seo_settings). Actions (POST): save · toggle · delete.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/site_pages.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db   = getDB();
$self = '/admin/seo.php';

$ready = true;
try { $db->query('SELECT 1 FROM seo_settings LIMIT 0')->closeCursor(); } catch (Throwable) { $ready = false; }

$str = static fn($v): string => is_string($v) ? $v : '';
$imageOk = static fn(string $u): bool => $u === '' || preg_match('#^(/(uploads|images|icons)/[A-Za-z0-9._/-]+|https://[^\s"<>]+)$#', $u) === 1;
$pathOk  = static fn(string $p): bool => preg_match('#^/(?:[a-z0-9][a-z0-9-]*(?:/[a-z0-9][a-z0-9-]*)*)?$#', $p) === 1 && strlen($p) <= 160;

$msg = '';
if (!empty($_SESSION['admin_flash']) && is_array($_SESSION['admin_flash'])) {
    $flash = $_SESSION['admin_flash'];
    unset($_SESSION['admin_flash']);
    $tone = in_array($flash['type'] ?? '', ['success', 'error', 'warning', 'info'], true) ? $flash['type'] : 'info';
    if (($flash['text'] ?? '') !== '') $msg = '<p class="alert alert--' . $tone . '" role="' . ($tone === 'error' ? 'alert' : 'status') . '">' . h($flash['text']) . '</p>';
}
$redirect = static function (string $type, string $text) use ($self): void {
    $_SESSION['admin_flash'] = ['type' => $type, 'text' => $text];
    header('Location: ' . $self);
    exit;
};

// The addresses the site knows (site_pages.php) plus any the committee added.
$known = array_keys(sitePages());

$errors = [];
$old    = null;
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $ready) {
    $msg = adminCsrfGuard();
    if ($msg === '') {
        $action = $str($_POST['action'] ?? '');
        if ($action === 'save') {
            $id     = (int) ($_POST['id'] ?? 0);
            $path   = strtolower(trim($str($_POST['path'] ?? '')));
            $path   = $path === '' ? '' : '/' . trim($path, '/');
            if ($path === '/') $path = '/';
            $t_ta   = sanitizeText($str($_POST['title_ta'] ?? ''), 200);
            $t_en   = sanitizeText($str($_POST['title_en'] ?? ''), 200);
            $d_ta   = sanitizeText($str($_POST['description_ta'] ?? ''), 500);
            $d_en   = sanitizeText($str($_POST['description_en'] ?? ''), 500);
            $image  = mb_substr(trim($str($_POST['og_image'] ?? '')), 0, 500);
            $noindex = isset($_POST['noindex']) ? 1 : 0;
            $active  = isset($_POST['is_active']) ? 1 : 0;

            if (!$pathOk($path)) $errors['path'] = 'Enter the page address as it appears in the browser, e.g. /about or /live-darshan/schedule.';
            if (!$imageOk($image)) $errors['og_image'] = 'Use a site path such as /uploads/photo.webp or an https:// address.';
            if ($t_ta === '' && $t_en === '' && $d_ta === '' && $d_en === '' && $image === '' && !$noindex) {
                $errors['title_en'] = 'Enter at least one title, description, image or the noindex switch — an empty override changes nothing.';
            }
            if (!$errors) {
                $dup = $db->prepare('SELECT id FROM seo_settings WHERE path = :p AND id <> :id');
                $dup->execute([':p' => $path, ':id' => $id]);
                if ($dup->fetchColumn()) $errors['path'] = 'This address already has an override — edit that one instead.';
            }
            $old = ['id' => $id, 'path' => $path, 'title_ta' => $t_ta, 'title_en' => $t_en, 'description_ta' => $d_ta, 'description_en' => $d_en, 'og_image' => $image, 'noindex' => $noindex, 'is_active' => $active];
            if ($errors) {
                $msg = '<p class="alert alert--error" role="alert">Please fix the highlighted field' . (count($errors) === 1 ? '' : 's') . ' and save again.</p>';
            } else {
                $params = [':p' => $path, ':tta' => $t_ta ?: null, ':ten' => $t_en ?: null, ':dta' => $d_ta ?: null, ':den' => $d_en ?: null,
                           ':img' => $image ?: null, ':ni' => $noindex, ':act' => $active, ':by' => (string) ($_SESSION['admin_user'] ?? 'admin')];
                if ($id > 0) {
                    $db->prepare('UPDATE seo_settings SET path=:p, title_ta=:tta, title_en=:ten, description_ta=:dta, description_en=:den, og_image=:img, noindex=:ni, is_active=:act, updated_by=:by WHERE id=:id')
                       ->execute($params + [':id' => $id]);
                    adminAudit('seo_updated', 'seo:' . $id, $path . ($noindex ? ' · noindex' : ''));
                    $redirect('success', 'SEO override saved for ' . $path . '.');
                } else {
                    $db->prepare('INSERT INTO seo_settings (path, title_ta, title_en, description_ta, description_en, og_image, noindex, is_active, updated_by) VALUES (:p, :tta, :ten, :dta, :den, :img, :ni, :act, :by)')
                       ->execute($params);
                    adminAudit('seo_created', 'seo:' . (int) $db->lastInsertId(), $path . ($noindex ? ' · noindex' : ''));
                    $redirect('success', 'SEO override created for ' . $path . '.');
                }
            }
        } elseif ($action === 'toggle') {
            $id = (int) ($_POST['id'] ?? 0);
            if ($id > 0) {
                $db->prepare('UPDATE seo_settings SET is_active = 1 - is_active WHERE id = :id')->execute([':id' => $id]);
                $st = $db->prepare('SELECT is_active, path FROM seo_settings WHERE id = :id');
                $st->execute([':id' => $id]);
                if ($row = $st->fetch()) {
                    adminAudit('seo_toggled', 'seo:' . $id, $row['path'] . ' · ' . ((int) $row['is_active'] ? 'on' : 'off'));
                    $redirect('success', (int) $row['is_active'] ? 'Override switched on.' : 'Override switched off — the built-in words apply again.');
                }
                $redirect('warning', 'That override no longer exists.');
            }
        } elseif ($action === 'delete') {
            $id = (int) ($_POST['id'] ?? 0);
            if ($id > 0) {
                $g = $db->prepare('SELECT path FROM seo_settings WHERE id = :id');
                $g->execute([':id' => $id]);
                $p = $g->fetchColumn();
                $d = $db->prepare('DELETE FROM seo_settings WHERE id = :id');
                $d->execute([':id' => $id]);
                if ($d->rowCount()) adminAudit('seo_deleted', 'seo:' . $id, (string) $p);
                $redirect($d->rowCount() ? 'success' : 'warning', $d->rowCount() ? 'Override deleted.' : 'That override no longer exists.');
            }
        }
    }
}

$editing = null;
if ($old !== null) {
    $editing = $old;
} elseif ($ready && isset($_GET['edit'])) {
    $st = $db->prepare('SELECT * FROM seo_settings WHERE id = :id');
    $st->execute([':id' => (int) $_GET['edit']]);
    $editing = $st->fetch() ?: null;
    if ($editing === null && $msg === '') $msg = '<p class="alert alert--warning" role="status">That override no longer exists.</p>';
}
$isEditing = $editing !== null && (int) ($editing['id'] ?? 0) > 0;
$formOpen  = $isEditing || $old !== null;
$rows = $ready ? $db->query('SELECT * FROM seo_settings ORDER BY path ASC')->fetchAll() : [];

$v   = static fn(string $k, $d = '') => (string) ($editing[$k] ?? $d);
$err = static fn(string $f, string $id): string => empty($errors[$f]) ? '' : '<span class="field__error" id="' . $id . '" role="alert">' . adminIcon('alert-circle') . h($errors[$f]) . '</span>';
$invalid = static fn(string $f, string $errId): string => empty($errors[$f]) ? '' : ' aria-invalid="true" aria-describedby="' . $errId . '"';
$defaults = sitePages();

adminHeader('SEO', 'System', ['actions' => '<a href="/sitemap.xml" target="_blank" rel="noopener" class="btn btn--sm">' . adminIcon('external') . 'sitemap.xml</a>']);
echo $msg;
echo adminPageIntro(
    'Override what search engines and shared links show for a page: the title, the description, the preview image and whether the page may be indexed. Leave a field empty to keep the built-in words (backend/includes/site_pages.php).',
    $ready ? '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="seo-editor" aria-expanded="false">' . adminIcon('plus') . 'New override</button>' : ''
);
if (!$ready): ?>
  <div class="callout"><?= adminIcon('alert') ?><p>Run <code>database/migrations/025_cms_pages_settings.sql</code> against this database to enable SEO overrides.</p></div>
<?php adminFooter(); exit; endif; ?>

<div class="admin-two-col admin-two-col--wide-form admin-two-col--collapsible" id="seo-editor" data-editing="<?= $formOpen ? '1' : '0' ?>">
  <section class="admin-form-box card card--static" id="new" aria-labelledby="seo-form-title">
    <h2 id="seo-form-title"><?= adminIcon($isEditing ? 'pencil' : 'plus', 'ico--sm') ?> <?= $isEditing ? 'Edit override' : 'New override' ?></h2>
    <form method="POST" action="<?= h($self) ?>">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save" />
      <?php if ($isEditing): ?><input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" /><?php endif; ?>
      <div class="field<?= isset($errors['path']) ? ' field--error' : '' ?>">
        <label class="field__label" for="seo-path">Page address <span class="field__required" aria-hidden="true">*</span></label>
        <input id="seo-path" name="path" list="seo-paths" required maxlength="160" value="<?= h($v('path')) ?>" placeholder="/about" aria-describedby="seo-path-hint"<?= $invalid('path', 'seo-path-err') ?> />
        <datalist id="seo-paths"><?php foreach ($known as $p): ?><option value="<?= h($p) ?>"></option><?php endforeach; ?></datalist>
        <?= $err('path', 'seo-path-err') ?>
        <span class="field__hint" id="seo-path-hint">Exactly as in the browser, without the query string. The list offers every page the site knows.</span>
      </div>
      <div class="form-grid">
        <div class="field"><label class="field__label" for="seo-t-ta">Title (Tamil)</label><input id="seo-t-ta" name="title_ta" lang="ta" maxlength="200" value="<?= h($v('title_ta')) ?>" /></div>
        <div class="field<?= isset($errors['title_en']) ? ' field--error' : '' ?>"><label class="field__label" for="seo-t-en">Title (English)</label><input id="seo-t-en" name="title_en" maxlength="200" value="<?= h($v('title_en')) ?>"<?= $invalid('title_en', 'seo-t-en-err') ?> /><?= $err('title_en', 'seo-t-en-err') ?></div>
        <div class="field"><label class="field__label" for="seo-d-ta">Description (Tamil)</label><textarea id="seo-d-ta" name="description_ta" lang="ta" rows="2" maxlength="500" data-counter><?= h($v('description_ta')) ?></textarea></div>
        <div class="field"><label class="field__label" for="seo-d-en">Description (English)</label><textarea id="seo-d-en" name="description_en" rows="2" maxlength="500" data-counter><?= h($v('description_en')) ?></textarea></div>
      </div>
      <div class="field<?= isset($errors['og_image']) ? ' field--error' : '' ?>">
        <label class="field__label" for="seo-img">Preview image</label>
        <input id="seo-img" name="og_image" maxlength="500" value="<?= h($v('og_image')) ?>" placeholder="/uploads/festival.jpg" aria-describedby="seo-img-hint"<?= $invalid('og_image', 'seo-img-err') ?> />
        <?= $err('og_image', 'seo-img-err') ?>
        <span class="field__hint" id="seo-img-hint">Shown by WhatsApp, Facebook and X when the page is shared. A JPEG or PNG at least 1200×630 works best.</span>
      </div>
      <label class="switch">
        <input type="checkbox" name="noindex" value="1"<?= (int) $v('noindex', 0) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Keep out of search engines</strong><span class="switch__desc">Adds noindex, nofollow to the page.</span></span>
      </label>
      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= (int) ($editing['is_active'] ?? 1) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Override active</strong><span class="switch__desc">Switch off to fall back to the built-in words without deleting.</span></span>
      </label>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> <?= $isEditing ? 'Save changes' : 'Save override' ?></button>
        <?php if ($formOpen): ?><a href="<?= h($self) ?>" class="btn btn-ghost">Cancel</a><?php endif; ?>
      </div>
    </form>
  </section>

  <div class="admin-list">
    <?php if (!$rows): ?>
      <?= adminEmpty('search', 'No overrides yet', 'Every page uses its built-in title and description. Add an override for a page whose words should change.', '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . 'New override</a>') ?>
    <?php else: ?>
      <div class="table-wrap">
        <table class="table" data-no-search>
          <thead><tr><th scope="col">Address</th><th scope="col">Title</th><th scope="col">Description</th><th scope="col">Robots</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
          <?php foreach ($rows as $row): $rid = (int) $row['id']; $known = isset($defaults[$row['path']]); ?>
            <tr>
              <td><code><?= h($row['path']) ?></code><?php if (!$known): ?><span class="cell-sub">not a page the site lists</span><?php endif; ?></td>
              <td><?php if ($row['title_ta']): ?><span class="cell-title" lang="ta"><?= h($row['title_ta']) ?></span><?php endif; ?><?php if ($row['title_en']): ?><span class="cell-sub"><?= h($row['title_en']) ?></span><?php endif; ?><?php if (!$row['title_ta'] && !$row['title_en']): ?><span class="text-muted">built-in</span><?php endif; ?></td>
              <td><?= $row['description_en'] || $row['description_ta'] ? h(mb_substr((string) ($row['description_en'] ?: $row['description_ta']), 0, 90)) : '<span class="text-muted">built-in</span>' ?></td>
              <td><?= (int) $row['noindex'] ? adminBadge('noindex', 'warning') : adminBadge('index', 'muted') ?></td>
              <td><?= (int) $row['is_active'] ? adminBadge('Active', 'success') : adminBadge('Off', 'muted') ?></td>
              <td class="cell-actions"><?= adminMenu([
                  ['label' => 'Edit', 'href' => $self . '?edit=' . $rid, 'icon' => 'pencil'],
                  ['label' => (int) $row['is_active'] ? 'Switch off' : 'Switch on', 'icon' => (int) $row['is_active'] ? 'eye-off' : 'eye', 'form' => ['action' => 'toggle', 'id' => $rid]],
                  'divider',
                  ['label' => 'Delete', 'icon' => 'trash', 'danger' => true, 'form' => ['action' => 'delete', 'id' => $rid], 'confirm' => 'Delete the override for ' . $row['path'] . '?'],
              ], 'Actions for ' . $row['path']) ?></td>
            </tr>
          <?php endforeach; ?>
          </tbody>
        </table>
      </div>
    <?php endif; ?>
    <div class="callout mt-4"><?= adminIcon('info') ?><p><strong>Where the words come from.</strong> Shared links (WhatsApp, Facebook, X) are answered by the server from these overrides, then from the built-in table; browsers and search engines read the same values through the React app. The sitemap lists every page unless it is marked noindex.</p></div>
  </div>
</div>
<?php adminFooter(); ?>
