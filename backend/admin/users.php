<?php
/**
 * backend/admin/users.php — Committee accounts (owner only).
 *
 * Create, edit, enable/disable and re-issue passwords for the people who run
 * the temple site, and give each one a role. The environment account
 * (ADMIN_USERNAME) is shown as a read-only "built-in" row: it is the recovery
 * login and deliberately cannot be edited or removed from here.
 */
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_layout.php';
requireAdminCan('users.manage');

$db   = getDB();
$msg  = $_SESSION['flash'] ?? '';
unset($_SESSION['flash']);
$me   = currentAdmin();
$self = $me['username'];

// ── Guard: the accounts table must exist ────────────────────────────────────
if (!adminUsersTableExists()) {
    adminHeader('Committee accounts', 'People');
    echo adminPageIntro('Multi-user accounts are not set up on this database yet.');
    echo '<section class="card card--static"><div class="card__body">'
       . '<div class="alert alert--info" data-keep><span class="alert__icon">' . adminIcon('info') . '</span><div class="alert__body">'
       . '<span class="alert__title">One migration away</span>'
       . 'Run <code>database/migrations/001_admin_users.sql</code> against this database to enable committee accounts, roles and the activity log. '
       . 'Until then the environment account (<strong>' . h(readEnv('ADMIN_USERNAME', 'admin')) . '</strong>) is the only sign-in, and it has full access.'
       . '</div></div>'
       . '<pre class="cols">mysql -u &lt;user&gt; -p &lt;database&gt; &lt; database/migrations/001_admin_users.sql</pre>'
       . '</div></section>';
    adminFooter();
    exit;
}

$ROLE_LABELS = [
    'owner'  => 'Owner — full access, can manage accounts and settings',
    'editor' => 'Editor — manage content, bookings, donations and imports',
    'viewer' => 'Viewer — read-only access and CSV exports',
];
$ROLE_TONE = ['owner' => 'gold', 'editor' => 'info', 'viewer' => 'muted'];

/** How many active owners remain (never let the last one go). */
function activeOwnerCount(PDO $db): int
{
    return (int) $db->query("SELECT COUNT(*) FROM admin_users WHERE role='owner' AND is_active=1")->fetchColumn();
}

/** A readable, pronounceable temporary password. */
function suggestPassword(): string
{
    $words = ['Kolam', 'Deepam', 'Gopuram', 'Aarti', 'Mandapam', 'Prasadam', 'Vilakku', 'Kumbam'];
    return $words[random_int(0, count($words) - 1)] . '-' . $words[random_int(0, count($words) - 1)] . '-' . random_int(100, 999);
}

$errors  = [];
$editing = null;
$issued  = null;   // password shown once after create / reset

