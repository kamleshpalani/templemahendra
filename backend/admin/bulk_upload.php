<?php
/**
 * backend/admin/bulk_upload.php — CSV bulk import
 *
 * Flow: Choose entity → Upload → Validate → Preview (row-level errors,
 * duplicates) → Confirm import (transaction) → Results summary.
 * Validated rows are held in the session between preview and confirm.
 * Excel users: "Save As → CSV UTF-8". A blank template is downloadable
 * per entity; invalid rows can be downloaded as an error CSV.
 */
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_layout.php';

const BULK_MAX_ROWS = 2000;
const BULK_MAX_MB   = 5;

/** Entity definitions: columns, validation rules, duplicate key, insert SQL. */
function bulkEntities(): array
{
    $isDate = fn(string $v) => (bool) preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) && strtotime($v) !== false;
    $isBool = fn(string $v) => in_array(strtolower($v), ['', '0', '1', 'yes', 'no', 'true', 'false'], true);
    $toBool = fn(string $v) => in_array(strtolower($v), ['1', 'yes', 'true'], true) ? 1 : (($v === '') ? 1 : 0);
    $isNum  = fn(string $v) => $v === '' || is_numeric($v);

    return [
        'sevas' => [
            'icon' => '🙏', 'label' => 'Sevas', 'table' => 'sevas',
            'columns' => ['name_ta', 'name_en', 'description', 'amount', 'sort_order', 'is_featured', 'is_active'],
            'required' => ['name_ta', 'name_en', 'amount'],
            'rules' => ['amount' => [$isNum, 'must be a number'], 'sort_order' => [$isNum, 'must be a number'],
                        'is_featured' => [$isBool, 'must be yes/no'], 'is_active' => [$isBool, 'must be yes/no']],
            'dupKey' => ['name_en'],
            'dupSql' => 'SELECT name_en FROM sevas',
            'map' => fn(array $r) => [
                ':a' => $r['name_ta'], ':b' => $r['name_en'], ':c' => $r['description'] ?: null,
                ':d' => (float) $r['amount'], ':e' => (int) ($r['sort_order'] ?: 0),
                ':f' => in_array(strtolower($r['is_featured']), ['1', 'yes', 'true'], true) ? 1 : 0, ':g' => $toBool($r['is_active']),
            ],
            'insert' => 'INSERT INTO sevas (name_ta,name_en,description,amount,sort_order,is_featured,is_active) VALUES (:a,:b,:c,:d,:e,:f,:g)',
            'sample' => ['அபிஷேகம்', 'Abhishekam', 'Sacred bathing of the deity', '251', '1', 'yes', 'yes'],
        ],
        'events' => [
            'icon' => '📅', 'label' => 'Events', 'table' => 'events',
            'columns' => ['title_ta', 'title_en', 'event_date', 'description', 'is_active'],
            'required' => ['title_ta', 'title_en', 'event_date'],
            'rules' => ['event_date' => [$isDate, 'must be YYYY-MM-DD'], 'is_active' => [$isBool, 'must be yes/no']],
            'dupKey' => ['title_en', 'event_date'],
            'dupSql' => 'SELECT title_en, event_date FROM events',
            'map' => fn(array $r) => [
                ':a' => $r['title_ta'], ':b' => $r['title_en'], ':c' => $r['description'] ?: null,
                ':d' => $r['event_date'], ':e' => $toBool($r['is_active']),
            ],
            'insert' => 'INSERT INTO events (title_ta,title_en,description,event_date,is_active) VALUES (:a,:b,:c,:d,:e)',
            'sample' => ['தைப்பூசம்', 'Thai Poosam', 'Grand kavadi festival', '2027-01-24', 'yes'],
        ],
        'poojas' => [
            'icon' => '🛕', 'label' => 'Poojas', 'table' => 'poojas',
            'columns' => ['name_ta', 'name_en', 'pooja_date', 'pooja_time', 'pooja_type', 'description_ta', 'description_en', 'is_active'],
            'required' => ['name_ta', 'name_en', 'pooja_date'],
            'rules' => [
                'pooja_date' => [$isDate, 'must be YYYY-MM-DD'],
                'pooja_type' => [fn($v) => $v === '' || in_array($v, ['pournami', 'amavasai', 'ekadasi', 'sashti', 'special', 'monthly', 'daily'], true),
                                 'must be one of pournami, amavasai, ekadasi, sashti, special, monthly, daily'],
                'is_active'  => [$isBool, 'must be yes/no'],
            ],
            'dupKey' => ['name_en', 'pooja_date'],
            'dupSql' => 'SELECT name_en, pooja_date FROM poojas',
            'map' => fn(array $r) => [
                ':a' => $r['name_ta'], ':b' => $r['name_en'], ':c' => $r['description_ta'] ?: null, ':d' => $r['description_en'] ?: null,
                ':e' => $r['pooja_date'], ':f' => $r['pooja_time'] ?: null, ':g' => $r['pooja_type'] ?: 'special', ':h' => $toBool($r['is_active']),
            ],
            'insert' => 'INSERT INTO poojas (name_ta,name_en,description_ta,description_en,pooja_date,pooja_time,pooja_type,is_active) VALUES (:a,:b,:c,:d,:e,:f,:g,:h)',
            'sample' => ['பௌர்ணமி பூஜை', 'Pournami Pooja', '2027-01-03', '07:00 AM', 'pournami', '', '', 'yes'],
        ],
        'sponsors' => [
            'icon' => '💛', 'label' => 'Sponsors', 'table' => 'sponsors',
            'columns' => ['name', 'phone', 'note', 'is_active'],
            'required' => ['name'],
            'rules' => ['phone' => [fn($v) => $v === '' || preg_match('/^[0-9+\-\s]{7,30}$/', $v), 'must be a phone number'],
                        'is_active' => [$isBool, 'must be yes/no']],
            'dupKey' => ['name', 'phone'],
            'dupSql' => 'SELECT name, phone FROM sponsors',
            'map' => fn(array $r) => [':a' => $r['name'], ':b' => $r['phone'] ?: null, ':c' => $r['note'] ?: null, ':d' => $toBool($r['is_active'])],
            'insert' => 'INSERT INTO sponsors (name,phone,note,is_active) VALUES (:a,:b,:c,:d)',
            'sample' => ['Murugan & Family', '9876543210', 'Annadanam sponsor', 'yes'],
        ],
        'donations' => [
            'icon' => '💰', 'label' => 'Donations', 'table' => 'donations',
            'columns' => ['name', 'phone', 'amount', 'purpose', 'message', 'created_at'],
            'required' => ['name', 'phone', 'amount'],
            'rules' => [
                'phone'  => [fn($v) => (bool) preg_match('/^[0-9]{7,15}$/', $v), 'must be 7–15 digits'],
                'amount' => [fn($v) => is_numeric($v) && (float) $v > 0, 'must be a positive number'],
                'created_at' => [fn($v) => $v === '' || strtotime($v) !== false, 'must be a valid date/time'],
            ],
            'dupKey' => ['phone', 'amount', 'created_at'],
            'dupSql' => 'SELECT phone, amount, created_at FROM donations',
            'map' => fn(array $r) => [
                ':a' => $r['name'], ':b' => $r['phone'], ':c' => (float) $r['amount'], ':d' => $r['purpose'] ?: null,
                ':e' => $r['message'] ?: null, ':f' => $r['created_at'] !== '' ? date('Y-m-d H:i:s', strtotime($r['created_at'])) : date('Y-m-d H:i:s'),
            ],
            'insert' => 'INSERT INTO donations (name,phone,amount,purpose,message,created_at) VALUES (:a,:b,:c,:d,:e,:f)',
            'sample' => ['Lakshmi', '9876543210', '1001', 'annadanam', 'Receipt to Chennai address', '2026-08-15 10:30:00'],
        ],
    ];
}

