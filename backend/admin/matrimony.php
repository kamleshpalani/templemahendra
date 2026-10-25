<?php
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/registration.php';
require_once __DIR__ . '/includes/admin_layout.php';
$ready = publicGuardHasColumn('matrimony_profiles','management_hash');
$message = adminCsrfGuard();
if ($ready && $_SERVER['REQUEST_METHOD'] === 'POST' && $message === '') {
    $id = (int)($_POST['id'] ?? 0);
    $status = is_string($_POST['status'] ?? null) ? $_POST['status'] : '';
    if (!in_array($status,['pending','approved','rejected'],true)) {
        $message = '<p class="alert alert--error">Choose a valid moderation status.</p>';
    } else {
        $stmt = getDB()->prepare('UPDATE matrimony_profiles SET status=? WHERE id=?');
        $stmt->execute([$status,$id]);
        if ($stmt->rowCount()) adminAudit('matrimony_moderated','matrimony:'.$id,$status);
        header('Location: /admin/matrimony.php?saved=1',true,303);
        exit;
    }
}
adminHeader('Matrimony','Devotees');
echo $message;
if (!$ready) {
    echo '<p class="alert alert--warning">Apply migration 023_matrimony.sql.</p>';
    adminFooter();
    exit;
}
if (isset($_GET['saved'])) echo '<p class="alert alert--success" role="status">Moderation status saved.</p>';
?>
<p>Profiles are private by default. Approval publishes only the anonymous summary when the applicant explicitly chose Public summary. Names, exact birth dates, phone numbers, email, Rasi and Nakshatram remain private. Check introductions and preferences for personal contact details before approval.</p>
<?php foreach (getDB()->query('SELECT * FROM matrimony_profiles ORDER BY created_at DESC LIMIT 100') as $row): ?>
<article class="card stack">
  <h2>Profile #<?= (int)$row['id'] ?> — <?= h($row['name']) ?></h2>
  <p><?= h($row['status']) ?> · <?= h($row['visibility']) ?> · DOB <?= h($row['date_of_birth']) ?></p>
  <p><?= h($row['phone']) ?> · <?= h($row['email'] ?? '') ?> · <?= h($row['city']) ?></p>
  <p><?= h($row['education'] ?? '') ?> · <?= h($row['occupation'] ?? '') ?></p>
  <p><?= h($row['rasi'] ?? '') ?> · <?= h($row['nakshatram'] ?? '') ?></p>
  <p><?= nl2br(h($row['introduction'] ?? '')) ?></p><p><?= nl2br(h($row['preferences'] ?? '')) ?></p>
  <p>Consent: <?= h($row['consent_at']) ?> · Family draft reuse: <?= h($row['reuse_consent_at'] ?? 'Not permitted') ?></p>
  <form method="post" class="cluster"><?= csrfField() ?><input type="hidden" name="id" value="<?= (int)$row['id'] ?>">
    <label>Review status <select name="status">
    <?php foreach (['pending','approved','rejected'] as $status): ?>
      <option value="<?= h($status) ?>" <?= $status === $row['status'] ? 'selected' : '' ?>><?= h(ucfirst($status)) ?></option>
    <?php endforeach; ?>
    </select></label><button class="btn btn-primary">Save review</button>
  </form>
</article>
<?php endforeach; adminFooter(); ?>