// ── POST ────────────────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $guard = adminCsrfGuard();
    if ($guard !== '') {
        $msg = $guard;
    } else {
        $action = $_POST['action'] ?? '';
        $id     = (int) ($_POST['id'] ?? 0);

        if ($action === 'save') {
            $username = strtolower(trim((string) ($_POST['username'] ?? '')));
            $name     = sanitizeText($_POST['display_name'] ?? '', 120);
            $email    = sanitizeText($_POST['email'] ?? '', 190);
            $phone    = sanitizeText($_POST['phone'] ?? '', 20);
            $role     = in_array($_POST['role'] ?? '', ADMIN_ROLES, true) ? $_POST['role'] : 'editor';
            $active   = isset($_POST['is_active']) ? 1 : 0;
            $password = (string) ($_POST['password'] ?? '');

            if (!preg_match('/^[a-z0-9._-]{3,60}$/', $username)) {
                $errors['username'] = 'Use 3–60 characters: lowercase letters, numbers, dot, dash or underscore.';
            } elseif (strcasecmp($username, readEnv('ADMIN_USERNAME', 'admin')) === 0) {
                $errors['username'] = 'That name belongs to the built-in recovery account. Choose another.';
            }
            if ($name === '') $errors['display_name'] = 'Enter the person’s name as it should appear.';
            if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) $errors['email'] = 'That does not look like an email address.';

            // Duplicate username?
            $dup = $db->prepare('SELECT id FROM admin_users WHERE username = :u AND id <> :id');
            $dup->execute([':u' => $username, ':id' => $id]);
            if ($dup->fetch()) $errors['username'] = 'Another account already uses that username.';

            if ($id === 0) {
                if ($password === '') $password = suggestPassword();
                $problem = adminPasswordProblem($password, $username);
                if ($problem !== '') $errors['password'] = $problem;
            } elseif ($password !== '') {
                $problem = adminPasswordProblem($password, $username);
                if ($problem !== '') $errors['password'] = $problem;
            }

            // Never remove the final owner
            if ($id > 0 && !$errors) {
                $cur = $db->prepare('SELECT role, is_active, username FROM admin_users WHERE id = :id');
                $cur->execute([':id' => $id]);
                $before = $cur->fetch();
                if ($before && $before['role'] === 'owner' && $before['is_active']
                    && ($role !== 'owner' || !$active) && activeOwnerCount($db) <= 1) {
                    $errors['role'] = 'This is the last active owner. Promote someone else first.';
                }
            }

            if (!$errors) {
                if ($id > 0) {
                    $sql = 'UPDATE admin_users SET username=:u, display_name=:n, email=:e, phone=:p, role=:r, is_active=:a';
                    $par = [':u' => $username, ':n' => $name, ':e' => $email ?: null, ':p' => $phone ?: null, ':r' => $role, ':a' => $active, ':id' => $id];
                    if ($password !== '') {
                        $sql .= ', pass_hash=:h, must_change=1';
                        $par[':h'] = password_hash($password, PASSWORD_BCRYPT);
                        $issued = ['username' => $username, 'password' => $password];
                    }
                    $db->prepare($sql . ' WHERE id=:id')->execute($par);
                    adminAudit('user_update', $username, 'role=' . $role . ($active ? '' : ', disabled') . ($password !== '' ? ', password reset' : ''));
                    $_SESSION['flash'] = '<p class="alert alert--success">Saved ' . h($name) . '.</p>';
                } else {
                    $db->prepare('INSERT INTO admin_users (username, display_name, email, phone, pass_hash, role, is_active, must_change)
                                  VALUES (:u,:n,:e,:p,:h,:r,:a,1)')
                       ->execute([':u' => $username, ':n' => $name, ':e' => $email ?: null, ':p' => $phone ?: null,
                                  ':h' => password_hash($password, PASSWORD_BCRYPT), ':r' => $role, ':a' => $active]);
                    adminAudit('user_create', $username, 'role=' . $role);
                    $issued = ['username' => $username, 'password' => $password];
                    $_SESSION['flash'] = '<p class="alert alert--success">Created the account for ' . h($name) . '.</p>';
                }
                // Keep the one-time password on screen instead of redirecting it away
                if ($issued) {
                    $_SESSION['issued'] = $issued;
                }
                header('Location: /admin/users.php' . ($issued ? '?issued=1' : ''), true, 303);
                exit;
            }
            // validation failed — re-render the form with what was typed
            $editing = ['id' => $id, 'username' => $username, 'display_name' => $name, 'email' => $email,
                        'phone' => $phone, 'role' => $role, 'is_active' => $active];
            $msg = '<p class="alert alert--error">Please correct the highlighted fields.</p>';
        } elseif ($action === 'toggle' && $id > 0) {
            $cur = $db->prepare('SELECT username, role, is_active FROM admin_users WHERE id=:id');
            $cur->execute([':id' => $id]);
            $row = $cur->fetch();
            if ($row) {
                $turningOff = (bool) $row['is_active'];
                if ($turningOff && $row['role'] === 'owner' && activeOwnerCount($db) <= 1) {
                    $_SESSION['flash'] = '<p class="alert alert--error">That is the last active owner — promote someone else first.</p>';
                } elseif ($turningOff && $row['username'] === $self) {
                    $_SESSION['flash'] = '<p class="alert alert--error">You cannot disable your own account.</p>';
                } else {
                    $db->prepare('UPDATE admin_users SET is_active = :v WHERE id = :id')
                       ->execute([':v' => $turningOff ? 0 : 1, ':id' => $id]);
                    adminAudit($turningOff ? 'user_disable' : 'user_enable', $row['username']);
                    $_SESSION['flash'] = '<p class="alert alert--success">' . h($row['username']) . ' is now ' . ($turningOff ? 'disabled' : 'active') . '.</p>';
                }
            }
            header('Location: /admin/users.php', true, 303);
            exit;
        } elseif ($action === 'delete' && $id > 0) {
            $cur = $db->prepare('SELECT username, role, is_active FROM admin_users WHERE id=:id');
            $cur->execute([':id' => $id]);
            $row = $cur->fetch();
            if ($row && $row['username'] === $self) {
                $_SESSION['flash'] = '<p class="alert alert--error">You cannot delete the account you are signed in with.</p>';
            } elseif ($row && $row['role'] === 'owner' && $row['is_active'] && activeOwnerCount($db) <= 1) {
                $_SESSION['flash'] = '<p class="alert alert--error">That is the last active owner — promote someone else first.</p>';
            } elseif ($row) {
                $db->prepare('DELETE FROM admin_users WHERE id=:id')->execute([':id' => $id]);
                adminAudit('user_delete', $row['username']);
                $_SESSION['flash'] = '<p class="alert alert--success">Removed ' . h($row['username']) . '.</p>';
            }
            header('Location: /admin/users.php', true, 303);
            exit;
        }
    }
}

