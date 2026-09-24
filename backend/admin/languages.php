<?php
// backend/admin/languages.php — System → Languages: which languages the site
// offers and which one a first visit opens in (brief §7, §15). Stored in
// site_settings (migration 025); read through GET /api/settings.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/site_settings.php';
require_once __DIR__ . '/includes/admin_layout.php';

$all   = ['ta' => ['தமிழ்', 'Tamil'], 'en' => ['English', 'English']];
$ready = siteSettingsReady();

$msg = '';
if (!empty($_SESSION['admin_flash']) && is_array($_SESSION['admin_flash'])) {
    $flash = $_SESSION['admin_flash'];
    unset($_SESSION['admin_flash']);
    $tone = in_array($flash['type'] ?? '', ['success', 'error', 'warning', 'info'], true) ? $flash['type'] : 'info';
    if (($flash['text'] ?? '') !== '') $msg = '<p class="alert alert--' . $tone . '" role="' . ($tone === 'error' ? 'alert' : 'status') . '">' . h($flash['text']) . '</p>';
}

$langs = siteLanguages();
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $ready) {
    $msg = adminCsrfGuard();
    if ($msg === '') {
        $enabled = array_values(array_filter(array_keys($all), static fn($c) => isset($_POST['enabled'][$c])));
        $default = is_string($_POST['default'] ?? null) && isset($all[$_POST['default']]) ? $_POST['default'] : 'ta';
        if ($enabled === []) {
            $msg = '<p class="alert alert--error" role="alert">Keep at least one language switched on.</p>';
        } elseif (!in_array($default, $enabled, true)) {
            $msg = '<p class="alert alert--error" role="alert">The default language must be one of the languages switched on.</p>';
        } else {
            $changed = siteSettingsSave(['languages_enabled' => implode(',', $enabled), 'language_default' => $default], (string) ($_SESSION['admin_user'] ?? 'admin'));
            adminAudit('languages_saved', 'site_settings:languages', $changed ? 'enabled=' . implode(',', $enabled) . ' default=' . $default : 'no changes');
            $_SESSION['admin_flash'] = ['type' => 'success', 'text' => 'Languages saved.'];
            header('Location: /admin/languages.php');
            exit;
        }
        $langs = ['enabled' => $enabled ?: $langs['enabled'], 'default' => $default];
    }
}

adminHeader('Languages', 'System');
echo $msg;
echo adminPageIntro('The website is written in Tamil and English (every title and description has both). Choose which of the two are offered by the language toggle and which one a first-time visitor sees; a visitor\'s own choice is remembered on their device.');
if (!$ready): ?>
  <div class="callout"><?= adminIcon('alert') ?><p>Run <code>database/migrations/025_cms_pages_settings.sql</code> against this database to change the languages; until then both are offered and Tamil is the default.</p></div>
<?php adminFooter(); exit; endif; ?>
<section class="card card--static" aria-labelledby="lang-title">
  <div class="card__head"><h2 id="lang-title"><?= adminIcon('globe', 'ico--sm') ?> Languages</h2></div>
  <form method="POST" action="/admin/languages.php">
    <?= csrfField() ?>
    <fieldset>
      <legend>Offered by the toggle</legend>
      <?php foreach ($all as $code => [$native, $en]): ?>
        <label class="switch">
          <input type="checkbox" name="enabled[<?= h($code) ?>]" value="1"<?= in_array($code, $langs['enabled'], true) ? ' checked' : '' ?> />
          <span class="switch__track" aria-hidden="true"></span>
          <span class="switch__label"><strong lang="<?= h($code) ?>"><?= h($native) ?></strong><span class="switch__desc"><?= h($en) ?> · <code><?= h($code) ?></code></span></span>
        </label>
      <?php endforeach; ?>
    </fieldset>
    <div class="field">
      <label class="field__label" for="lang-default">Default language</label>
      <select id="lang-default" name="default">
        <?php foreach ($all as $code => [$native, $en]): ?>
          <option value="<?= h($code) ?>"<?= $langs['default'] === $code ? ' selected' : '' ?>><?= h($native . ' (' . $en . ')') ?></option>
        <?php endforeach; ?>
      </select>
      <span class="field__hint">What a first visit opens in. The site has always opened in Tamil.</span>
    </div>
    <div class="form-actions"><button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> Save languages</button></div>
  </form>
</section>
<?php adminFooter(); ?>