$entities = bulkEntities();
$entity   = $_GET['entity'] ?? $_POST['entity'] ?? '';
if (!isset($entities[$entity])) {
    $entity = '';
}
$def   = $entity ? $entities[$entity] : null;
$db    = getDB();
$msg   = '';
$step  = $entity ? 2 : 1;      // 1 choose · 2 upload · 3 preview · 4 results
$state = $_SESSION['bulk'] ?? null;
$result = null;

// ── Template download ──────────────────────────────────────────────────────
if ($def && isset($_GET['template'])) {
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $entity . '-template.csv"');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF");
    fputcsv($out, $def['columns']);
    fputcsv($out, $def['sample']);
    fclose($out);
    exit;
}

// ── Error report download ──────────────────────────────────────────────────
if (isset($_GET['errors']) && $state && $state['entity'] === $entity) {
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $entity . '-errors.csv"');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF");
    fputcsv($out, array_merge(['row', 'status', 'problems'], $def['columns']));
    foreach ($state['rows'] as $r) {
        if ($r['status'] === 'ok') continue;
        fputcsv($out, array_merge([$r['line'], $r['status'], implode('; ', $r['errors'])], array_values($r['data'])));
    }
    fclose($out);
    exit;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function bulkNormalizeHeader(string $h): string
{
    $h = preg_replace('/^\xEF\xBB\xBF/', '', $h); // strip BOM
    return strtolower(trim(preg_replace('/[^a-z0-9_]+/i', '_', trim($h)), '_'));
}

