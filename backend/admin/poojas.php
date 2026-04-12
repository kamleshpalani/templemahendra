<?php
// backend/admin/poojas.php — Pooja Manager (Pournami, Amavasai, special events)
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db  = getDB();
$msg = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? '';

    if ($action === 'save') {
        $name_ta    = sanitizeText($_POST['name_ta']    ?? '');
        $name_en    = sanitizeText($_POST['name_en']    ?? '');
        $desc_ta    = sanitizeText($_POST['description_ta'] ?? '', 2000);
        $desc_en    = sanitizeText($_POST['description_en'] ?? '', 2000);
        $date       = sanitizeText($_POST['pooja_date'] ?? '');
        $time       = sanitizeText($_POST['pooja_time'] ?? '', 20);
        $type       = in_array($_POST['pooja_type'] ?? '', ['pournami','amavasai','ekadasi','sashti','special','monthly','daily'], true)
                      ? $_POST['pooja_type'] : 'special';
        $is_active  = isset($_POST['is_active']) ? 1 : 0;
        $id         = (int)($_POST['id'] ?? 0);

        if ($name_ta === '' || $name_en === '' || $date === '') {
            $msg = '<p class="alert alert--error">Tamil name, English name, and date are required.</p>';
        } elseif ($id > 0) {
            $db->prepare('UPDATE poojas SET name_ta=:ta,name_en=:en,description_ta=:dta,description_en=:den,
                          pooja_date=:dt,pooja_time=:tm,pooja_type=:typ,is_active=:a WHERE id=:id')
               ->execute([':ta'=>$name_ta,':en'=>$name_en,':dta'=>$desc_ta,':den'=>$desc_en,
                          ':dt'=>$date,':tm'=>$time,':typ'=>$type,':a'=>$is_active,':id'=>$id]);
            $msg = '<p class="alert alert--success">Pooja updated.</p>';
        } else {
            $db->prepare('INSERT INTO poojas (name_ta,name_en,description_ta,description_en,
                          pooja_date,pooja_time,pooja_type,is_active) VALUES (:ta,:en,:dta,:den,:dt,:tm,:typ,:a)')
               ->execute([':ta'=>$name_ta,':en'=>$name_en,':dta'=>$desc_ta,':den'=>$desc_en,
                          ':dt'=>$date,':tm'=>$time,':typ'=>$type,':a'=>$is_active]);
            $msg = '<p class="alert alert--success">Pooja created.</p>';
        }
    } elseif ($action === 'delete') {
        $id = (int)($_POST['id'] ?? 0);
        if ($id > 0) {
            $db->prepare('DELETE FROM poojas WHERE id=:id')->execute([':id'=>$id]);
            $msg = '<p class="alert alert--success">Deleted.</p>';
        }
    }
}

$rows = $db->query(
    'SELECT * FROM poojas ORDER BY pooja_date DESC LIMIT 60'
)->fetchAll();

$editing = null;
if (isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM poojas WHERE id=:id');
    $stmt->execute([':id' => (int)$_GET['edit']]);
    $editing = $stmt->fetch() ?: null;
}

$typeLabels = [
    'pournami'=>'பௌர்ணமி (Pournami)',
    'amavasai'=>'அமாவாசை (Amavasai)',
    'ekadasi' =>'ஏகாதசி (Ekadasi)',
    'sashti'  =>'சஷ்டி (Sashti)',
    'special' =>'Special',
    'monthly' =>'Monthly',
    'daily'   =>'Daily',
];

adminHeader('🛕 Pooja Manager');
echo $msg;
?>

<div class="admin-two-col">

<div class="admin-form-box card">
  <h3><?= $editing ? 'Edit Pooja' : 'Add Pooja' ?></h3>
  <form method="POST" action="/admin/poojas.php">
    <input type="hidden" name="action" value="save" />
    <?php if ($editing): ?><input type="hidden" name="id" value="<?= $editing['id'] ?>" /><?php endif; ?>

    <label>Tamil Name (பெயர்) *
      <input name="name_ta" required
             value="<?= htmlspecialchars($editing['name_ta'] ?? '') ?>"
             placeholder="பௌர்ணமி பூஜை" />
    </label>
    <label>English Name *
      <input name="name_en" required
             value="<?= htmlspecialchars($editing['name_en'] ?? '') ?>"
             placeholder="Pournami Pooja" />
    </label>
    <label>Pooja Date *
      <input type="date" name="pooja_date" required
             value="<?= htmlspecialchars($editing['pooja_date'] ?? '') ?>" />
    </label>
    <label>Pooja Time
      <input name="pooja_time" maxlength="20"
             value="<?= htmlspecialchars($editing['pooja_time'] ?? '') ?>"
             placeholder="07:00 AM" />
    </label>
    <label>Type *
      <select name="pooja_type">
        <?php foreach ($typeLabels as $val => $lbl): ?>
        <option value="<?= $val ?>" <?= ($editing['pooja_type'] ?? 'special') === $val ? 'selected' : '' ?>>
          <?= htmlspecialchars($lbl) ?>
        </option>
        <?php endforeach; ?>
      </select>
    </label>
    <label>Description (Tamil)
      <textarea name="description_ta" rows="3"><?= htmlspecialchars($editing['description_ta'] ?? '') ?></textarea>
    </label>
    <label>Description (English)
      <textarea name="description_en" rows="3"><?= htmlspecialchars($editing['description_en'] ?? '') ?></textarea>
    </label>
    <label class="checkbox-label">
      <input type="checkbox" name="is_active"
             <?= (!$editing || $editing['is_active']) ? 'checked' : '' ?> />
      Active
    </label>
    <button type="submit" class="btn btn-primary">Save Pooja</button>
    <?php if ($editing): ?>
      <a href="/admin/poojas.php" class="btn btn-secondary">Cancel</a>
    <?php endif; ?>
  </form>
</div>

<div class="admin-list">
  <table class="admin-table">
    <thead>
      <tr>
        <th>Date</th><th>Tamil Name</th><th>Type</th>
        <th>Active</th><th>Actions</th>
      </tr>
    </thead>
    <tbody>
      <?php foreach ($rows as $row): ?>
      <tr>
        <td><?= htmlspecialchars($row['pooja_date']) ?></td>
        <td><?= htmlspecialchars($row['name_ta']) ?><br>
            <small style="color:#666"><?= htmlspecialchars($row['name_en']) ?></small></td>
        <td><span class="badge"><?= htmlspecialchars($typeLabels[$row['pooja_type']] ?? $row['pooja_type']) ?></span></td>
        <td><?= $row['is_active'] ? '✅' : '❌' ?></td>
        <td>
          <a href="/admin/poojas.php?edit=<?= $row['id'] ?>" class="btn btn-sm">Edit</a>
          <form method="POST" action="/admin/poojas.php" style="display:inline">
            <input type="hidden" name="action" value="delete" />
            <input type="hidden" name="id" value="<?= $row['id'] ?>" />
            <button class="btn btn-sm btn-danger"
                    onclick="return confirm('Delete this pooja?')">Del</button>
          </form>
        </td>
      </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
</div>

</div>
<?php adminFooter(); ?>
