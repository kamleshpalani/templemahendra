<?php
// backend/admin/settings.php — System → Settings: temple details, hours and
// daily schedule, homepage words, social links and office alerts (site_settings,
// migration 025); homepage section visibility; the administrator's account.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/site_settings.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db  = getDB();
$msg = '';

// ── Temple details: the groups this page edits and how each json kind is typed ─
// Nalla Neram and the languages have pages of their own.
$siteGroups = ['identity' => 'Temple details', 'hours' => 'Hours and daily schedule', 'homepage' => 'Homepage words', 'social' => 'Social links', 'office' => 'Office alerts'];
$siteReady  = siteSettingsReady();
$clockRe    = '/^([01]\d|2[0-3]):[0-5]\d$/';

/** json setting → the lines a person edits. */
$siteJsonToText = static function (string $key, array $v): string {
    $lines = [];
    if ($key === 'temple_hours') {
        foreach ($v as $w) if (is_array($w)) $lines[] = (string) ($w['open'] ?? '') . ' - ' . (string) ($w['close'] ?? '');
    } elseif ($key === 'pooja_schedule') {
        foreach ($v as $p) if (is_array($p)) $lines[] = (string) ($p['time'] ?? '') . ' | ' . (string) ($p['ta'] ?? '') . ' | ' . (string) ($p['en'] ?? '');
    } elseif ($key === 'daily_special') {
        foreach ($v as $d) if (is_array($d)) $lines[] = (string) ($d['ta'] ?? '') . ' | ' . (string) ($d['en'] ?? '');
    } else {
        return json_encode($v, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    }
    return implode("\n", $lines);
};
/** The lines a person typed → json, or an error sentence. Empty text means "back to the default". */
$siteTextToJson = static function (string $key, string $text) use ($clockRe): array {
    $lines = array_values(array_filter(array_map('trim', preg_split('/\R/u', $text)), static fn($l) => $l !== ''));
    if ($lines === []) return [null, null];
    $out = [];
    if ($key === 'temple_hours') {
        foreach ($lines as $l) {
            if (!preg_match('/^(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})$/u', $l, $m) || !preg_match($clockRe, $m[1]) || !preg_match($clockRe, $m[2]) || $m[2] <= $m[1]) {
                return [null, 'Each line is one opening window as HH:MM - HH:MM, ending after it starts.'];
            }
            $out[] = ['open' => $m[1], 'close' => $m[2]];
        }
        if (count($out) > 4) return [null, 'At most four opening windows a day.'];
    } elseif ($key === 'pooja_schedule') {
        foreach ($lines as $l) {
            $p = array_map('trim', explode('|', $l));
            if (count($p) !== 3 || !preg_match($clockRe, $p[0]) || ($p[1] === '' && $p[2] === '')) {
                return [null, 'Each line is one pooja as HH:MM | Tamil name | English name.'];
            }
            $out[] = ['time' => $p[0], 'ta' => mb_substr($p[1], 0, 80), 'en' => mb_substr($p[2], 0, 80)];
        }
        usort($out, static fn($a, $b) => strcmp($a['time'], $b['time']));
        if (count($out) > 12) return [null, 'At most twelve poojas a day.'];
    } elseif ($key === 'daily_special') {
        if (count($lines) !== 7) return [null, 'Exactly seven lines, Sunday first, each as Tamil | English.'];
        foreach ($lines as $l) {
            $p = array_map('trim', explode('|', $l));
            if (count($p) !== 2 || ($p[0] === '' && $p[1] === '')) return [null, 'Each line is Tamil | English.'];
            $out[] = ['ta' => mb_substr($p[0], 0, 120), 'en' => mb_substr($p[1], 0, 120)];
        }
    } else {
        $decoded = json_decode($text, true);
        if (!is_array($decoded)) return [null, 'Not valid JSON.'];
        $out = $decoded;
    }
    return [json_encode($out, JSON_UNESCAPED_UNICODE), null];
};
$siteErrors = [];
$siteOld    = [];   // what was typed, shown again after a validation error

// Ensure table exists (safety net if database/schema.sql was not imported)
try {
    $db->exec("CREATE TABLE IF NOT EXISTS `homepage_settings` (
      `key_name` VARCHAR(80)  NOT NULL,
      `val`      VARCHAR(10)  NOT NULL DEFAULT '1',
      `label`    VARCHAR(300) NULL,
      PRIMARY KEY (`key_name`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
} catch (PDOException $e) {
    // Table already exists or DB user lacks CREATE privilege — schema.sql is the source of truth
}

// Seed defaults
$defaults = [
    ['show_pournami_section', '1', 'Show scheduled Pournami cards on homepage'],
    ['show_donor_ticker',     '1', 'Show consented donor acknowledgements'],
];
$ins = $db->prepare(
    "INSERT IGNORE INTO homepage_settings (key_name, val, label) VALUES (?,?,?)"
);
foreach ($defaults as $d) {
    try { $ins->execute($d); } catch (Exception $e) {}
}

// Flash message left by a successful save before its redirect
if (isset($_SESSION['admin_flash'])) {
    $flash = $_SESSION['admin_flash'];
    unset($_SESSION['admin_flash']);
    if (is_array($flash) && !empty($flash['text'])) {
        $tone = in_array($flash['type'] ?? '', ['success', 'error', 'warning', 'info'], true) ? $flash['type'] : 'info';
        $msg  = '<p class="alert alert--' . $tone . '" role="status">' . h((string) $flash['text']) . '</p>';
    }
}

// ── Handle POST ──────────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['form'] ?? '') === 'site') {
    $msg = adminCsrfGuard();
    if ($msg === '' && !$siteReady) {
        $msg = '<p class="alert alert--error" role="alert">Run migration 025 before saving temple details.</p>';
    } elseif ($msg === '') {
        $changes = [];
        foreach (siteSettingCatalogue() as $key => [$group, $kind, $label, $hint, $public, $default]) {
            if (!isset($siteGroups[$group]) || $key === 'nalla_neram') continue;
            if (siteSettingIsBilingual($kind)) {
                $ta = is_string($_POST[$key . '_ta'] ?? null) ? sanitizeText($_POST[$key . '_ta'], $kind === 'textarea' ? 4000 : 200) : '';
                $en = is_string($_POST[$key . '_en'] ?? null) ? sanitizeText($_POST[$key . '_en'], $kind === 'textarea' ? 4000 : 200) : '';
                $siteOld[$key] = ['ta' => $ta, 'en' => $en];
                $changes[$key] = ['ta' => $ta, 'en' => $en];
                continue;
            }
            $raw = is_string($_POST[$key] ?? null) ? trim($_POST[$key]) : '';
            $siteOld[$key] = $raw;
            if ($kind === 'json') {
                [$json, $err] = $siteTextToJson($key, $raw);
                if ($err !== null) { $siteErrors[$key] = $err; continue; }
                $changes[$key] = $json;
                continue;
            }
            if ($raw !== '') {
                if ($kind === 'phone' && !preg_match('/^\+?[0-9]{8,15}$/', preg_replace('/[\s-]/', '', $raw))) $siteErrors[$key] = 'Digits only, with the country code, e.g. +919443002296.';
                elseif ($kind === 'email' && $key !== 'contact_notify_email' && !filter_var($raw, FILTER_VALIDATE_EMAIL)) $siteErrors[$key] = 'Enter a valid e-mail address.';
                elseif ($key === 'contact_notify_email') {
                    foreach (explode(',', $raw) as $one) if (trim($one) !== '' && !filter_var(trim($one), FILTER_VALIDATE_EMAIL)) { $siteErrors[$key] = 'Every address must be valid; separate several with commas.'; break; }
                }
                elseif ($kind === 'url' && (!filter_var($raw, FILTER_VALIDATE_URL) || !str_starts_with($raw, 'https://'))) $siteErrors[$key] = 'Enter a full https:// address.';
                elseif ($kind === 'number' && (!preg_match('/^\d{1,3}$/', $raw) || (int) $raw < 1)) $siteErrors[$key] = 'A whole number of days, at least 1.';
                elseif ($key === 'contact_notify_lang' && !in_array($raw, ['ta', 'en'], true)) $siteErrors[$key] = 'Either ta or en.';
                if (isset($siteErrors[$key])) continue;
                $raw = $kind === 'phone' ? preg_replace('/[\s-]/', '', $raw) : mb_substr($raw, 0, 500);
            }
            $changes[$key] = $raw;
        }
        if ($siteErrors) {
            $msg = '<p class="alert alert--error" role="alert">Please fix the highlighted field' . (count($siteErrors) === 1 ? '' : 's') . ' and save again.</p>';
        } else {
            $changed = siteSettingsSave($changes, (string) ($_SESSION['admin_user'] ?? 'admin'));
            adminAudit('site_settings_saved', 'site_settings', $changed ? implode(', ', $changed) : 'no changes');
            $_SESSION['admin_flash'] = ['type' => 'success', 'text' => $changed ? 'Temple details saved — the website shows them immediately.' : 'Nothing changed.'];
            header('Location: /admin/settings.php#site', true, 303);
            exit;
        }
    }
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $msg = adminCsrfGuard();
    if ($msg === '') {
        $allowedKeys = ['show_pournami_section', 'show_donor_ticker'];
        $before = $db->query('SELECT key_name, val FROM homepage_settings')->fetchAll(PDO::FETCH_KEY_PAIR);
        $stmt = $db->prepare("UPDATE homepage_settings SET val=? WHERE key_name=?");
        $changed = [];
        foreach ($allowedKeys as $key) {
            $val = isset($_POST[$key]) ? '1' : '0';
            $stmt->execute([$val, $key]);
            if (($before[$key] ?? null) !== $val) $changed[] = $key . '=' . $val;
        }
        adminAudit('settings_saved', 'homepage_settings', $changed ? implode(', ', $changed) : 'no changes');
        $_SESSION['admin_flash'] = ['type' => 'success', 'text' => 'Settings saved.'];
        header('Location: /admin/settings.php', true, 303);
        exit;
    }
}

$settings = $db->query("SELECT key_name, val, label FROM homepage_settings")
    ->fetchAll(PDO::FETCH_ASSOC);
$map = [];
foreach ($settings as $s) {
    $map[$s['key_name']] = $s;
}

// Homepage section switches: key => [title, description] (texts carried over from the original form)
$sections = [
    'show_pournami_section' => ['Pournami Pooja cards', 'Show committee-scheduled Pournami cards on the homepage, without a countdown'],
    'show_donor_ticker'     => ['Donor acknowledgements', 'Show consented donor/sponsor names not already acknowledged in a homepage card'],
];
$visibleCount = 0;
foreach (array_keys($sections) as $key) {
    if (($map[$key]['val'] ?? '1') === '1') $visibleCount++;
}

// Account details of the signed-in administrator
$me        = currentAdmin() ?? [];
$user      = (string) ($me['username'] ?? 'admin');
$name      = trim((string) ($me['display_name'] ?? '')) !== '' ? (string) $me['display_name'] : $user;
$email     = trim((string) ($me['email'] ?? ''));
$role      = (string) ($me['role'] ?? adminRole());
$roleTone  = adminRoleTone($role);
$isEnvUser = !empty($me['is_env']);
$loginAt   = (int) ($_SESSION['admin_login_at'] ?? 0);

// Public pages (React routes) for the quick-open card
$publicPages = [
    ['Home',       '/',           'house'],
    ['Sevas',      '/sevas',      'sparkles'],
    ['Events',     '/events',     'calendar'],
    ['Panchangam', '/panchangam', 'moon'],
    ['Donations',  '/donations',  'banknote'],
    ['Contact',    '/contact',    'mail'],
];

$headerActions = '<a href="/" target="_blank" rel="noopener" class="btn btn-ghost btn--sm">' . adminIcon('external') . 'View site</a>';
adminHeader('Settings', 'System', ['actions' => $headerActions]);
echo $msg;
echo adminPageIntro(
    'The temple\'s details, hours, homepage words and links, which sections appear on the public homepage, and your administrator account; saved changes are live for every visitor immediately.',
    '<a href="/admin/homepage_widgets.php" class="btn btn--sm">' . adminIcon('layers') . ' Homepage cards</a>'
    . '<a href="/admin/nalla_neram.php" class="btn btn--sm">' . adminIcon('clock') . ' Nalla Neram</a>'
    . '<a href="/admin/languages.php" class="btn btn--sm">' . adminIcon('globe') . ' Languages</a>'
);

$all = $siteReady ? siteSettingsAll() : [];
$sv  = static function (string $key, string $slot) use ($siteOld, $all): string {
    if (isset($siteOld[$key])) return is_array($siteOld[$key]) ? (string) ($siteOld[$key][$slot] ?? '') : (string) $siteOld[$key];
    $row = $all[$key] ?? null;
    if ($row === null || !$row['edited']) return '';
    return (string) ($row[$slot] ?? '');
};
$editedCount = 0;
foreach ($all as $k => $row) if ($row['edited'] && isset($siteGroups[siteSettingCatalogue()[$k][0]])) $editedCount++;
?>
<section class="card card--static mb-6" id="site" aria-labelledby="site-title">
  <div class="card__head">
    <h2 id="site-title"><?= adminIcon('house', 'ico--sm') ?> Temple details</h2>
    <?= adminBadge($siteReady ? ($editedCount . ' setting' . ($editedCount === 1 ? '' : 's') . ' edited') : 'Migration 025 needed', $siteReady ? ($editedCount ? 'success' : 'muted') : 'warning', true) ?>
  </div>
  <?php if (!$siteReady): ?>
    <div class="card__body"><div class="callout"><?= adminIcon('alert') ?><p>Run <code>database/migrations/025_cms_pages_settings.sql</code> against this database to edit the temple's details; until then the built-in values apply.</p></div></div>
  <?php else: ?>
  <form method="POST" action="/admin/settings.php#site" novalidate>
    <?= csrfField() ?>
    <input type="hidden" name="form" value="site" />
    <div class="card__body">
      <p class="muted mb-4">Empty fields keep the built-in value shown as the placeholder. Everything here is public except the office alerts.</p>
      <?php foreach ($siteGroups as $group => $groupLabel): ?>
        <fieldset class="mb-6">
          <legend><?= h($groupLabel) ?></legend>
          <div class="form-grid">
          <?php foreach (siteSettingCatalogue() as $key => [$g, $kind, $label, $hint, $public, $default]): if ($g !== $group || $key === 'nalla_neram') continue;
                $errId = 'err-' . $key; $hasErr = isset($siteErrors[$key]); ?>
            <?php if (siteSettingIsBilingual($kind)): ?>
              <?php foreach (['ta' => 'Tamil', 'en' => 'English'] as $slot => $slotLabel): $id = 'ss-' . $key . '-' . $slot; ?>
                <div class="field">
                  <label class="field__label" for="<?= $id ?>"><?= h($label) ?> (<?= $slotLabel ?>)</label>
                  <?php if ($kind === 'textarea'): ?>
                    <textarea id="<?= $id ?>" name="<?= h($key) ?>_<?= $slot ?>" rows="3" maxlength="4000"<?= $slot === 'ta' ? ' lang="ta"' : '' ?><?= $hint !== '' && $slot === 'ta' ? ' aria-describedby="hint-' . h($key) . '"' : '' ?>><?= h($sv($key, $slot)) ?></textarea>
                  <?php else: ?>
                    <input id="<?= $id ?>" name="<?= h($key) ?>_<?= $slot ?>" maxlength="200" value="<?= h($sv($key, $slot)) ?>"<?= $slot === 'ta' ? ' lang="ta"' : '' ?><?= $hint !== '' && $slot === 'ta' ? ' aria-describedby="hint-' . h($key) . '"' : '' ?> />
                  <?php endif; ?>
                  <?php if ($hint !== '' && $slot === 'ta'): ?><span class="field__hint" id="hint-<?= h($key) ?>"><?= h($hint) ?></span><?php endif; ?>
                </div>
              <?php endforeach; ?>
            <?php else: $id = 'ss-' . $key; $isJson = $kind === 'json';
                  $placeholder = $isJson ? $siteJsonToText($key, siteSettingJson($key)) : (string) ($default ?? ''); ?>
              <div class="field<?= $isJson ? ' field--wide' : '' ?><?= $hasErr ? ' field--error' : '' ?>">
                <label class="field__label" for="<?= $id ?>"><?= h($label) ?></label>
                <?php if ($isJson || $kind === 'textarea'): ?>
                  <textarea id="<?= $id ?>" name="<?= h($key) ?>" rows="<?= $key === 'temple_hours' ? 3 : 7 ?>" maxlength="4000" placeholder="<?= h($placeholder) ?>" aria-describedby="hint-<?= h($key) ?><?= $hasErr ? ' ' . $errId : '' ?>"<?= $hasErr ? ' aria-invalid="true"' : '' ?>><?= h($sv($key, 'value')) ?></textarea>
                <?php else: ?>
                  <input id="<?= $id ?>" name="<?= h($key) ?>" type="<?= $kind === 'email' && $key !== 'contact_notify_email' ? 'email' : ($kind === 'url' ? 'url' : ($kind === 'number' ? 'number' : 'text')) ?>"<?= $kind === 'number' ? ' min="1" max="365"' : '' ?> maxlength="500" value="<?= h($sv($key, 'value')) ?>" placeholder="<?= h($placeholder) ?>" aria-describedby="hint-<?= h($key) ?><?= $hasErr ? ' ' . $errId : '' ?>"<?= $hasErr ? ' aria-invalid="true"' : '' ?> />
                <?php endif; ?>
                <?php if ($hasErr): ?><span class="field__error" id="<?= $errId ?>" role="alert"><?= adminIcon('alert-circle') ?><?= h($siteErrors[$key]) ?></span><?php endif; ?>
                <span class="field__hint" id="hint-<?= h($key) ?>"><?= h($hint !== '' ? $hint : ($public ? '' : 'Not shown on the website.')) ?><?= !$public && $hint !== '' ? ' Not shown on the website.' : '' ?></span>
              </div>
            <?php endif; ?>
          <?php endforeach; ?>
          </div>
        </fieldset>
      <?php endforeach; ?>
    </div>
    <div class="card__foot">
      <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> Save temple details</button>
    </div>
  </form>
  <?php endif; ?>
</section>

<div class="dash-grid">
  <section class="card card--static" aria-labelledby="sections-title">
    <div class="card__head">
      <h2 id="sections-title"><?= adminIcon('house', 'ico--sm') ?> Homepage sections</h2>
      <?= adminBadge($visibleCount . ' of ' . count($sections) . ' visible', $visibleCount === count($sections) ? 'success' : 'warning', true) ?>
    </div>
    <form method="POST" action="/admin/settings.php">
      <?= csrfField() ?>
      <div class="settings-list">
        <?php foreach ($sections as $key => [$title, $desc]): $on = ($map[$key]['val'] ?? '1') === '1'; ?>
          <div class="settings-row">
            <div class="settings-row__text">
              <strong id="<?= h($key) ?>-title"><?= h($title) ?></strong>
              <span id="<?= h($key) ?>-desc"><?= h($desc) ?></span>
            </div>
            <label class="switch">
              <input type="checkbox" role="switch" name="<?= h($key) ?>" value="1"<?= $on ? ' checked' : '' ?>
                     aria-labelledby="<?= h($key) ?>-title" aria-describedby="<?= h($key) ?>-desc" />
              <span class="switch__track" aria-hidden="true"></span>
            </label>
          </div>
        <?php endforeach; ?>
      </div>
      <div class="card__foot">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> Save changes</button>
      </div>
    </form>
  </section>

  <div class="stack stack--lg">
    <section class="card card--static" aria-labelledby="account-title">
      <div class="card__head">
        <h2 id="account-title"><?= adminIcon('user', 'ico--sm') ?> Account</h2>
        <?= adminBadge($isEnvUser ? 'Environment account' : 'Committee account', $isEnvUser ? 'info' : 'muted') ?>
      </div>
      <div class="card__body">
        <dl class="dl-grid">
          <dt>Name</dt>
          <dd><?= h($name) ?></dd>
          <dt>Username</dt>
          <dd><?= h($user) ?></dd>
          <?php if ($email !== ''): ?>
            <dt>Email</dt>
            <dd><a href="mailto:<?= h($email) ?>"><?= h($email) ?></a></dd>
          <?php endif; ?>
          <dt>Signed in</dt>
          <dd>
            <?php if ($loginAt > 0): ?>
              <time datetime="<?= h(date('c', $loginAt)) ?>" title="<?= h(date('d M Y, H:i', $loginAt)) ?>"><?= h(adminAgo(date('c', $loginAt))) ?></time>
            <?php else: ?>
              this session
            <?php endif; ?>
          </dd>
          <dt>Role</dt>
          <dd><?= adminBadge(adminRoleLabel($role), $roleTone) ?></dd>
        </dl>
        <div class="callout mt-4">
          <?= adminIcon('key') ?>
          <?php if ($isEnvUser): ?>
            <p>You are signed in with the environment account, whose password is not stored in the database. To change
               it, set the <code>ADMIN_PASS_HASH</code> environment variable in the hosting panel to a new bcrypt hash —
               generate one with <code>php -r "echo password_hash('new-password', PASSWORD_BCRYPT);"</code> — then sign
               in again with the new password.</p>
          <?php else: ?>
            <p>Change your password, name and email on your profile page. Your password is stored as a bcrypt hash in
               the <code>admin_users</code> table — there is nothing to edit in the hosting panel.</p>
          <?php endif; ?>
        </div>
      </div>
      <div class="card__foot">
        <a href="/admin/profile.php" class="btn btn--sm"><?= adminIcon('user') ?> My profile</a>
        <?php if (adminCan('users.manage')): ?>
          <a href="/admin/users.php" class="btn btn--sm"><?= adminIcon('users') ?> Users</a>
        <?php endif; ?>
        <a href="/admin/logout.php" class="btn btn-danger btn--sm"><?= adminIcon('logout') ?> Sign out</a>
      </div>
    </section>

    <section class="card card--static" aria-labelledby="public-title">
      <div class="card__head">
        <h2 id="public-title"><?= adminIcon('external', 'ico--sm') ?> Public site</h2>
      </div>
      <div class="card__body">
        <p class="muted mb-4">Open any page of the website in a new tab to check your work. Everything saved in the control center is live immediately — there is no publish step.</p>
        <div class="cluster">
          <?php foreach ($publicPages as [$label, $href, $icon]): ?>
            <a class="btn btn--sm" href="<?= h($href) ?>" target="_blank" rel="noopener"><?= adminIcon($icon) ?> <?= h($label) ?></a>
          <?php endforeach; ?>
        </div>
      </div>
    </section>
  </div>
</div>

<?php adminFooter(); ?>