function bulkDupSignature(array $data, array $keys): string
{
    // Numbers normalised so "1001" (CSV) matches "1001.00" (DECIMAL column)
    return implode('|', array_map(function ($k) use ($data) {
        $v = trim((string) ($data[$k] ?? ''));
        return is_numeric($v) ? number_format((float) $v, 2, '.', '') : mb_strtolower($v);
    }, $keys));
}

// ── POST actions ───────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $def) {
    $action = $_POST['action'] ?? '';

    if (!csrfValid()) {
        $msg = '<p class="alert alert--error">Your session expired. Please retry the upload.</p>';
    }

    // Step 2 → 3: upload + validate
    elseif ($action === 'upload') {
        $file = $_FILES['csv'] ?? null;
        if (!$file || $file['error'] !== UPLOAD_ERR_OK) {
            $msg = '<p class="alert alert--error">Please choose a CSV file to upload.</p>';
        } elseif ($file['size'] > BULK_MAX_MB * 1024 * 1024) {
            $msg = '<p class="alert alert--error">File is larger than ' . BULK_MAX_MB . ' MB.</p>';
        } elseif (!preg_match('/\.(csv|txt)$/i', $file['name'])) {
            $msg = '<p class="alert alert--error">Only .csv files are supported. In Excel use <em>File → Save As → CSV UTF-8</em>.</p>';
        } else {
            $fh = fopen($file['tmp_name'], 'r');
            $header = fgetcsv($fh);
            if (!$header) {
                $msg = '<p class="alert alert--error">The file appears to be empty.</p>';
            } else {
                $header  = array_map('bulkNormalizeHeader', $header);
                $missing = array_diff($def['required'], $header);
                $unknown = array_diff($header, $def['columns']);
                if ($missing) {
                    $msg = '<p class="alert alert--error">Missing required column(s): <strong>' . htmlspecialchars(implode(', ', $missing)) . '</strong>. Download the template to see the expected format.</p>';
                } else {
                    // Existing rows for duplicate detection
                    $existing = [];
                    foreach ($db->query($def['dupSql'])->fetchAll(PDO::FETCH_ASSOC) as $ex) {
                        $existing[bulkDupSignature($ex, $def['dupKey'])] = true;
                    }
                    $seen  = [];
                    $rows  = [];
                    $line  = 1;
                    $count = 0;
                    while (($raw = fgetcsv($fh)) !== false) {
                        $line++;
                        if (count(array_filter($raw, fn($c) => trim((string) $c) !== '')) === 0) continue; // blank line
                        if (++$count > BULK_MAX_ROWS) {
                            $msg = '<p class="alert alert--warning">Only the first ' . BULK_MAX_ROWS . ' rows were processed.</p>';
                            break;
                        }
                        $data = array_fill_keys($def['columns'], '');
                        foreach ($header as $i => $col) {
                            if (isset($data[$col])) $data[$col] = sanitizeText((string) ($raw[$i] ?? ''), 2000);
                        }
                        $errors = [];
                        foreach ($def['required'] as $col) {
                            if ($data[$col] === '') $errors[] = "$col is required";
                        }
                        foreach ($def['rules'] as $col => [$fn, $message]) {
                            if ($data[$col] !== '' || in_array($col, $def['required'], true)) {
                                if (!$fn($data[$col])) $errors[] = "$col $message";
                            }
                        }
                        $status = $errors ? 'invalid' : 'ok';
                        if (!$errors) {
                            $sig = bulkDupSignature($data, $def['dupKey']);
                            if (isset($existing[$sig])) {
                                $status = 'duplicate';
                                $errors[] = 'Already exists in database';
                            } elseif (isset($seen[$sig])) {
                                $status = 'duplicate';
                                $errors[] = 'Duplicate of row ' . $seen[$sig];
                            } else {
                                $seen[$sig] = $line;
                            }
                        }
                        $rows[] = ['line' => $line, 'data' => $data, 'errors' => $errors, 'status' => $status];
                    }
                    fclose($fh);
                    if (!$rows) {
                        $msg = '<p class="alert alert--error">No data rows found under the header.</p>';
                    } else {
                        $_SESSION['bulk'] = $state = [
                            'entity' => $entity, 'file' => basename($file['name']),
                            'unknown' => array_values($unknown), 'rows' => $rows, 'at' => time(),
                        ];
                        $step = 3;
                    }
                }
            }
        }
    }

    // Step 3 → 4: confirm import
    elseif ($action === 'confirm' && $state && $state['entity'] === $entity) {
        $skipDup = isset($_POST['skip_duplicates']);
        $stmt = $db->prepare($def['insert']);
        $ok = $fail = $skipped = $dup = 0;
        $db->beginTransaction();
        try {
            foreach ($state['rows'] as $r) {
                if ($r['status'] === 'invalid') { $skipped++; continue; }
                if ($r['status'] === 'duplicate') {
                    if ($skipDup) { $dup++; continue; }
                }
                try {
                    $stmt->execute(($def['map'])($r['data']));
                    $ok++;
                } catch (Throwable $e) {
                    $fail++;
                }
            }
            $db->commit();
        } catch (Throwable $e) {
            $db->rollBack();
            $msg = '<p class="alert alert--error">Import failed and was rolled back: ' . htmlspecialchars($e->getMessage()) . '</p>';
        }
        $result = ['ok' => $ok, 'fail' => $fail, 'skipped' => $skipped, 'dup' => $dup, 'total' => count($state['rows']), 'file' => $state['file']];
        unset($_SESSION['bulk']);
        $state = null;
        $step  = 4;
    }

    elseif ($action === 'cancel') {
        unset($_SESSION['bulk']);
        $state = null;
        $step  = 2;
    }
}