// One-time password display after a redirect
if (isset($_GET['issued']) && !empty($_SESSION['issued'])) {
    $issued = $_SESSION['issued'];
    unset($_SESSION['issued']);
}

// ── Read ────────────────────────────────────────────────────────────────────
if ($editing === null && isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM admin_users WHERE id = :id');
    $stmt->execute([':id' => (int) $_GET['edit']]);
    $editing = $stmt->fetch() ?: null;
}
$rows      = $db->query('SELECT * FROM admin_users ORDER BY FIELD(role,"owner","editor","viewer"), display_name')->fetchAll();
$envUser   = readEnv('ADMIN_USERNAME', 'admin');
$counts    = ['owner' => 0, 'editor' => 0, 'viewer' => 0, 'disabled' => 0];
foreach ($rows as $r) {
    if (!$r['is_active']) { $counts['disabled']++; continue; }
    $counts[$r['role']]++;
}
$recent = [];
try {
    $recent = $db->query("SELECT * FROM admin_activity WHERE action LIKE 'user_%' OR action LIKE 'login%' ORDER BY created_at DESC LIMIT 12")->fetchAll();
} catch (Throwable) {
}

adminHeader('Committee accounts', 'People', [
    'actions' => '<a href="/admin/profile.php" class="btn btn--sm">' . adminIcon('user') . 'My profile</a>',
]);
echo $msg;
echo adminPageIntro(
    'Give each committee member their own sign-in and only the access they need. Roles decide what a person can change.',
    '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="users-layout" aria-expanded="false">'
    . adminIcon('plus') . 'New account</button>'
);

if ($issued): ?>
  <section class="card card--accent card--static mb-6" data-keep>
    <div class="card__body">
      <h2 class="mb-2"><?= adminIcon('key') ?> Share this password now</h2>
      <p class="muted mb-4">It is shown once and stored only as a hash. <strong><?= h($issued['username']) ?></strong> will be asked to change it at first sign-in.</p>
      <div class="cluster">
        <code class="cols" style="--x:0"><?= h($issued['password']) ?></code>
      </div>
    </div>
  </section>
<?php endif; ?>

<?= adminKpi([
    ['label' => 'Owners',  'value' => $counts['owner'],  'icon' => 'shield', 'sub' => 'Full access'],
    ['label' => 'Editors', 'value' => $counts['editor'], 'icon' => 'pencil', 'sub' => 'Content + devotees'],
    ['label' => 'Viewers', 'value' => $counts['viewer'], 'icon' => 'eye',    'sub' => 'Read-only'],
    ['label' => 'Disabled','value' => $counts['disabled'],'icon' => 'lock',  'sub' => 'Cannot sign in'],
]) ?>

