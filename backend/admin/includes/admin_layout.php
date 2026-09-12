<?php
// backend/admin/includes/admin_layout.php — Control-center shell.
// Usage: adminHeader($pageTitle, $crumb, ['actions' => '<html>', 'wide' => bool]) … adminFooter()

require_once __DIR__ . '/admin_ui.php';

/** Grouped sidebar navigation: [group => [file => [icon, label, description]]] */
function adminNavGroups(): array
{
    return [
        'Overview' => [
            'index.php'            => ['dashboard',   'Dashboard',        'KPIs, analytics and recent activity'],
        ],
        'Content' => [
            'homepage_widgets.php' => ['layers',      'Homepage Widgets', 'Cards shown on the public homepage'],
            'announcements.php'    => ['megaphone',   'Announcements',    'Notices in the homepage ticker'],
            'gallery.php'          => ['image',       'Gallery',          'Photos for the public gallery'],
        ],
        'Worship' => [
            'poojas.php'           => ['flame',       'Poojas',           'Pournami, Amavasai and special poojas'],
            'sevas.php'            => ['sparkles',    'Sevas',            'Bookable sevas and prices'],
            'events.php'           => ['calendar',    'Events',           'Festivals and temple events'],
            'sponsors.php'         => ['heart-hands', 'Sponsors',         'Devotees sponsoring poojas'],
        ],
        'Devotees' => [
            'seva_bookings.php'    => ['clipboard',   'Seva Bookings',    'Online seva requests'],
            'donations.php'        => ['banknote',    'Donations',        'Pledges, totals and CSV reports'],
            'contact_messages.php' => ['mail',        'Messages',         'Enquiries from the contact form'],
        ],
        'Data & System' => [
            'bulk_upload.php'      => ['upload',      'Bulk Upload',      'Import CSV / Excel data'],
            'settings.php'         => ['settings',    'Settings',         'Homepage sections and account'],
        ],
    ];
}

/** Quick actions surfaced in the command palette and dashboard. */
function adminQuickActions(): array
{
    return [
        ['label' => 'New event',              'href' => '/admin/events.php#new',         'icon' => 'plus'],
        ['label' => 'New announcement',       'href' => '/admin/announcements.php#new',  'icon' => 'plus'],
        ['label' => 'New seva',               'href' => '/admin/sevas.php#new',          'icon' => 'plus'],
        ['label' => 'Add pooja',              'href' => '/admin/poojas.php#new',         'icon' => 'plus'],
        ['label' => 'Upload photo',           'href' => '/admin/gallery.php#new',        'icon' => 'upload'],
        ['label' => 'Bulk upload CSV / Excel','href' => '/admin/bulk_upload.php',        'icon' => 'spreadsheet'],
        ['label' => 'Export donations CSV',   'href' => '/admin/donations.php?export=csv','icon' => 'download'],
        ['label' => 'Export bookings CSV',    'href' => '/admin/seva_bookings.php?export=csv','icon' => 'download'],
        ['label' => 'View public site',       'href' => '/',                             'icon' => 'external', 'external' => true],
        ['label' => 'Sign out',               'href' => '/admin/logout.php',             'icon' => 'logout'],
    ];
}

