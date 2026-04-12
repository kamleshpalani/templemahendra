<?php
// backend/admin/settings.php — Homepage Section Visibility Manager
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db  = getDB();
$msg = '';

// Ensure table exists
$db->exec("CREATE TABLE IF NOT EXISTS homepage_settings (
  key_name TEXT PRIMARY KEY,
  val      TEXT NOT NULL DEFAULT '1',
  label    TEXT
)");

// Seed defaults
$defaults = [
    ['show_pournami_section', '1', 'Show Pournami Poojai section on homepage'],
    ['show_nalla_strip',      '1', 'Show Nalla Neram strip on homepage'],
    ['show_donor_ticker',     '1', 'Show donor scroll ticker'],
];
$ins = $db->prepare("INSERT OR IGNORE INTO homepage_settings (key_name, val, label) VALUES (?,?,?)");
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

adminHeader('⚙️ Homepage Settings');
echo $msg;
?>

<div class="card" style="max-width:640px;padding:2rem">
  <h3 style="margin-bottom:1.5rem">Homepage Section Visibility</h3>
  <p style="color:var(--text-3);font-size:0.9rem;margin-bottom:1.5rem">
    Toggle which sections appear on the public homepage.
    Changes take effect immediately for all visitors.
  </p>

  <form method="POST" action="/admin/settings.php">

    <fieldset style="border:1px solid #e5e7eb;border-radius:10px;padding:1rem 1.25rem;margin-bottom:1rem">
      <legend style="font-weight:700;padding:0 0.4rem">🌕 Pournami Pooja Section</legend>
      <label class="checkbox-label" style="font-size:1rem">
        <input type="checkbox" name="show_pournami_section"
               <?= ($map['show_pournami_section']['val'] ?? '1') === '1' ? 'checked' : '' ?> />
        Show Pournami Poojai countdown + donor ticker on homepage
      </label>
    </fieldset>

    <fieldset style="border:1px solid #e5e7eb;border-radius:10px;padding:1rem 1.25rem;margin-bottom:1rem">
      <legend style="font-weight:700;padding:0 0.4rem">✨ Nalla Neram Strip</legend>
      <label class="checkbox-label" style="font-size:1rem">
        <input type="checkbox" name="show_nalla_strip"
               <?= ($map['show_nalla_strip']['val'] ?? '1') === '1' ? 'checked' : '' ?> />
        Show daily Nalla Neram (auspicious time) green strip below announcements
      </label>
    </fieldset>

    <fieldset style="border:1px solid #e5e7eb;border-radius:10px;padding:1rem 1.25rem;margin-bottom:1.5rem">
      <legend style="font-weight:700;padding:0 0.4rem">🙏 Donor Ticker</legend>
      <label class="checkbox-label" style="font-size:1rem">
        <input type="checkbox" name="show_donor_ticker"
               <?= ($map['show_donor_ticker']['val'] ?? '1') === '1' ? 'checked' : '' ?> />
        Show scrolling donor/sponsor names inside Pournami section
      </label>
    </fieldset>

    <button type="submit" class="btn btn-primary">💾 Save Settings</button>
  </form>
</div>

<?php adminFooter(); ?>