<div class="admin-two-col admin-two-col--collapsible" id="users-layout" data-editing="<?= $editing ? '1' : '0' ?>">

  <section class="card card--solid card--static admin-form-box">
    <h2><?= adminIcon($editing ? 'pencil' : 'plus') ?><?= $editing ? 'Edit account' : 'New account' ?></h2>
    <form method="POST" action="/admin/users.php">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save" />
      <?php if ($editing && !empty($editing['id'])): ?>
        <input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" />
      <?php endif; ?>

      <label for="u-name">Full name <span class="field__required" aria-hidden="true">*</span>
        <input id="u-name" name="display_name" required aria-required="true" maxlength="120"
               value="<?= h($editing['display_name'] ?? '') ?>" placeholder="S. Gengaiah"
               <?= isset($errors['display_name']) ? 'aria-invalid="true" aria-describedby="e-name"' : '' ?> />
        <?php if (isset($errors['display_name'])): ?><span class="field__error" id="e-name"><?= h($errors['display_name']) ?></span><?php endif; ?>
      </label>

      <label for="u-username">Username <span class="field__required" aria-hidden="true">*</span>
        <input id="u-username" name="username" required aria-required="true" maxlength="60" spellcheck="false" autocapitalize="off"
               value="<?= h($editing['username'] ?? '') ?>" placeholder="gengaiah"
               <?= isset($errors['username']) ? 'aria-invalid="true" aria-describedby="e-username"' : '' ?> />
        <?php if (isset($errors['username'])): ?><span class="field__error" id="e-username"><?= h($errors['username']) ?></span>
        <?php else: ?><span class="field__hint">Lowercase letters, numbers, dot, dash or underscore.</span><?php endif; ?>
      </label>

      <div class="form-grid">
        <label for="u-email">Email
          <input id="u-email" type="email" name="email" maxlength="190" value="<?= h($editing['email'] ?? '') ?>"
                 <?= isset($errors['email']) ? 'aria-invalid="true" aria-describedby="e-email"' : '' ?> />
          <?php if (isset($errors['email'])): ?><span class="field__error" id="e-email"><?= h($errors['email']) ?></span><?php endif; ?>
        </label>
        <label for="u-phone">Phone
          <input id="u-phone" name="phone" maxlength="20" value="<?= h($editing['phone'] ?? '') ?>" placeholder="9443002296" />
        </label>
      </div>

      <label for="u-role">Role <span class="field__required" aria-hidden="true">*</span>
        <select id="u-role" name="role" <?= isset($errors['role']) ? 'aria-invalid="true" aria-describedby="e-role"' : '' ?>>
          <?php foreach ($ROLE_LABELS as $value => $label): ?>
            <option value="<?= $value ?>" <?= ($editing['role'] ?? 'editor') === $value ? 'selected' : '' ?>><?= h($label) ?></option>
          <?php endforeach; ?>
        </select>
        <?php if (isset($errors['role'])): ?><span class="field__error" id="e-role"><?= h($errors['role']) ?></span><?php endif; ?>
      </label>

      <label for="u-password"><?= $editing && !empty($editing['id']) ? 'Reset password' : 'Password' ?>
        <span class="input-affix">
          <input id="u-password" type="password" name="password" autocomplete="new-password"
                 placeholder="<?= $editing && !empty($editing['id']) ? 'Leave blank to keep the current one' : 'Leave blank to generate one' ?>"
                 <?= isset($errors['password']) ? 'aria-invalid="true" aria-describedby="e-password"' : '' ?> />
          <button type="button" class="input-affix__btn" data-toggle-password="u-password" aria-label="Show password" aria-pressed="false"><?= adminIcon('eye') ?></button>
        </span>
        <?php if (isset($errors['password'])): ?><span class="field__error" id="e-password"><?= h($errors['password']) ?></span>
        <?php else: ?><span class="field__hint">At least 10 characters with upper case, lower case and a number. The person must change it at first sign-in.</span><?php endif; ?>
      </label>

      <label class="switch">
        <input type="checkbox" name="is_active" <?= (!$editing || $editing['is_active']) ? 'checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><span>Active</span><span class="switch__desc">Turn off to block sign-in without deleting the account</span></span>
      </label>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> Save account</button>
        <?php if ($editing): ?><a href="/admin/users.php" class="btn btn-ghost">Cancel</a><?php endif; ?>
      </div>
    </form>
  </section>

  <div class="admin-list">
    <div class="table-wrap">
      <table class="table" data-no-search>
        <thead>
          <tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Last sign-in</th><th scope="col"><span class="sr-only">Actions</span></th></tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <span class="cell-title"><?= h($envUser) ?></span>
              <span class="cell-sub">Built-in recovery account (environment variable)</span>
            </td>
            <td><?= adminBadge('Owner', 'gold') ?></td>
            <td><?= adminBadge('Always on', 'muted') ?></td>
            <td class="cell-date">—</td>
            <td class="cell-actions"><span class="muted text-xs">Managed in hosting</span></td>
          </tr>
          <?php foreach ($rows as $r): ?>
          <tr<?= $r['username'] === $self ? ' class="is-selected"' : '' ?>>
            <td>
              <span class="cell-title"><?= h($r['display_name']) ?><?= $r['username'] === $self ? ' <span class="badge badge--info">you</span>' : '' ?></span>
              <span class="cell-sub"><?= h($r['username']) ?><?= $r['email'] ? ' · ' . h($r['email']) : '' ?></span>
            </td>
            <td><?= adminBadge(ucfirst($r['role']), $ROLE_TONE[$r['role']] ?? 'muted') ?></td>
            <td>
              <?= $r['is_active'] ? adminBadge('Active', 'success') : adminBadge('Disabled', 'muted') ?>
              <?= $r['must_change'] ? ' ' . adminBadge('Must change password', 'warning') : '' ?>
            </td>
            <td class="cell-date"><?= $r['last_login_at'] ? h(adminAgo($r['last_login_at'])) : 'never' ?></td>
            <td class="cell-actions">
              <?= adminMenu([
                  ['label' => 'Edit', 'icon' => 'pencil', 'href' => '/admin/users.php?edit=' . (int) $r['id']],
                  ['label' => $r['is_active'] ? 'Disable sign-in' : 'Enable sign-in', 'icon' => $r['is_active'] ? 'lock' : 'check',
                   'form' => ['action' => 'toggle', 'id' => (int) $r['id']], 'action' => '/admin/users.php',
                   'confirm' => $r['is_active'] ? 'Block ' . $r['display_name'] . ' from signing in?' : 'Allow ' . $r['display_name'] . ' to sign in again?',
                   'confirmLabel' => $r['is_active'] ? 'Disable' : 'Enable'],
                  'divider',
                  ['label' => 'Delete account', 'icon' => 'trash', 'danger' => true,
                   'form' => ['action' => 'delete', 'id' => (int) $r['id']], 'action' => '/admin/users.php',
                   'confirm' => 'Delete the account for ' . $r['display_name'] . '? Their activity history is kept.',
                   'confirmLabel' => 'Delete'],
              ], 'Actions for ' . $r['display_name']) ?>
            </td>
          </tr>
          <?php endforeach; ?>
          <?php if (!$rows): ?>
            <tr class="table-empty"><td colspan="5"><?= adminEmpty('users', 'No committee accounts yet', 'Only the built-in recovery account can sign in. Create an account for each committee member so actions are traceable.', '', true) ?></td></tr>
          <?php endif; ?>
        </tbody>
      </table>
    </div>

    <section class="card card--static mt-6">
      <div class="card__head"><h2><?= adminIcon('activity', 'ico--sm') ?> Recent account activity</h2></div>
      <?php if ($recent): ?>
        <div class="feed">
          <?php foreach ($recent as $a): ?>
            <div class="feed__item">
              <span class="feed__icon feed__icon--<?= str_contains($a['action'], 'failed') ? 'info' : 'success' ?>"><?= adminIcon(str_contains($a['action'], 'login') ? 'user' : 'users') ?></span>
              <span class="feed__body"><strong><?= h($a['actor']) ?></strong> · <?= h(str_replace('_', ' ', $a['action'])) ?><?= $a['subject'] ? ' · ' . h($a['subject']) : '' ?><?= $a['detail'] ? ' <span class="muted">(' . h($a['detail']) . ')</span>' : '' ?></span>
              <time class="feed__time" datetime="<?= h($a['created_at']) ?>"><?= h(adminAgo($a['created_at'])) ?></time>
            </div>
          <?php endforeach; ?>
        </div>
      <?php else: ?>
        <div class="card__body"><?= adminEmpty('activity', 'Nothing recorded yet', 'Sign-ins and account changes appear here.', '', true) ?></div>
      <?php endif; ?>
    </section>
  </div>
</div>

<?php adminFooter(); ?>
