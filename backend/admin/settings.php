<?php
// backend/admin/settings.php — Homepage Section Visibility Manager
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

// ── Handle POST ──────────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $allowedKeys = ['show_pournami_section', 'show_nalla_strip', 'show_donor_ticker'];
    $stmt = $db->prepare("UPDATE homepage_settings SET val=? WHERE key_name=?");
    foreach ($allowedKeys as $key) {
        $val = isset($_POST[$key]) ? '1' : '0';
        $stmt->execute([$val, $key]);
    }
    $msg = '<p class="alert alert--success">Settings saved.</p>';
}

$settings = $db->query("SELECT key_name, val, label FROM homepage_settings")
    ->fetchAll(PDO::FETCH_ASSOC);
$map = [];
foreach ($settings as $s) {
    $map[$s['key_name']] = $s;
}

adminHeader('Homepage Settings', 'Data & System');
echo $msg;
?>

<div class="card" style="max-width:680px">
  <div class="card__head">
    <h3>Homepage Section Visibility</h3>
    <span class="badge badge--info">Live</span>
  </div>
  <div class="card__body">
  <p class="muted mb-4">
    Toggle which sections appear on the public homepage.
    Changes take effect immediately for all visitors.
  </p>

  <form method="POST" action="/admin/settings.php">

    <fieldset>
      <legend>🌕 Pournami Pooja Section</legend>
      <label class="checkbox-label">
        <input type="checkbox" name="show_pournami_section"
               <?= ($map['show_pournami_section']['val'] ?? '1') === '1' ? 'checked' : '' ?> />
        Show Pournami Poojai countdown + donor ticker on homepage
      </label>
    </fieldset>

    <fieldset>
      <legend>✨ Nalla Neram Strip</legend>
      <label class="checkbox-label">
        <input type="checkbox" name="show_nalla_strip"
               <?= ($map['show_nalla_strip']['val'] ?? '1') === '1' ? 'checked' : '' ?> />
        Show daily Nalla Neram (auspicious time) green strip below announcements
      </label>
    </fieldset>

    <fieldset>
      <legend>🙏 Donor Ticker</legend>
      <label class="checkbox-label">
        <input type="checkbox" name="show_donor_ticker"
               <?= ($map['show_donor_ticker']['val'] ?? '1') === '1' ? 'checked' : '' ?> />
        Show scrolling donor/sponsor names inside Pournami section
      </label>
    </fieldset>

    <div class="form-actions">
      <button type="submit" class="btn btn-primary">Save Settings</button>
    </div>
  </form>
  </div>
</div>

<?php adminFooter(); ?>
