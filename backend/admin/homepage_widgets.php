<?php
// backend/admin/homepage_widgets.php — Homepage Content Manager
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db  = getDB();
$msg = '';

// ── POST handlers ────────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? '';

    if ($action === 'save') {
        $content_type = in_array($_POST['content_type'] ?? '', [
            'announcement','coming_soon','upcoming_pooja',
            'calendar_pooja','nalla_neram','sponsor','upcoming_event'
        ], true) ? $_POST['content_type'] : 'announcement';

        $source_type = ($_POST['source_type'] ?? 'manual') === 'calendar' ? 'calendar' : 'manual';

        $title_ta       = sanitizeText($_POST['title_ta']       ?? '', 300);
        $title_en       = sanitizeText($_POST['title_en']       ?? '', 300);
        $description_ta = sanitizeText($_POST['description_ta'] ?? '', 2000);
        $description_en = sanitizeText($_POST['description_en'] ?? '', 2000);

        $linked_pooja_id   = ((int)($_POST['linked_pooja_id']   ?? 0)) ?: null;
        $linked_sponsor_id = ((int)($_POST['linked_sponsor_id'] ?? 0)) ?: null;
        $show_sponsor      = isset($_POST['show_sponsor'])    ? 1 : 0;
        $show_nalla_neram  = isset($_POST['show_nalla_neram']) ? 1 : 0;
        $is_pinned         = isset($_POST['is_pinned'])        ? 1 : 0;
        $is_active         = isset($_POST['is_active'])        ? 1 : 0;

        $start_date = sanitizeText($_POST['start_date'] ?? '', 10) ?: null;
        $end_date   = sanitizeText($_POST['end_date']   ?? '', 10) ?: null;
        $priority   = max(1, min(100, (int)($_POST['priority'] ?? 10)));
        $id         = (int)($_POST['id'] ?? 0);

        $fields = [
            ':ct'  => $content_type,  ':src' => $source_type,
            ':tta' => $title_ta,       ':ten' => $title_en,
            ':dta' => $description_ta, ':den' => $description_en,
            ':pid' => $linked_pooja_id,':sid' => $linked_sponsor_id,
            ':ss'  => $show_sponsor,   ':sn'  => $show_nalla_neram,
            ':sd'  => $start_date,     ':ed'  => $end_date,
            ':pr'  => $priority,       ':pin' => $is_pinned,
            ':act' => $is_active,
        ];

        if ($id > 0) {
            $db->prepare('UPDATE homepage_widgets SET
                content_type=:ct, source_type=:src,
                title_ta=:tta,    title_en=:ten,
                description_ta=:dta, description_en=:den,
                linked_pooja_id=:pid, linked_sponsor_id=:sid,
                show_sponsor=:ss, show_nalla_neram=:sn,
                start_date=:sd,   end_date=:ed,
                priority=:pr,     is_pinned=:pin,
                is_active=:act
            WHERE id=:id')
               ->execute(array_merge($fields, [':id' => $id]));
            $msg = '<p class="alert alert--success">Widget updated.</p>';
        } else {
            $db->prepare('INSERT INTO homepage_widgets
                (content_type,source_type,title_ta,title_en,
                 description_ta,description_en,
                 linked_pooja_id,linked_sponsor_id,
                 show_sponsor,show_nalla_neram,
                 start_date,end_date,priority,is_pinned,is_active)
                VALUES
                (:ct,:src,:tta,:ten,:dta,:den,:pid,:sid,:ss,:sn,:sd,:ed,:pr,:pin,:act)')
               ->execute($fields);
            $msg = '<p class="alert alert--success">Widget created.</p>';
        }
    } elseif ($action === 'toggle') {
        $id  = (int)($_POST['id'] ?? 0);
        $val = (int)($_POST['val'] ?? 0);
        if ($id > 0) {
            $db->prepare('UPDATE homepage_widgets SET is_active=:v WHERE id=:id')
               ->execute([':v' => $val ? 0 : 1, ':id' => $id]);
        }
    } elseif ($action === 'delete') {
        $id = (int)($_POST['id'] ?? 0);
        if ($id > 0) {
            $db->prepare('DELETE FROM homepage_widgets WHERE id=:id')->execute([':id' => $id]);
            $msg = '<p class="alert alert--success">Deleted.</p>';
        }
    }
}

// ── Fetch data for lists / dropdowns ────────────────────────────────────────
$rows = $db->query('
    SELECT w.*,
           p.name_ta AS pooja_name,
           s.name    AS sponsor_name
    FROM   homepage_widgets w
    LEFT   JOIN poojas   p ON p.id = w.linked_pooja_id
    LEFT   JOIN sponsors s ON s.id = w.linked_sponsor_id
    ORDER  BY w.is_pinned DESC, w.priority ASC, w.id DESC
    LIMIT  50
')->fetchAll();

$editing = null;
if (isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM homepage_widgets WHERE id=:id');
    $stmt->execute([':id' => (int)$_GET['edit']]);
    $editing = $stmt->fetch() ?: null;
}

$poojas = $db->query(
    "SELECT id,name_ta,name_en,pooja_date FROM poojas
      WHERE is_active=1 ORDER BY pooja_date DESC LIMIT 50"
)->fetchAll();

$sponsors = $db->query(
    "SELECT id, name FROM sponsors WHERE is_active=1 ORDER BY name ASC LIMIT 50"
)->fetchAll();

// ── Labels ───────────────────────────────────────────────────────────────────
$typeLabels = [
    'announcement'    => '📢 அறிவிப்பு (Announcement)',
    'upcoming_event'  => '🎉 நிகழ்வு (Upcoming Event)',
    'coming_soon'     => '⏳ விரைவில் (Coming Soon)',
    'upcoming_pooja'  => '🛕 அடுத்த பூஜை (Upcoming Pooja)',
    'calendar_pooja'  => '🌕 பௌர்ணமி பூஜை (Calendar Pooja)',
    'nalla_neram'     => '⏰ நல்ல நேரம் (Nalla Neram)',
    'sponsor'         => '💛 ஸ்பான்சர் (Sponsor)',
];

adminHeader('🏮 Homepage Content Manager');
echo $msg;
?>

<div class="admin-two-col">

<!-- ── FORM ──────────────────────────────────────────────────────────── -->
<div class="admin-form-box card">
  <h3><?= $editing ? 'Edit Widget' : 'Add Homepage Widget' ?></h3>

  <form method="POST" action="/admin/homepage_widgets.php">
    <input type="hidden" name="action" value="save" />
    <?php if ($editing): ?>
      <input type="hidden" name="id" value="<?= $editing['id'] ?>" />
    <?php endif; ?>

    <label>Content Type *
      <select name="content_type" id="ctSelect">
        <?php foreach ($typeLabels as $val => $lbl): ?>
        <option value="<?= $val ?>"
                <?= ($editing['content_type'] ?? 'announcement') === $val ? 'selected' : '' ?>>
          <?= htmlspecialchars($lbl) ?>
        </option>
        <?php endforeach; ?>
      </select>
    </label>

    <label>Data Source
      <select name="source_type">
        <option value="manual"   <?= ($editing['source_type'] ?? 'manual') === 'manual'   ? 'selected' : '' ?>>Manual (entered below)</option>
        <option value="calendar" <?= ($editing['source_type'] ?? 'manual') === 'calendar' ? 'selected' : '' ?>>Calendar (auto-select next pooja)</option>
      </select>
    </label>

    <label>Title (Tamil)
      <input name="title_ta" maxlength="300"
             value="<?= htmlspecialchars($editing['title_ta'] ?? '') ?>"
             placeholder="பௌர்ணமி பூஜை அறிவிப்பு" />
    </label>
    <label>Title (English)
      <input name="title_en" maxlength="300"
             value="<?= htmlspecialchars($editing['title_en'] ?? '') ?>"
             placeholder="Pournami Pooja Announcement" />
    </label>
    <label>Description (Tamil)
      <textarea name="description_ta" rows="3"><?= htmlspecialchars($editing['description_ta'] ?? '') ?></textarea>
    </label>
    <label>Description (English)
      <textarea name="description_en" rows="3"><?= htmlspecialchars($editing['description_en'] ?? '') ?></textarea>
    </label>

    <label>Link to Pooja (optional)
      <select name="linked_pooja_id">
        <option value="">— None —</option>
        <?php foreach ($poojas as $p): ?>
        <option value="<?= $p['id'] ?>"
                <?= ($editing['linked_pooja_id'] ?? '') == $p['id'] ? 'selected' : '' ?>>
          <?= htmlspecialchars($p['name_ta'] . ' · ' . $p['pooja_date']) ?>
        </option>
        <?php endforeach; ?>
      </select>
    </label>

    <label>Link to Sponsor (optional)
      <select name="linked_sponsor_id">
        <option value="">— None —</option>
        <?php foreach ($sponsors as $sp): ?>
        <option value="<?= $sp['id'] ?>"
                <?= ($editing['linked_sponsor_id'] ?? '') == $sp['id'] ? 'selected' : '' ?>>
          <?= htmlspecialchars($sp['name']) ?>
        </option>
        <?php endforeach; ?>
      </select>
    </label>

    <fieldset style="border:1px solid #ddd;padding:0.75rem;border-radius:8px;margin-bottom:0.75rem">
      <legend style="font-weight:600;padding:0 0.3rem">Display Options</legend>
      <label class="checkbox-label">
        <input type="checkbox" name="show_sponsor"
               <?= ($editing['show_sponsor'] ?? 0) ? 'checked' : '' ?> />
        Show Sponsor Details
      </label>
      <label class="checkbox-label">
        <input type="checkbox" name="show_nalla_neram"
               <?= ($editing['show_nalla_neram'] ?? 0) ? 'checked' : '' ?> />
        Show இன்றைய நல்ல நேரம்
      </label>
    </fieldset>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
      <label>Start Date
        <small style="display:block;color:#888;font-size:0.75rem">For 🎉 Upcoming Event: this is the <strong>event date shown on the card</strong></small>
        <input type="date" name="start_date"
               value="<?= htmlspecialchars($editing['start_date'] ?? '') ?>" />
      </label>
      </label>
      <label>End Date
        <input type="date" name="end_date"
               value="<?= htmlspecialchars($editing['end_date'] ?? '') ?>" />
      </label>
    </div>

    <label>Priority (1=highest, 100=lowest)
      <input type="number" name="priority" min="1" max="100"
             value="<?= (int)($editing['priority'] ?? 10) ?>" />
    </label>

    <label class="checkbox-label">
      <input type="checkbox" name="is_pinned"
             <?= ($editing['is_pinned'] ?? 0) ? 'checked' : '' ?> />
      📌 Pin this widget (always first)
    </label>
    <label class="checkbox-label">
      <input type="checkbox" name="is_active"
             <?= (!$editing || $editing['is_active']) ? 'checked' : '' ?> />
      Active (visible on homepage)
    </label>

    <button type="submit" class="btn btn-primary">Save Widget</button>
    <?php if ($editing): ?>
      <a href="/admin/homepage_widgets.php" class="btn btn-secondary">Cancel</a>
    <?php endif; ?>
  </form>
</div>

<!-- ── LIST ──────────────────────────────────────────────────────────── -->
<div class="admin-list">
  <table class="admin-table">
    <thead>
      <tr>
        <th>#</th>
        <th>Type</th>
        <th>Title</th>
        <th>Source</th>
        <th>Pooja</th>
        <th>Priority</th>
        <th>Active</th>
        <th>Dates</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      <?php foreach ($rows as $row): ?>
      <tr>
        <td><?= $row['is_pinned'] ? '📌' : $row['id'] ?></td>
        <td><span class="badge"><?= htmlspecialchars($typeLabels[$row['content_type']] ?? $row['content_type']) ?></span></td>
        <td>
          <?= htmlspecialchars($row['title_ta'] ?: '—') ?>
          <?php if ($row['title_en']): ?>
            <br><small style="color:#777"><?= htmlspecialchars($row['title_en']) ?></small>
          <?php endif; ?>
        </td>
        <td><?= $row['source_type'] === 'calendar' ? '📅 Auto' : '✏️ Manual' ?></td>
        <td><?= htmlspecialchars($row['pooja_name'] ?: '—') ?></td>
        <td><?= $row['priority'] ?></td>
        <td>
          <form method="POST" action="/admin/homepage_widgets.php" style="display:inline">
            <input type="hidden" name="action" value="toggle" />
            <input type="hidden" name="id" value="<?= $row['id'] ?>" />
            <input type="hidden" name="val" value="<?= $row['is_active'] ?>" />
            <button class="btn btn-sm <?= $row['is_active'] ? 'btn-success' : 'btn-secondary' ?>"
                    title="Toggle active">
              <?= $row['is_active'] ? '✅' : '❌' ?>
            </button>
          </form>
        </td>
        <td style="font-size:0.75rem">
          <?= $row['start_date'] ? 'From: ' . $row['start_date'] : '' ?>
          <?= $row['end_date']   ? '<br>To: ' . $row['end_date']  : '' ?>
          <?= (!$row['start_date'] && !$row['end_date']) ? 'Always' : '' ?>
        </td>
        <td>
          <a href="/admin/homepage_widgets.php?edit=<?= $row['id'] ?>" class="btn btn-sm">Edit</a>
          <form method="POST" action="/admin/homepage_widgets.php" style="display:inline">
            <input type="hidden" name="action" value="delete" />
            <input type="hidden" name="id" value="<?= $row['id'] ?>" />
            <button class="btn btn-sm btn-danger"
                    onclick="return confirm('Delete this widget?')">Del</button>
          </form>
        </td>
      </tr>
      <?php endforeach; ?>
      <?php if (empty($rows)): ?>
        <tr><td colspan="9" style="text-align:center;color:#888;padding:2rem">
          No widgets yet. Create one above.
        </td></tr>
      <?php endif; ?>
    </tbody>
  </table>

  <div style="margin-top:1rem;padding:1rem;background:#fff8f0;border-radius:8px;font-size:0.85rem;color:#7a5c3c">
    <strong>Priority Rules:</strong>
    📌 Pinned items appear first → 📢 Announcements → 🛕 Upcoming Poojas →
    🌕 Calendar Poojas → 💛 Sponsors → ⏰ Nalla Neram.
    Expired widgets (past end date) are automatically hidden.
  </div>
</div>

</div>
<?php adminFooter(); ?>
