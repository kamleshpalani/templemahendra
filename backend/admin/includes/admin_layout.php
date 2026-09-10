<?php
// backend/admin/includes/admin_layout.php
// Usage: call adminHeader($pageTitle) at top of each page, adminFooter() at bottom.

/** Grouped sidebar navigation: [group => [file => [icon, label]]] */
function adminNavGroups(): array
{
    return [
        'Overview' => [
            'index.php'            => ['📊', 'Dashboard'],
        ],
        'Content' => [
            'homepage_widgets.php' => ['🏮', 'Homepage Widgets'],
            'announcements.php'    => ['📢', 'Announcements'],
            'gallery.php'          => ['🖼️', 'Gallery'],
        ],
        'Worship' => [
            'poojas.php'           => ['🛕', 'Poojas'],
            'sevas.php'            => ['🙏', 'Sevas'],
            'events.php'           => ['📅', 'Events'],
            'sponsors.php'         => ['💛', 'Sponsors'],
        ],
        'Devotees' => [
            'seva_bookings.php'    => ['📋', 'Seva Bookings'],
            'donations.php'        => ['💰', 'Donations'],
            'contact_messages.php' => ['✉️', 'Messages'],
        ],
        'Data & System' => [
            'bulk_upload.php'      => ['📤', 'Bulk Upload'],
            'settings.php'         => ['⚙️', 'Settings'],
        ],
    ];
}

function adminHeader(string $pageTitle, string $crumb = 'Temple Admin'): void
{
    $current  = basename($_SERVER['PHP_SELF']);
    $user     = (string) ($_SESSION['admin_user'] ?? 'admin');
    $initials = strtoupper(mb_substr($user, 0, 1));
    ?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<meta name="theme-color" content="#3d0707" />
<title><?= htmlspecialchars($pageTitle) ?> — Temple Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+Tamil:wght@600;700&family=Noto+Sans+Tamil:wght@400;500;600&display=swap" />
<link rel="stylesheet" href="/admin/assets/admin.css" />
</head>
<body class="admin-body">
<a href="#admin-content" class="skip-link">Skip to content</a>
<div class="sidebar-backdrop" aria-hidden="true"></div>
<aside class="sidebar" id="sidebar" aria-label="Admin navigation">
  <div class="sidebar__brand">
    <span class="sidebar__logo" aria-hidden="true">🛕</span>
    <div>
      <strong>தபலவார் கோவில்</strong>
      <small>Control Center</small>
    </div>
  </div>
  <nav class="sidebar__nav">
    <?php foreach (adminNavGroups() as $group => $items): ?>
      <span class="sidebar__group"><?= htmlspecialchars($group) ?></span>
      <?php foreach ($items as $file => [$icon, $label]): ?>
        <a href="/admin/<?= $file === 'index.php' ? '' : $file ?>"
           class="<?= $current === $file ? 'active' : '' ?>"
           <?= $current === $file ? 'aria-current="page"' : '' ?>>
          <span class="ico" aria-hidden="true"><?= $icon ?></span><?= htmlspecialchars($label) ?>
        </a>
      <?php endforeach; ?>
    <?php endforeach; ?>
  </nav>
  <div class="sidebar__footer">
    <div class="sidebar__user">
      <span class="sidebar__avatar" aria-hidden="true"><?= htmlspecialchars($initials) ?></span>
      <span><?= htmlspecialchars($user) ?></span>
    </div>
    <a href="/admin/logout.php" class="sidebar__logout">Sign out ↗</a>
  </div>
</aside>
<main class="admin-main">
<header class="admin-topbar">
  <button type="button" class="sidebar-toggle" aria-label="Open navigation" aria-controls="sidebar" aria-expanded="false">☰</button>
  <h1>
    <span class="admin-topbar__crumb"><?= htmlspecialchars($crumb) ?></span>
    <?= htmlspecialchars($pageTitle) ?>
  </h1>
  <div class="admin-topbar__actions">
    <a href="/" class="btn btn-ghost btn-sm" target="_blank" rel="noopener">View site ↗</a>
  </div>
  <span>Signed in as <strong><?= htmlspecialchars($user) ?></strong></span>
</header>
<div class="admin-content" id="admin-content" tabindex="-1">
<?php
}

function adminFooter(): void
{
    ?>
</div><!-- /admin-content -->
</main><!-- /admin-main -->
<script src="/admin/assets/admin.js" defer></script>
</body>
</html>
    <?php
}
