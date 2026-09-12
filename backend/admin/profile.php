<?php
/**
 * backend/admin/profile.php — the signed-in person's own account.
 * Update name/email/phone and change the password. Also the page a user is
 * forced to when their password was issued by an owner (must_change).
 */
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db     = getDB();
$me     = currentAdmin();
$msg    = $_SESSION['flash'] ?? '';
unset($_SESSION['flash']);
$errors = [];
$mustChange = !empty($_SESSION['admin_must_change']);
$hasTable   = adminUsersTableExists();
$isEnv      = $me['is_env'];

$ROLE_BLURB = [
    'owner'  => 'Full access, including committee accounts and system settings.',
    'editor' => 'Manage content, poojas, bookings, donations and bulk imports.',
    'viewer' => 'Read-only access to dashboards, lists and CSV exports.',
];

// Load the live record (session data can be stale)
$row = null;
if ($hasTable && !$isEnv) {
    $stmt = $db->prepare('SELECT * FROM admin_users WHERE id = :id');
    $stmt->execute([':id' => $me['id']]);
    $row = $stmt->fetch() ?: null;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $guard = adminCsrfGuard();
    if ($guard !== '') {
        $msg = $guard;
    } elseif ($isEnv || !$row) {
        $msg = '<p class="alert alert--warning">The built-in recovery account is configured through hosting environment variables and cannot be edited here.</p>';
    } else {
        $action = $_POST['action'] ?? '';

        if ($action === 'details') {
            $name  = sanitizeText($_POST['display_name'] ?? '', 120);
            $email = sanitizeText($_POST['email'] ?? '', 190);
            $phone = sanitizeText($_POST['phone'] ?? '', 20);
            if ($name === '') $errors['display_name'] = 'Enter the name you want shown in the admin.';
            if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) $errors['email'] = 'That does not look like an email address.';
            if (!$errors) {
                $db->prepare('UPDATE admin_users SET display_name=:n, email=:e, phone=:p WHERE id=:id')
                   ->execute([':n' => $name, ':e' => $email ?: null, ':p' => $phone ?: null, ':id' => $me['id']]);
                $_SESSION['admin_name']  = $name;
                $_SESSION['admin_email'] = $email ?: null;
                adminAudit('profile_update', $me['username']);
                $_SESSION['flash'] = '<p class="alert alert--success">Your details were updated.</p>';
                header('Location: /admin/profile.php', true, 303);
                exit;
            }
            $row['display_name'] = $name;
            $row['email'] = $email;
            $row['phone'] = $phone;
            $msg = '<p class="alert alert--error">Please correct the highlighted fields.</p>';
        } elseif ($action === 'password') {
            $current = (string) ($_POST['current_password'] ?? '');
            $next    = (string) ($_POST['new_password'] ?? '');
            $confirm = (string) ($_POST['confirm_password'] ?? '');

            if (!password_verify($current, $row['pass_hash'])) {
                $errors['current_password'] = 'That is not your current password.';
            }
            $problem = adminPasswordProblem($next, $me['username']);
            if ($problem !== '')       $errors['new_password'] = $problem;
            elseif ($next === $current) $errors['new_password'] = 'Choose a password you have not used here before.';
            if ($next !== $confirm)     $errors['confirm_password'] = 'The two passwords do not match.';

            if (!$errors) {
                $db->prepare('UPDATE admin_users SET pass_hash=:h, must_change=0 WHERE id=:id')
                   ->execute([':h' => password_hash($next, PASSWORD_BCRYPT), ':id' => $me['id']]);
                $_SESSION['admin_must_change'] = false;
                adminAudit('password_change', $me['username']);
                $_SESSION['flash'] = '<p class="alert alert--success">Your password was changed. Use it the next time you sign in.</p>';
                header('Location: /admin/profile.php', true, 303);
                exit;
            }
            $msg = '<p class="alert alert--error">Your password was not changed.</p>';
        }
    }
}

adminHeader('My profile', 'People', [
    'actions' => adminCan('users.manage')
        ? '<a href="/admin/users.php" class="btn btn--sm">' . adminIcon('users') . 'Committee accounts</a>'
        : '',
]);
echo $msg;

if ($mustChange): ?>
  <div class="alert alert--warning" role="alert" data-keep>
    <span class="alert__icon"><?= adminIcon('key') ?></span>
    <div class="alert__body">
      <span class="alert__title">Choose your own password to continue</span>
      This account is using a password an owner issued for you. Set a new one below — the rest of the admin unlocks straight after.
    </div>
  </div>
<?php endif;

echo adminPageIntro('Your sign-in details and password for the temple control centre.');
?>

