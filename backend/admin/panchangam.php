<?php
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/panchangam.php';
require_once __DIR__ . '/includes/admin_layout.php';

$ready = panchangamReady();
$errors = [];
$text = static fn(string $key): string => is_string($_POST[$key] ?? null) ? trim($_POST[$key]) : '';
$date = is_string($_GET['date'] ?? null) ? $_GET['date'] : date('Y-m-d');
$record = [];
$message = '';
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $message = adminCsrfGuard();
    $date = $text('calendar_date');
    if (!$ready) $errors[] = 'Apply migration 020 before saving.';
    if (!isValidDate($date)) $errors[] = 'Choose a valid date.';
    $record = ['calendar_date' => $date];
    foreach (['tithi_ta', 'tithi_en', 'nakshatram_ta', 'nakshatram_en', 'source'] as $key) {
        $record[$key] = $text($key);
        if ($record[$key] === '' || mb_strlen($record[$key]) > ($key === 'source' ? 500 : 100)) $errors[] = "Enter a valid $key.";
    }
    $times = [];
    foreach (PANCHANGAM_TIMINGS as $key => $label) {
        $record[$key] = $text($key);
        $times[$key] = panchangamParseTimes($record[$key]);
        if ($times[$key] === null) $errors[] = "$label: use HH:MM-HH:MM, separated by commas for multiple windows.";
    }
    if (!$errors && $message === '') {
        $stmt = getDB()->prepare('INSERT INTO panchangam_days
            (calendar_date,tithi_ta,tithi_en,nakshatram_ta,nakshatram_en,timings,source,location,timezone)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE tithi_ta=VALUES(tithi_ta),tithi_en=VALUES(tithi_en),
            nakshatram_ta=VALUES(nakshatram_ta),nakshatram_en=VALUES(nakshatram_en),
            timings=VALUES(timings),source=VALUES(source),location=VALUES(location),timezone=VALUES(timezone)');
        $stmt->execute([$date, $record['tithi_ta'], $record['tithi_en'], $record['nakshatram_ta'],
            $record['nakshatram_en'], json_encode($times, JSON_THROW_ON_ERROR), $record['source'],
            PANCHANGAM_LOCATION, 'Asia/Kolkata']);
        adminAudit('panchangam_updated', 'panchangam:' . $date, 'Committee-verified daily values');
        header('Location: /admin/panchangam.php?date=' . rawurlencode($date) . '&saved=1', true, 303);
        exit;
    }
} elseif ($ready && isValidDate($date)) {
    $stmt = getDB()->prepare('SELECT * FROM panchangam_days WHERE calendar_date=?');
    $stmt->execute([$date]);
    $record = $stmt->fetch() ?: [];
    foreach (json_decode($record['timings'] ?? '{}', true, 512, JSON_THROW_ON_ERROR) as $key => $pairs) {
        $record[$key] = implode(', ', array_map(static fn($p) => implode('-', $p), $pairs));
    }
}
adminHeader('Daily Panchangam', 'Worship');
?>
<p>Enter only values verified against a local Panchangam for <?= h(PANCHANGAM_LOCATION) ?>. All times are Asia/Kolkata (IST). Use Temple Calendar to manage festival and Pournami highlights.</p>
<?php if (!$ready): ?><p class="alert alert--warning">Apply database migration 020_verified_panchangam.sql.</p><?php endif; ?>
<?= $message ?>
<?php foreach ($errors as $error): ?><p class="alert alert--error" role="alert"><?= h($error) ?></p><?php endforeach; ?>
<?php if (isset($_GET['saved'])): ?><p class="alert alert--success" role="status">Verified daily Panchangam saved.</p><?php endif; ?>
<form method="get" class="card"><label class="field">Load date <input type="date" name="date" value="<?= h($date) ?>" required></label><button class="btn btn-outline">Load</button></form>
<form method="post" class="card stack">
<?= csrfField() ?>
<label class="field">Date <input type="date" name="calendar_date" value="<?= h($date) ?>" required></label>
<?php foreach (['tithi_ta'=>'Tithi (Tamil)', 'tithi_en'=>'Tithi (English)', 'nakshatram_ta'=>'Nakshatram (Tamil)', 'nakshatram_en'=>'Nakshatram (English)', 'source'=>'Source, edition and page / URL'] as $key=>$label): ?>
<label class="field"><?= h($label) ?><input name="<?= h($key) ?>" maxlength="<?= $key === 'source' ? 500 : 100 ?>" value="<?= h($record[$key] ?? '') ?>" required></label>
<?php endforeach; ?>
<?php foreach (PANCHANGAM_TIMINGS as $key=>$label): ?>
<label class="field"><?= h($label) ?> (24-hour IST)<input name="<?= h($key) ?>" value="<?= h($record[$key] ?? '') ?>" placeholder="07:30-09:00, 16:30-18:00" required></label>
<?php endforeach; ?>
<button class="btn btn-primary" <?= !$ready ? 'disabled' : '' ?>>Save verified Panchangam</button>
</form>
<?php adminFooter(); ?>