// Resume a preview if one is pending for this entity
if ($step === 2 && $state && $state['entity'] === $entity && (time() - $state['at']) < 1800) {
    $step = 3;
}

$counts = $state ? array_count_values(array_column($state['rows'], 'status')) + ['ok' => 0, 'invalid' => 0, 'duplicate' => 0] : null;

adminHeader('Bulk Upload', 'Data & System');
echo $msg;
?>

<nav class="stepper" aria-label="Import progress">
  <?php foreach ([1 => 'Choose data', 2 => 'Upload CSV', 3 => 'Validate & preview', 4 => 'Import results'] as $n => $label): ?>
    <span class="step <?= $n < $step ? 'step--done' : ($n === $step ? 'step--active' : '') ?>" <?= $n === $step ? 'aria-current="step"' : '' ?>>
      <span class="step__num"><?= $n < $step ? '✓' : $n ?></span><?= $label ?>
    </span>
  <?php endforeach; ?>
</nav>

<?php if ($step === 1): ?>
<section class="card">
  <div class="card__head"><h3>What would you like to import?</h3></div>
  <div class="card__body">
    <p class="muted mb-4">Choose a data type. You'll get a CSV template, then upload your file for validation before anything is saved.</p>
    <div class="template-grid">
      <?php foreach ($entities as $key => $e): ?>
        <a class="entity-card" href="?entity=<?= $key ?>">
          <span class="entity-card__icon" aria-hidden="true"><?= $e['icon'] ?></span>
          <strong><?= htmlspecialchars($e['label']) ?></strong>
          <small><?= count($e['columns']) ?> columns · <?= count($e['required']) ?> required</small>
        </a>
      <?php endforeach; ?>
    </div>
  </div>
</section>