function adminHeader(string $pageTitle, string $crumb = 'Temple Admin', array $opts = []): void
{
    $current  = basename($_SERVER['PHP_SELF']);
    $user     = (string) ($_SESSION['admin_user'] ?? 'admin');
    $initials = strtoupper(mb_substr($user, 0, 1));
    $actions  = (string) ($opts['actions'] ?? '');
    $wide     = !empty($opts['wide']);
    ?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<meta name="theme-color" content="#3d0707" />
<meta name="color-scheme" content="light" />
<title><?= h($pageTitle) ?> — Temple Admin</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter:wght@400;500;600;700&family=Noto+Serif+Tamil:wght@600;700&family=Noto+Sans+Tamil:wght@400;500;600&display=swap" />
<link rel="stylesheet" href="/admin/assets/ds/tokens.css" />
<link rel="stylesheet" href="/admin/assets/ds/base.css" />
<link rel="stylesheet" href="/admin/assets/ds/layout.css" />
<link rel="stylesheet" href="/admin/assets/ds/components.css" />
<link rel="stylesheet" href="/admin/assets/ds/utilities.css" />
<link rel="stylesheet" href="/admin/assets/admin.css" />
<script>
  // Restore sidebar collapse state before paint to avoid a flash
  try { if (localStorage.getItem('admin.sidebar') === 'collapsed') document.documentElement.classList.add('sidebar-collapsed'); } catch (e) {}
</script>
</head>
<body class="admin-body">
<a href="#admin-content" class="skip-link">Skip to content</a>
<div class="sidebar-backdrop" aria-hidden="true"></div>

<aside class="sidebar" id="sidebar" aria-label="Admin navigation">
  <div class="sidebar__brand">
    <a href="/admin/" class="sidebar__logo" aria-label="Dashboard">
      <img src="/logo.svg" alt="" width="40" height="40" />
    </a>
    <div class="sidebar__brand-text">
      <strong lang="ta">தபலவார் கோவில்</strong>
      <small>Control Center</small>
    </div>
    <button type="button" class="sidebar__collapse" data-sidebar-collapse aria-label="Collapse sidebar" data-tip="Collapse">
      <?= adminIcon('chevrons-left') ?>
    </button>
  </div>

  <button type="button" class="sidebar__search" data-palette-open aria-label="Search pages and actions (Ctrl+K)">
    <?= adminIcon('search') ?>
    <span class="sidebar__search-label">Search…</span>
    <kbd class="sidebar__kbd">Ctrl K</kbd>
  </button>

  <nav class="sidebar__nav">
    <?php foreach (adminNavGroups() as $group => $items): ?>
      <span class="sidebar__group"><?= h($group) ?></span>
      <?php foreach ($items as $file => [$icon, $label, $desc]): $active = $current === $file; ?>
        <a href="/admin/<?= $file === 'index.php' ? '' : $file ?>"
           class="sidebar__link<?= $active ? ' is-active' : '' ?>"
           <?= $active ? 'aria-current="page"' : '' ?>
           data-tip="<?= h($label) ?>">
          <?= adminIcon($icon) ?><span class="sidebar__link-label"><?= h($label) ?></span>
        </a>
      <?php endforeach; ?>
    <?php endforeach; ?>
  </nav>

  <div class="sidebar__footer">
    <a href="/" target="_blank" rel="noopener" class="sidebar__link" data-tip="View site">
      <?= adminIcon('external') ?><span class="sidebar__link-label">View public site</span>
    </a>
    <div class="sidebar__user">
      <span class="avatar" aria-hidden="true"><?= h($initials) ?></span>
      <span class="sidebar__user-name"><?= h($user) ?></span>
      <a href="/admin/logout.php" class="sidebar__logout" data-tip="Sign out" aria-label="Sign out"><?= adminIcon('logout') ?></a>
    </div>
  </div>
</aside>

<div class="admin-main">
  <header class="admin-topbar">
    <button type="button" class="btn btn-ghost btn--icon sidebar-toggle" aria-label="Open navigation" aria-controls="sidebar" aria-expanded="false"><?= adminIcon('menu') ?></button>
    <div class="admin-topbar__title">
      <nav class="admin-crumbs" aria-label="Breadcrumb">
        <a href="/admin/">Admin</a><span aria-hidden="true">/</span><span><?= h($crumb) ?></span>
      </nav>
      <h1><?= h($pageTitle) ?></h1>
    </div>
    <div class="admin-topbar__actions">
      <?= $actions ?>
      <button type="button" class="btn btn-ghost btn--icon" data-palette-open aria-label="Search (Ctrl+K)" data-tip="Search · Ctrl K"><?= adminIcon('search') ?></button>
      <div class="dropdown">
        <button type="button" class="topbar-user" data-menu-toggle aria-haspopup="menu" aria-expanded="false" aria-controls="user-menu">
          <span class="avatar" aria-hidden="true"><?= h($initials) ?></span>
          <span class="topbar-user__name"><?= h($user) ?></span>
          <?= adminIcon('chevron-down', 'ico--sm') ?>
        </button>
        <div class="menu" id="user-menu" role="menu" hidden>
          <div class="menu__label">Signed in as <?= h($user) ?></div>
          <a class="menu__item" role="menuitem" href="/" target="_blank" rel="noopener"><?= adminIcon('external') ?>View public site</a>
          <a class="menu__item" role="menuitem" href="/admin/settings.php"><?= adminIcon('settings') ?>Settings</a>
          <div class="menu__divider" role="separator"></div>
          <a class="menu__item menu__item--danger" role="menuitem" href="/admin/logout.php"><?= adminIcon('logout') ?>Sign out</a>
        </div>
      </div>
    </div>
  </header>

  <main class="admin-content<?= $wide ? ' admin-content--wide' : '' ?>" id="admin-content" tabindex="-1">
<?php
}

