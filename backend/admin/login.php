<?php
require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/helpers.php';

// Already logged in
if (!empty($_SESSION['admin_logged_in'])) {
    header('Location: /admin/');
    exit;
}

$error = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $username = trim($_POST['username'] ?? '');
    $password = $_POST['password'] ?? '';

    if (adminLogin($username, $password)) {
        session_regenerate_id(true);
        $_SESSION['admin_logged_in'] = true;
        $_SESSION['admin_user']      = $username;
        header('Location: /admin/');
        exit;
    } else {
        $error = 'Invalid username or password.';
    }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Admin Login — Dhabbalavaar Temple</title>
<link rel="stylesheet" href="assets/admin.css" />
</head>
<body class="login-page">
<div class="login-box">
  <h1>தபலவார் ரேணுகா தேவி கோவில்</h1>
  <h2>Admin Login</h2>

  <?php if ($error): ?>
    <p class="alert alert--error"><?= htmlspecialchars($error) ?></p>
  <?php endif; ?>

  <form method="POST" action="/admin/login.php" autocomplete="off">
    <label>
      Username
      <input type="text" name="username" required autofocus />
    </label>
    <label>
      Password
      <input type="password" name="password" required />
    </label>
    <button type="submit" class="btn btn-primary">Login</button>
  </form>
</div>
</body>
</html>