<?php elseif ($step === 2): ?>
<div class="admin-two-col" style="grid-template-columns: minmax(0,1.2fr) minmax(0,1fr)">
  <section class="card">
    <div class="card__head">
      <h3><?= $def['icon'] ?> Upload <?= htmlspecialchars($def['label']) ?> CSV</h3>
      <a href="/admin/bulk_upload.php" class="btn btn-ghost btn-sm">Change type</a>
    </div>
    <div class="card__body">
      <form method="POST" enctype="multipart/form-data">
        <?= csrfField() ?>
        <input type="hidden" name="entity" value="<?= htmlspecialchars($entity) ?>" />
        <input type="hidden" name="action" value="upload" />
        <div class="dropzone" tabindex="0">
          <span class="dropzone__icon" aria-hidden="true">📤</span>
          <span class="dropzone__title">Drag & drop your CSV here, or click to browse</span>
          <span class="field__hint">.csv (UTF-8) · up to <?= BULK_MAX_MB ?> MB · max <?= number_format(BULK_MAX_ROWS) ?> rows</span>
          <span class="dropzone__file" aria-live="polite"></span>
          <input type="file" name="csv" accept=".csv,text/csv" required aria-label="Choose CSV file" />
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Validate file →</button>
          <a href="?entity=<?= $entity ?>&template=1" class="btn btn-secondary">⬇ Download template</a>
        </div>
      </form>
    </div>
  </section>

  <section class="card">
    <div class="card__head"><h3>Expected columns</h3></div>
    <div class="card__body">
      <code class="cols"><?= htmlspecialchars(implode(', ', $def['columns'])) ?></code>
      <ul class="muted mt-4" style="padding-left:1.1rem;display:flex;flex-direction:column;gap:.35rem">
        <li>Required: <strong><?= htmlspecialchars(implode(', ', $def['required'])) ?></strong></li>
        <li>Column order doesn't matter; header names must match (case-insensitive).</li>
        <li>Dates as <code>YYYY-MM-DD</code>; yes/no columns accept yes, no, 1, 0.</li>
        <li>Duplicates are detected on: <strong><?= htmlspecialchars(implode(' + ', $def['dupKey'])) ?></strong>.</li>
        <li>Nothing is saved until you confirm on the preview screen.</li>
      </ul>
    </div>
  </section>
</div>

