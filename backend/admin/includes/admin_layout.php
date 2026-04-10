<?php
// backend/admin/includes/admin_layout.php
// Usage: call adminHeader($pageTitle) at top of each page, adminFooter() at bottom.

function adminHeader(string $pageTitle): void
{
    ?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title><?= htmlspecialchars($pageTitle) ?> — Temple Admin</title>
<link rel="stylesheet" href="/admin/assets/admin.css" />
</head>
<body>
<aside class="sidebar">
  <div class="sidebar__brand">
    <strong>ஸ்ரீ மகேந்திர</strong>
    <small>Admin Panel</small>
  </div>
  <nav class="sidebar__nav">
    <a href="/admin/"                   class="<?= basename($_SERVER['PHP_SELF']) === 'index.php'         ? 'active' : '' ?>">📊 Dashboard</a>
    <a href="/admin/announcements.php"  class="<?= basename($_SERVER['PHP_SELF']) === 'announcements.php' ? 'active' : '' ?>">📢 Announcements</a>
    <a href="/admin/sevas.php"          class="<?= basename($_SERVER['PHP_SELF']) === 'sevas.php'         ? 'active' : '' ?>">🙏 Sevas</a>
    <a href="/admin/events.php"         class="<?= basename($_SERVER['PHP_SELF']) === 'events.php'        ? 'active' : '' ?>">📅 Events</a>
    <a href="/admin/gallery.php"        class="<?= basename($_SERVER['PHP_SELF']) === 'gallery.php'       ? 'active' : '' ?>">🖼️ Gallery</a>
    <a href="/admin/donations.php"      class="<?= basename($_SERVER['PHP_SELF']) === 'donations.php'      ? 'active' : '' ?>">💰 Donations</a>
    <a href="/admin/seva_bookings.php"   class="<?= basename($_SERVER['PHP_SELF']) === 'seva_bookings.php'   ? 'active' : '' ?>">📋 Seva Bookings</a>
    <a href="/admin/contact_messages.php" class="<?= basename($_SERVER['PHP_SELF']) === 'contact_messages.php' ? 'active' : '' ?>">✉️ Messages</a>
  </nav>
  <div class="sidebar__footer">
    <a href="/admin/logout.php">Logout ↗</a>
  </div>
</aside>
<main class="admin-main">
<header class="admin-topbar">
  <h1><?= htmlspecialchars($pageTitle) ?></h1>
  <span>Logged in as <strong><?= htmlspecialchars($_SESSION['admin_user'] ?? 'admin') ?></strong></span>
</header>
<div class="admin-content">
<?php
}

function adminFooter(): void
{
    ?>
</div><!-- /admin-content -->
</main><!-- /admin-main -->
</body>
</html>
    <?php
}