<div class="dash-grid">
  <section class="card card--solid card--static">
    <div class="card__head"><h2><?= adminIcon('user', 'ico--sm') ?> Your details</h2></div>
    <div class="card__body">
      <?php if ($isEnv): ?>
        <dl class="dl-grid mb-4">
          <dt>Username</dt><dd><?= h($me['username']) ?></dd>
          <dt>Role</dt><dd><?= adminBadge('Owner', 'gold') ?></dd>
          <dt>Account type</dt><dd>Built-in recovery account</dd>
        </dl>
        <div class="callout">
          <?= adminIcon('info') ?>
          <p>You are signed in with the account defined by the <code>ADMIN_USERNAME</code> and <code>ADMIN_PASS_HASH</code>
             environment variables. It exists so the committee can never be locked out, so its name and password are changed
             in the hosting panel rather than here.
             <?php if (adminCan('users.manage')): ?>
               For everyday use, create a personal account under <a href="/admin/users.php">Committee accounts</a>.
             <?php endif; ?>
          </p>
        </div>
      <?php elseif (!$row): ?>
        <?= adminEmpty('user', 'Account not found', 'Your session refers to an account that no longer exists. Sign out and back in.', '<a class="btn btn-primary btn--sm" href="/admin/logout.php">Sign out</a>', true) ?>
      <?php else: ?>
        <form method="POST" action="/admin/profile.php">
          <?= csrfField() ?>
          <input type="hidden" name="action" value="details" />
          <label for="p-name">Full name <span class="field__required" aria-hidden="true">*</span>
            <input id="p-name" name="display_name" required aria-required="true" maxlength="120" value="<?= h($row['display_name']) ?>"
                   <?= isset($errors['display_name']) ? 'aria-invalid="true" aria-describedby="ep-name"' : '' ?> />
            <?php if (isset($errors['display_name'])): ?><span class="field__error" id="ep-name"><?= h($errors['display_name']) ?></span><?php endif; ?>
          </label>
          <div class="form-grid">
            <label for="p-email">Email
              <input id="p-email" type="email" name="email" maxlength="190" value="<?= h($row['email'] ?? '') ?>"
                     <?= isset($errors['email']) ? 'aria-invalid="true" aria-describedby="ep-email"' : '' ?> />
              <?php if (isset($errors['email'])): ?><span class="field__error" id="ep-email"><?= h($errors['email']) ?></span><?php endif; ?>
            </label>
            <label for="p-phone">Phone
              <input id="p-phone" name="phone" maxlength="20" value="<?= h($row['phone'] ?? '') ?>" />
            </label>
          </div>
          <dl class="dl-grid mb-4">
            <dt>Username</dt><dd><?= h($row['username']) ?></dd>
            <dt>Role</dt><dd><?= adminBadge(ucfirst($row['role']), ['owner' => 'gold', 'editor' => 'info', 'viewer' => 'muted'][$row['role']] ?? 'muted') ?> <span class="muted text-xs"><?= h($ROLE_BLURB[$row['role']] ?? '') ?></span></dd>
            <dt>Last sign-in</dt><dd><?= $row['last_login_at'] ? h(adminFmtDate($row['last_login_at'], true)) : 'this is your first' ?></dd>
          </dl>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> Save details</button>
          </div>
        </form>
      <?php endif; ?>
    </div>
  </section>

  <section class="card card--solid card--static">
    <div class="card__head"><h2><?= adminIcon('key', 'ico--sm') ?> Change password</h2></div>
    <div class="card__body">
      <?php if ($isEnv || !$row): ?>
        <div class="callout callout--maroon">
          <?= adminIcon('lock') ?>
          <p>Change this password by updating <code>ADMIN_PASS_HASH</code> in the hosting panel. Generate the value with:</p>
        </div>
        <pre class="cols">php -r "echo password_hash('YourNewPassword', PASSWORD_BCRYPT);"</pre>
      <?php else: ?>
        <form method="POST" action="/admin/profile.php" autocomplete="off">
          <?= csrfField() ?>
          <input type="hidden" name="action" value="password" />
          <label for="p-current">Current password <span class="field__required" aria-hidden="true">*</span>
            <span class="input-affix">
              <input id="p-current" type="password" name="current_password" required aria-required="true" autocomplete="current-password"
                     <?= isset($errors['current_password']) ? 'aria-invalid="true" aria-describedby="ep-current"' : '' ?> />
              <button type="button" class="input-affix__btn" data-toggle-password="p-current" aria-label="Show password" aria-pressed="false"><?= adminIcon('eye') ?></button>
            </span>
            <?php if (isset($errors['current_password'])): ?><span class="field__error" id="ep-current"><?= h($errors['current_password']) ?></span><?php endif; ?>
          </label>
          <label for="p-new">New password <span class="field__required" aria-hidden="true">*</span>
            <span class="input-affix">
              <input id="p-new" type="password" name="new_password" required aria-required="true" autocomplete="new-password"
                     <?= isset($errors['new_password']) ? 'aria-invalid="true" aria-describedby="ep-new"' : '' ?> />
              <button type="button" class="input-affix__btn" data-toggle-password="p-new" aria-label="Show password" aria-pressed="false"><?= adminIcon('eye') ?></button>
            </span>
            <?php if (isset($errors['new_password'])): ?><span class="field__error" id="ep-new"><?= h($errors['new_password']) ?></span>
            <?php else: ?><span class="field__hint">At least 10 characters, with an upper case letter, a lower case letter and a number.</span><?php endif; ?>
          </label>
          <label for="p-confirm">Repeat new password <span class="field__required" aria-hidden="true">*</span>
            <input id="p-confirm" type="password" name="confirm_password" required aria-required="true" autocomplete="new-password"
                   <?= isset($errors['confirm_password']) ? 'aria-invalid="true" aria-describedby="ep-confirm"' : '' ?> />
            <?php if (isset($errors['confirm_password'])): ?><span class="field__error" id="ep-confirm"><?= h($errors['confirm_password']) ?></span><?php endif; ?>
          </label>
          <span class="field__hint capslock-hint" data-capslock role="status"><?= adminIcon('alert', 'ico--xs') ?> Caps Lock is on</span>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary"><?= adminIcon('key') ?> Change password</button>
          </div>
        </form>
      <?php endif; ?>
    </div>
  </section>
</div>

<?php adminFooter(); ?>