<?php elseif ($step === 3 && $state): ?>
<section class="card">
  <div class="card__head">
    <h3>Preview: <?= htmlspecialchars($state['file']) ?></h3>
    <span class="badge badge--info"><?= count($state['rows']) ?> rows</span>
  </div>
  <div class="card__body">
    <div class="import-summary">
      <div class="import-summary__item import-summary__item--ok"><div class="import-summary__val"><?= $counts['ok'] ?></div><div class="import-summary__label">Ready</div></div>
      <div class="import-summary__item import-summary__item--warn"><div class="import-summary__val"><?= $counts['duplicate'] ?></div><div class="import-summary__label">Duplicates</div></div>
      <div class="import-summary__item import-summary__item--bad"><div class="import-summary__val"><?= $counts['invalid'] ?></div><div class="import-summary__label">Invalid</div></div>
    </div>
    <?php if ($state['unknown']): ?>
      <p class="alert alert--warning"><span aria-hidden="true">⚠️</span><span>Ignored unknown column(s): <strong><?= htmlspecialchars(implode(', ', $state['unknown'])) ?></strong></span></p>
    <?php endif; ?>
    <?php if ($counts['invalid'] > 0): ?>
      <p class="alert alert--error"><span aria-hidden="true">⚠️</span><span><?= $counts['invalid'] ?> row(s) have problems and will be <strong>skipped</strong>. <a href="?entity=<?= $entity ?>&errors=1">Download the error report</a>, fix the rows and re-upload.</span></p>
    <?php endif; ?>

    <form method="POST" class="mb-4">
      <?= csrfField() ?>
      <input type="hidden" name="entity" value="<?= htmlspecialchars($entity) ?>" />
      <input type="hidden" name="action" value="confirm" />
      <?php if ($counts['duplicate'] > 0): ?>
        <label class="checkbox-label"><input type="checkbox" name="skip_duplicates" checked /> Skip duplicate rows (recommended)</label>
      <?php endif; ?>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary" <?= $counts['ok'] === 0 && $counts['duplicate'] === 0 ? 'disabled' : '' ?>>
          Import <?= $counts['ok'] ?> row(s) →
        </button>
        <button type="submit" class="btn btn-ghost" name="action" value="cancel" formnovalidate>Cancel</button>
        <a href="?entity=<?= $entity ?>&errors=1" class="btn btn-secondary btn-sm">⬇ Error report</a>
      </div>
    </form>
  </div>

  <div class="table-wrap">
    <table class="admin-table" data-no-search>
      <thead>
        <tr><th>Row</th><th>Status</th><?php foreach ($def['columns'] as $c): ?><th><?= htmlspecialchars($c) ?></th><?php endforeach; ?><th>Problems</th></tr>
      </thead>
      <tbody>
        <?php foreach (array_slice($state['rows'], 0, 300) as $r): ?>
        <tr class="<?= $r['status'] === 'invalid' ? 'row--invalid' : ($r['status'] === 'duplicate' ? 'row--duplicate' : '') ?>">
          <td><?= $r['line'] ?></td>
          <td><span class="badge badge--<?= ['ok' => 'success', 'duplicate' => 'warning', 'invalid' => 'danger'][$r['status']] ?>"><?= ucfirst($r['status']) ?></span></td>
          <?php foreach ($def['columns'] as $c): ?>
            <td><?= htmlspecialchars(mb_strimwidth((string) $r['data'][$c], 0, 40, '…')) ?></td>
          <?php endforeach; ?>
          <td><?php if ($r['errors']): ?><div class="row-errors"><?php foreach ($r['errors'] as $e): ?><span>• <?= htmlspecialchars($e) ?></span><?php endforeach; ?></div><?php else: ?>—<?php endif; ?></td>
        </tr>
        <?php endforeach; ?>
      </tbody>
    </table>
  </div>
  <?php if (count($state['rows']) > 300): ?>
    <p class="muted" style="padding:.75rem 1.25rem">Showing the first 300 rows. All <?= count($state['rows']) ?> rows will be processed.</p>
  <?php endif; ?>
</section>

<?php elseif ($step === 4 && $result): ?>
<section class="card">
  <div class="card__head"><h3>Import complete — <?= htmlspecialchars($result['file']) ?></h3></div>
  <div class="card__body">
    <div class="progress mb-4" role="progressbar" aria-valuenow="100" aria-valuemin="0" aria-valuemax="100"><div class="progress__bar" style="width:100%"></div></div>
    <div class="import-summary">
      <div class="import-summary__item import-summary__item--ok"><div class="import-summary__val"><?= $result['ok'] ?></div><div class="import-summary__label">Imported</div></div>
      <div class="import-summary__item import-summary__item--warn"><div class="import-summary__val"><?= $result['dup'] ?></div><div class="import-summary__label">Duplicates skipped</div></div>
      <div class="import-summary__item import-summary__item--bad"><div class="import-summary__val"><?= $result['skipped'] ?></div><div class="import-summary__label">Invalid skipped</div></div>
      <div class="import-summary__item import-summary__item--bad"><div class="import-summary__val"><?= $result['fail'] ?></div><div class="import-summary__label">Failed</div></div>
      <div class="import-summary__item"><div class="import-summary__val"><?= $result['total'] ?></div><div class="import-summary__label">Total rows</div></div>
    </div>
    <?php if ($result['ok'] > 0): ?>
      <p class="alert alert--success"><span aria-hidden="true">🙏</span><span><?= $result['ok'] ?> <?= htmlspecialchars($def['label']) ?> record(s) were added successfully.</span></p>
    <?php else: ?>
      <p class="alert alert--warning"><span aria-hidden="true">⚠️</span><span>No rows were imported.</span></p>
    <?php endif; ?>
    <div class="form-actions">
      <a href="/admin/<?= htmlspecialchars($def['table']) ?>.php" class="btn btn-primary">View <?= htmlspecialchars($def['label']) ?> →</a>
      <a href="?entity=<?= $entity ?>" class="btn btn-secondary">Import another file</a>
      <a href="/admin/bulk_upload.php" class="btn btn-ghost">Choose different data</a>
    </div>
  </div>
</section>
<?php endif; ?>

<?php adminFooter(); ?>
