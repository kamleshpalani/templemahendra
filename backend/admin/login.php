<?php
require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/helpers.php';

// Already logged in
if (!empty($_SESSION['admin_logged_in'])) {
    header('Location: /admin/');
    exit;
}

$error    = '';
$username = '';

// Simple per-session throttle: 5 failures -> 60s cool-down
$fails   = (int) ($_SESSION['login_fails'] ?? 0);
$lockedU = (int) ($_SESSION['login_locked_until'] ?? 0);
$locked  = $lockedU > time();

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
        unset($_SESSION['login_fails'], $_SESSION['login_locked_until']);
        header('Location: /admin/');
        exit;
    } else {
        $fails++;
        $_SESSION['login_fails'] = $fails;
        if ($fails >= 5) {
            $_SESSION['login_locked_until'] = time() + 60;
            $_SESSION['login_fails'] = 0;
            $error = 'Too many attempts. Please wait a minute and try again.';
        } else {
            $error = 'Invalid username or password.';
        }
    }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<meta name="theme-color" content="#3d0707" />
<title>Admin Login — Dhabbalavaar Temple</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+Tamil:wght@600;700&display=swap" />
<link rel="stylesheet" href="/admin/assets/admin.css" />
</head>
<body class="login-page">
<div class="login-shell">
  <div class="login-brand">
    <div class="login-brand__logo" aria-hidden="true"><span>🛕</span></div>
    <h1>தபலவார் ரேணுகா தேவி கோவில்</h1>
    <p>Temple Control Center</p>
  </div>

  <div class="login-box">
    <h2>Welcome back</h2>
    <p class="login-sub">Sign in to manage sevas, events, donations and more.</p>

    <?php if ($error): ?>
      <p class="alert alert--error" role="alert"><span aria-hidden="true">⚠️</span> <?= htmlspecialchars($error) ?></p>
    <?php endif; ?>

    <form method="POST" action="/admin/login.php" autocomplete="on" novalidate>
      <?= csrfField() ?>
      <label for="username">
        Username
        <input id="username" type="text" name="username" required autofocus autocomplete="username"
               value="<?= htmlspecialchars($username) ?>" <?= $error ? 'aria-invalid="true"' : '' ?> />
      </label>
      <label for="password">
        Password
        <span class="input-affix">
          <input id="password" type="password" name="password" required autocomplete="current-password" />
          <button type="button" class="input-affix__btn" data-toggle-password="password"
                  aria-label="Show password" aria-pressed="false">👁</button>
        </span>
      </label>
      <button type="submit" class="btn btn-primary btn--block" <?= $locked ? 'disabled' : '' ?>>Sign in</button>
    </form>
  </div>

  <p class="login-foot">Access is restricted to temple committee members. <a href="/">← Back to website</a></p>
</div>
<script src="/admin/assets/admin.js" defer></script>
</body>
</html>