function adminFooter(): void
{
    $palette = [];
    foreach (adminNavGroups() as $group => $items) {
        foreach ($items as $file => [$icon, $label, $desc]) {
            $palette[] = ['type' => 'page', 'group' => $group, 'label' => $label, 'desc' => $desc, 'href' => '/admin/' . ($file === 'index.php' ? '' : $file), 'icon' => $icon];
        }
    }
    foreach (adminQuickActions() as $a) {
        $palette[] = ['type' => 'action', 'group' => 'Quick actions', 'label' => $a['label'], 'desc' => '', 'href' => $a['href'], 'icon' => $a['icon'], 'external' => !empty($a['external'])];
    }
    ?>
  </main><!-- /admin-content -->
</div><!-- /admin-main -->

<!-- Command palette -->
<div class="palette" id="palette" hidden>
  <div class="palette__panel" role="dialog" aria-modal="true" aria-label="Search pages and actions">
    <div class="palette__search">
      <?= adminIcon('search') ?>
      <input type="search" id="palette-input" placeholder="Jump to a page or run an action…" autocomplete="off" spellcheck="false" aria-label="Search pages and actions" aria-controls="palette-list" aria-expanded="true" role="combobox" />
      <kbd>Esc</kbd>
    </div>
    <ul class="palette__list" id="palette-list" role="listbox"></ul>
    <div class="palette__hint"><kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>↵</kbd> open</div>
  </div>
</div>
<script type="application/json" id="palette-data"><?= json_encode($palette, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG) ?></script>
<script type="application/json" id="icon-sprite"><?= json_encode([
    'dashboard' => adminIcon('dashboard'), 'layers' => adminIcon('layers'), 'megaphone' => adminIcon('megaphone'), 'image' => adminIcon('image'),
    'flame' => adminIcon('flame'), 'sparkles' => adminIcon('sparkles'), 'calendar' => adminIcon('calendar'), 'heart-hands' => adminIcon('heart-hands'),
    'clipboard' => adminIcon('clipboard'), 'banknote' => adminIcon('banknote'), 'mail' => adminIcon('mail'), 'upload' => adminIcon('upload'),
    'settings' => adminIcon('settings'), 'plus' => adminIcon('plus'), 'download' => adminIcon('download'), 'external' => adminIcon('external'),
    'logout' => adminIcon('logout'), 'spreadsheet' => adminIcon('spreadsheet'), 'trash' => adminIcon('trash'), 'alert' => adminIcon('alert'),
    'check-circle' => adminIcon('check-circle'), 'alert-circle' => adminIcon('alert-circle'), 'info' => adminIcon('info'), 'x' => adminIcon('x'),
], JSON_UNESCAPED_SLASHES | JSON_HEX_TAG) ?></script>
<script src="/admin/assets/admin.js" defer></script>
</body>
</html>
    <?php
}
