<?php
require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_ui.php';

// Already logged in
if (!empty($_SESSION['admin_logged_in'])) {
    header('Location: /admin/');
    exit;
}

$error    = '';
$notice   = '';
$username = '';

// Friendly notices carried over from other pages (?reason=expired|signed_out)
$reason = $_GET['reason'] ?? '';
if ($reason === 'signed_out') $notice = 'You have been signed out. Nandri 🙏';
if ($reason === 'expired')    $notice = 'Your session expired. Please sign in again.';

// Simple per-session throttle: 5 failures -> 60s cool-down
$fails   = (int) ($_SESSION['login_fails'] ?? 0);
$lockedU = (int) ($_SESSION['login_locked_until'] ?? 0);
$locked  = $lockedU > time();
$lockSec = $locked ? $lockedU - time() : 0;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $username = trim($_POST['username'] ?? '');
    $password = $_POST['password'] ?? '';

    if (!csrfValid()) {
        $error = 'Your session expired. Please try again.';
    } elseif ($locked) {
        $error = 'Too many attempts. Please wait a minute and try again.';
    } elseif ($username === '' || $password === '') {
        $error = 'Please enter both username and password.';
    } elseif (adminLogin($username, $password)) {
        session_regenerate_id(true);
        $_SESSION['admin_logged_in'] = true;
        $_SESSION['admin_user']      = $username;
        $_SESSION['admin_login_at']  = time();
        unset($_SESSION['login_fails'], $_SESSION['login_locked_until']);
        header('Location: /admin/');
        exit;
    } else {
        $fails++;
        $_SESSION['login_fails'] = $fails;
        if ($fails >= 5) {
            $_SESSION['login_locked_until'] = time() + 60;
            $_SESSION['login_fails'] = 0;
            $locked  = true;
            $lockSec = 60;
            $error = 'Too many attempts. Please wait a minute and try again.';
        } else {
            $left  = 5 - $fails;
            $error = 'Invalid username or password.' . ($left <= 2 ? " $left attempt" . ($left === 1 ? '' : 's') . ' left before a short lock.' : '');
        }
    }
}
$hasError = $error !== '';
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<meta name="theme-color" content="#3d0707" />
<meta name="color-scheme" content="light" />
<title>Sign in — Temple Admin</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter:wght@400;500;600;700&family=Noto+Serif+Tamil:wght@600;700&display=swap" />
<link rel="stylesheet" href="/admin/assets/ds/tokens.css" />
<link rel="stylesheet" href="/admin/assets/ds/base.css" />
<link rel="stylesheet" href="/admin/assets/ds/layout.css" />
<link rel="stylesheet" href="/admin/assets/ds/components.css" />
<link rel="stylesheet" href="/admin/assets/ds/utilities.css" />
<link rel="stylesheet" href="/admin/assets/admin.css" />
</head>
<body class="login-page">
<main class="login-shell">
  <div class="login-brand">
    <div class="login-brand__logo" aria-hidden="true"><img src="/logo.svg" alt="" width="66" height="66" /></div>
    <h1 lang="ta">தபலவார் ரேணுகா தேவி கோவில்</h1>
    <p>Temple Control Center</p>
  </div>

  <section class="card card--solid card--static login-box" aria-labelledby="login-title">
    <h2 id="login-title">Welcome back</h2>
    <p class="login-sub">Sign in to manage sevas, events, donations and more.</p>

    <?php if ($notice): ?>
      <div class="alert alert--info" role="status"><span class="alert__icon"><?= adminIcon('info') ?></span><div class="alert__body"><?= h($notice) ?></div></div>
    <?php endif; ?>
    <?php if ($hasError): ?>
      <div class="alert alert--error" role="alert" id="login-error"><span class="alert__icon"><?= adminIcon('alert-circle') ?></span><div class="alert__body"><?= h($error) ?><?php if ($locked): ?> <span class="lock-countdown" data-lock="<?= $lockSec ?>"></span><?php endif; ?></div></div>
    <?php endif; ?>

    <form method="POST" action="/admin/login.php" autocomplete="on" novalidate>
      <?= csrfField() ?>
      <label for="username">
        Username
        <span class="input-affix input-affix--leading">
          <span class="input-affix__icon"><?= adminIcon('user') ?></span>
          <input id="username" type="text" name="username" required autofocus autocomplete="username" spellcheck="false" autocapitalize="off"
                 value="<?= h($username) ?>" <?= $hasError ? 'aria-invalid="true" aria-describedby="login-error"' : '' ?> />
        </span>
      </label>
      <label for="password">
        Password
        <span class="input-affix">
          <input id="password" type="password" name="password" required autocomplete="current-password" <?= $hasError ? 'aria-invalid="true" aria-describedby="login-error"' : '' ?> />
          <button type="button" class="input-affix__btn" data-toggle-password="password" aria-label="Show password" aria-pressed="false"><?= adminIcon('eye') ?></button>
        </span>
      </label>
      <span class="field__hint capslock-hint" data-capslock role="status"><?= adminIcon('alert', 'ico--xs') ?> Caps Lock is on</span>

      <button type="submit" class="btn btn-primary btn--lg btn--block" <?= $locked ? 'disabled' : '' ?>>
        <?= adminIcon('lock') ?> Sign in
      </button>
    </form>

    <details class="login-help">
      <summary><?= adminIcon('key', 'ico--sm') ?> Trouble signing in? <?= adminIcon('chevron-down', 'ico--xs') ?></summary>
      <p>Access is limited to the temple committee. There is no self-service password reset for security reasons — the
         administrator who set up the site can issue a new password by updating the <code>ADMIN_PASS_HASH</code>
         environment variable in the hosting panel and sharing the new password with you privately.</p>
      <p>Still stuck? Contact the President or Secretary listed on the public Contact page.</p>
    </details>
  </section>

  <p class="login-foot"><a href="/"><?= adminIcon('arrow-left', 'ico--xs') ?> Back to website</a></p>
</main>
<script src="/admin/assets/admin.js" defer></script>
<script>
  // Live lock-out countdown → re-enables the button when the minute is up
  (function () {
    var el = document.querySelector('[data-lock]');
    if (!el) return;
    var left = parseInt(el.getAttribute('data-lock'), 10) || 0;
    var btn = document.querySelector('button[type="submit"]');
    var tick = function () {
      if (left <= 0) { el.textContent = 'You can try again now.'; if (btn) btn.disabled = false; return; }
      el.textContent = 'Try again in ' + left + 's.';
      left--; setTimeout(tick, 1000);
    };
    tick();
  })();
</script>
</body>
</html>
