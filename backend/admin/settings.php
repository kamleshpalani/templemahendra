<?php
// backend/admin/settings.php — Homepage section visibility, administrator account and public-site links
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db  = getDB();
$msg = '';

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
    ['show_pournami_section', '1', 'Show Pournami Poojai section on homepage'],
    ['show_nalla_strip',      '1', 'Show Nalla Neram strip on homepage'],
    ['show_donor_ticker',     '1', 'Show donor scroll ticker'],
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
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $msg = adminCsrfGuard();
    if ($msg === '') {
        $allowedKeys = ['show_pournami_section', 'show_nalla_strip', 'show_donor_ticker'];
        $stmt = $db->prepare("UPDATE homepage_settings SET val=? WHERE key_name=?");
        foreach ($allowedKeys as $key) {
            $val = isset($_POST[$key]) ? '1' : '0';
            $stmt->execute([$val, $key]);
        }
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
    'show_pournami_section' => ['Pournami Pooja section', 'Show Pournami Poojai countdown + donor ticker on homepage'],
    'show_nalla_strip'      => ['Nalla Neram strip',      'Show daily Nalla Neram (auspicious time) green strip below announcements'],
    'show_donor_ticker'     => ['Donor ticker',           'Show scrolling donor/sponsor names inside Pournami section'],
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
$roleTone  = ['owner' => 'gold', 'editor' => 'info', 'viewer' => 'muted'][$role] ?? 'muted';
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
adminHeader('Settings', 'Data & System', ['actions' => $headerActions]);
echo $msg;
echo adminPageIntro(
    'Choose which sections appear on the public homepage and review your administrator account; saved changes are live for every visitor immediately.',
    '<a href="/admin/homepage_widgets.php" class="btn btn--sm">' . adminIcon('layers') . ' Homepage widgets</a>'
);
?>

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
          <dd><?= adminBadge(ucfirst($role), $roleTone) ?></dd>
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
          <a href="/admin/users.php" class="btn btn--sm"><?= adminIcon('users') ?> Committee accounts</a>
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
