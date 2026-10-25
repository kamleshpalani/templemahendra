<?php
// backend/admin/poojas.php — Poojas: Pournami, Amavasai, Ekadasi, Sashti and special poojas
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_guard.php';
require_once __DIR__ . '/../includes/panchangam.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

// Migration 024: typed times, sponsorship price and availability, banner,
// featured and live-stream flags, more pooja types, "Generate from Panchangam".
$pV2 = publicGuardHasColumn('poojas', 'start_time');

// ── Vocabulary ───────────────────────────────────────────────────────────────
$typeLabels = [ // Tamil + English — used in the form select
    'pournami'   => 'பௌர்ணமி (Pournami)',
    'amavasai'   => 'அமாவாசை (Amavasai)',
    'ekadasi'    => 'ஏகாதசி (Ekadasi)',
    'sashti'     => 'சஷ்டி (Sashti)',
    'pradosham'  => 'பிரதோஷம் (Pradosham)',
    'chaturthi'  => 'சங்கடஹர சதுர்த்தி (Sankatahara Chaturthi)',
    'abhishekam' => 'அபிஷேகம் (Abhishekam)',
    'archana'    => 'அர்ச்சனை (Archana)',
    'festival'   => 'திருவிழா (Festival)',
    'special'    => 'Special',
    'monthly'    => 'Monthly',
    'daily'      => 'Daily',
];
$typeEnglish = ['pournami' => 'Pournami', 'amavasai' => 'Amavasai', 'ekadasi' => 'Ekadasi', 'sashti' => 'Sashti',
                'pradosham' => 'Pradosham', 'chaturthi' => 'Sankatahara Chaturthi', 'abhishekam' => 'Abhishekam', 'archana' => 'Archana', 'festival' => 'Festival',
                'special' => 'Special', 'monthly' => 'Monthly', 'daily' => 'Daily'];
$typeTones   = ['pournami' => 'moon', 'amavasai' => '', 'ekadasi' => 'sage', 'sashti' => 'sage',
                'pradosham' => 'warning', 'chaturthi' => 'info', 'abhishekam' => 'gold', 'archana' => 'gold', 'festival' => 'danger',
                'special' => 'gold', 'monthly' => 'info', 'daily' => 'info'];
if (!$pV2) {
    foreach (['pradosham', 'chaturthi', 'abhishekam', 'archana', 'festival'] as $t) unset($typeLabels[$t], $typeEnglish[$t], $typeTones[$t]);
}
$types       = array_keys($typeLabels);
$imageOk     = static fn(string $u): bool => $u === '' || preg_match('#^(/(uploads|images|icons)/[A-Za-z0-9._/-]+|https://[^\s"<>]+)$#', $u) === 1;
$clockOk     = static fn(string $t): bool => $t === '' || preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $t) === 1;

// ── Filters (GET, whitelisted) ───────────────────────────────────────────────
$get  = fn(string $k): string => is_string($_GET[$k] ?? null) ? $_GET[$k] : '';
$post = fn(string $k): string => is_string($_POST[$k] ?? null) ? $_POST[$k] : '';

$sortCols = ['pooja_date' => 'p.pooja_date', 'name_en' => 'p.name_en', 'pooja_type' => 'p.pooja_type'];
$type     = in_array($get('type'), $types, true) ? $get('type') : '';
$when     = in_array($get('when'), ['upcoming', 'past', 'all'], true) ? $get('when') : 'upcoming';
$q        = mb_substr(trim($get('q')), 0, 100);
$sort     = isset($sortCols[$get('sort')]) ? $get('sort') : 'pooja_date';
$dir      = in_array($get('dir'), ['asc', 'desc'], true) ? $get('dir') : ($when === 'upcoming' ? 'asc' : 'desc');
$page     = max(1, (int) $get('page'));
$perPage  = 25;
$query    = ['type' => $type, 'when' => $when === 'upcoming' ? null : $when, 'q' => $q, 'sort' => $sort, 'dir' => $dir, 'page' => $page > 1 ? $page : null];
$listUrl  = '/admin/poojas.php' . adminQuery($query);

// ── Flash after redirect ─────────────────────────────────────────────────────
$msg    = '';
$errors = [];
$old    = null;
if (!empty($_SESSION['flash'])) {
    $msg = (string) $_SESSION['flash'];
    unset($_SESSION['flash']);
}
$alert    = fn(string $tone, string $text): string => '<p class="alert alert--' . $tone . '">' . h($text) . '</p>';
$redirect = function (string $flash) use ($listUrl): void {
    $_SESSION['flash'] = $flash;
    header('Location: ' . $listUrl);
    exit;
};

// ── Actions ──────────────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $msg = adminCsrfGuard();
    if ($msg === '') {
        $action = $post('action');

        if ($action === 'save') {
            $name_ta   = sanitizeText($post('name_ta'), 200);   // poojas.name_ta is VARCHAR(200)
            $name_en   = sanitizeText($post('name_en'), 200);   // poojas.name_en is VARCHAR(200)
            $desc_ta   = sanitizeText($post('description_ta'), 2000);
            $desc_en   = sanitizeText($post('description_en'), 2000);
            $date      = sanitizeText($post('pooja_date'));
            $time      = sanitizeText($post('pooja_time'), 20);
            $ptype     = in_array($post('pooja_type'), $types, true) ? $post('pooja_type') : 'special';
            $is_active = isset($_POST['is_active']) ? 1 : 0;
            $id        = (int) ($_POST['id'] ?? 0);
            // Migration 024 fields (ignored, and never written, on an older database)
            $start     = $pV2 ? trim($post('start_time')) : '';
            $end       = $pV2 ? trim($post('end_time')) : '';
            $amountRaw = $pV2 ? trim($post('sponsorship_amount')) : '';
            $available = $pV2 ? (isset($_POST['sponsorship_available']) ? 1 : 0) : 1;
            $banner    = $pV2 ? mb_substr(trim($post('banner_url')), 0, 500) : '';
            $featured  = $pV2 ? (isset($_POST['is_featured']) ? 1 : 0) : 0;
            $liveOn    = $pV2 ? (isset($_POST['live_stream_enabled']) ? 1 : 0) : 0;
            $amount    = null;

            if ($name_ta === '') $errors['name_ta'] = 'Tamil name is required.';
            if ($name_en === '') $errors['name_en'] = 'English name is required.';
            if ($date === '') {
                $errors['pooja_date'] = 'Pooja date is required.';
            } elseif (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $date, $m) || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
                $errors['pooja_date'] = 'Enter a valid date.';
            }
            if (!$clockOk($start)) $errors['start_time'] = 'Enter the start time as HH:MM.';
            if (!$clockOk($end))   $errors['end_time']   = 'Enter the end time as HH:MM.';
            if ($start !== '' && $end !== '' && empty($errors['start_time']) && empty($errors['end_time']) && $end <= $start) {
                $errors['end_time'] = 'The end time must be after the start time.';
            }
            if ($amountRaw !== '') {
                if (!is_numeric($amountRaw) || (float) $amountRaw < 0 || (float) $amountRaw > 99999999) $errors['sponsorship_amount'] = 'Enter the sponsorship amount in rupees, 0 or more.';
                else $amount = round((float) $amountRaw, 2);
            }
            if (!$imageOk($banner)) $errors['banner_url'] = 'Use a site path such as /uploads/banner.webp or an https:// address.';
            // A typed range gives the display time when none was typed by hand.
            if ($time === '' && $start !== '') $time = panchTimeLabel($start, $end !== '' ? $end : null, '');

            if ($errors) {
                $missing = $name_ta === '' || $name_en === '' || $date === '';
                $msg = $alert('error', $missing ? 'Tamil name, English name, and date are required.' : implode(' ', $errors));
                $old = ['id' => $id, 'name_ta' => $name_ta, 'name_en' => $name_en, 'description_ta' => $desc_ta, 'description_en' => $desc_en,
                        'pooja_date' => $date, 'pooja_time' => $time, 'pooja_type' => $ptype, 'is_active' => $is_active,
                        'start_time' => $start, 'end_time' => $end, 'sponsorship_amount' => $amountRaw, 'sponsorship_available' => $available,
                        'banner_url' => $banner, 'is_featured' => $featured, 'live_stream_enabled' => $liveOn];
            } else {
                $params = [':ta' => $name_ta, ':en' => $name_en, ':dta' => $desc_ta, ':den' => $desc_en,
                           ':dt' => $date, ':tm' => $time !== '' ? $time : null, ':typ' => $ptype, ':a' => $is_active];
                $setV2 = $colsV2 = $valsV2 = '';
                if ($pV2) {
                    $params += [':st' => $start !== '' ? $start : null, ':et' => $end !== '' ? $end : null, ':amt' => $amount,
                                ':av' => $available, ':bn' => $banner !== '' ? $banner : null, ':ft' => $featured, ':lv' => $liveOn];
                    $setV2  = ',start_time=:st,end_time=:et,sponsorship_amount=:amt,sponsorship_available=:av,banner_url=:bn,is_featured=:ft,live_stream_enabled=:lv';
                    $colsV2 = ',start_time,end_time,sponsorship_amount,sponsorship_available,banner_url,is_featured,live_stream_enabled';
                    $valsV2 = ',:st,:et,:amt,:av,:bn,:ft,:lv';
                }
                if ($id > 0) {
                    $db->prepare('UPDATE poojas SET name_ta=:ta,name_en=:en,description_ta=:dta,description_en=:den,
                                  pooja_date=:dt,pooja_time=:tm,pooja_type=:typ,is_active=:a' . $setV2 . ' WHERE id=:id')
                       ->execute($params + [':id' => $id]);
                    adminAudit('pooja_updated', 'pooja:' . $id, $name_en . ' · ' . $date);
                    $redirect($alert('success', 'Pooja updated.'));
                } else {
                    $db->prepare('INSERT INTO poojas (name_ta,name_en,description_ta,description_en,
                                  pooja_date,pooja_time,pooja_type,is_active' . $colsV2 . ') VALUES (:ta,:en,:dta,:den,:dt,:tm,:typ,:a' . $valsV2 . ')')
                       ->execute($params);
                    adminAudit('pooja_created', 'pooja:' . (int) $db->lastInsertId(), $name_en . ' · ' . $date);
                    $redirect($alert('success', 'Pooja created.'));
                }
            }
        } elseif ($action === 'generate' && $pV2) {
            // "Generate from Panchangam": one pooja per date the observance falls on
            // (brief §9 recurring activities), skipping dates that already have one
            // of that type, so it can be run again next season without duplicates.
            $obs     = in_array($post('observance'), array_keys(PANCH_OBSERVANCES), true) ? $post('observance') : '';
            $months  = max(1, min(12, (int) $post('months')));
            $gTa     = sanitizeText($post('g_name_ta'), 200);
            $gEn     = sanitizeText($post('g_name_en'), 200);
            $gDescTa = sanitizeText($post('g_description_ta'), 2000);
            $gDescEn = sanitizeText($post('g_description_en'), 2000);
            $gStart  = trim($post('g_start_time'));
            $gEnd    = trim($post('g_end_time'));
            $gAmtRaw = trim($post('g_amount'));
            if ($obs === '') {
                $msg = $alert('error', 'Choose which observance to generate poojas for.');
            } elseif (!$clockOk($gStart) || !$clockOk($gEnd) || ($gStart !== '' && $gEnd !== '' && $gEnd <= $gStart)) {
                $msg = $alert('error', 'Enter the times as HH:MM, with the end after the start.');
            } elseif ($gAmtRaw !== '' && (!is_numeric($gAmtRaw) || (float) $gAmtRaw < 0)) {
                $msg = $alert('error', 'Enter the sponsorship amount in rupees, 0 or more.');
            } else {
                $gTa = $gTa !== '' ? $gTa : PANCH_OBSERVANCES[$obs]['ta'] . ' பூஜை';
                $gEn = $gEn !== '' ? $gEn : PANCH_OBSERVANCES[$obs]['en'] . ' Pooja';
                $todayIst = (new DateTime('now', new DateTimeZone('Asia/Kolkata')))->format('Y-m-d');
                $dates  = panchObservanceDates($obs, $todayIst, $months);
                $exists = $db->prepare('SELECT 1 FROM poojas WHERE pooja_type = :t AND pooja_date = :d LIMIT 1');
                $ins    = $db->prepare('INSERT INTO poojas (name_ta,name_en,description_ta,description_en,pooja_date,pooja_time,start_time,end_time,
                                        pooja_type,recurrence_type,sponsorship_amount,is_active)
                                        VALUES (:ta,:en,:dta,:den,:dt,:tm,:st,:et,:typ,:rec,:amt,1)');
                $added = 0; $skipped = 0;
                foreach ($dates as $d) {
                    $exists->execute([':t' => $obs, ':d' => $d]);
                    if ($exists->fetchColumn()) { $skipped++; continue; }
                    $ins->execute([':ta' => $gTa, ':en' => $gEn, ':dta' => $gDescTa !== '' ? $gDescTa : null, ':den' => $gDescEn !== '' ? $gDescEn : null,
                                   ':dt' => $d, ':tm' => panchTimeLabel($gStart !== '' ? $gStart : null, $gEnd !== '' ? $gEnd : null, '') ?: null,
                                   ':st' => $gStart !== '' ? $gStart : null, ':et' => $gEnd !== '' ? $gEnd : null,
                                   ':typ' => $obs, ':rec' => $obs, ':amt' => $gAmtRaw !== '' ? round((float) $gAmtRaw, 2) : null]);
                    $added++;
                }
                adminAudit('pooja_generated', 'pooja_type:' . $obs, $added . ' added, ' . $skipped . ' already existed, ' . $months . ' month(s): ' . $gEn);
                $redirect($alert('success', 'Generated ' . $added . ' ' . $gEn . ' date' . ($added === 1 ? '' : 's') . ' from the Panchangam'
                    . ($skipped ? ' (' . $skipped . ' already existed)' : '') . '.'));
            }
        } elseif ($action === 'delete') {
            $id = (int) ($_POST['id'] ?? 0);
            if ($id > 0) {
                $gone = $db->prepare('SELECT name_en FROM poojas WHERE id=:id');
                $gone->execute([':id' => $id]);
                $goneName = $gone->fetchColumn();
                $stmt = $db->prepare('DELETE FROM poojas WHERE id=:id');
                $stmt->execute([':id' => $id]);
                $deleted = $stmt->rowCount() > 0;
                if ($deleted) adminAudit('pooja_deleted', 'pooja:' . $id, $goneName !== false ? (string) $goneName : null);
                $redirect($deleted
                    ? $alert('success', 'Pooja deleted.')
                    : $alert('warning', 'That pooja no longer exists.'));
            }
        } elseif ($action === 'toggle') {
            $id = (int) ($_POST['id'] ?? 0);
            if ($id > 0) {
                $db->prepare('UPDATE poojas SET is_active = 1 - is_active WHERE id=:id')->execute([':id' => $id]);
                $stmt = $db->prepare('SELECT is_active FROM poojas WHERE id=:id');
                $stmt->execute([':id' => $id]);
                $state = $stmt->fetchColumn();
                if ($state !== false) {
                    adminAudit('pooja_toggled', 'pooja:' . $id, (int) $state ? 'shown' : 'hidden');
                    $redirect($alert('success', (int) $state ? 'Pooja is now visible on the website.' : 'Pooja hidden from the website.'));
                } else {
                    $redirect($alert('warning', 'That pooja no longer exists.'));
                }
            }
        }
    }
}

// ── Editing ──────────────────────────────────────────────────────────────────
$editing = null;
if (isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM poojas WHERE id=:id');
    $stmt->execute([':id' => (int) $_GET['edit']]);
    $editing = $stmt->fetch() ?: null;
    if (!$editing) $msg .= $alert('warning', 'That pooja no longer exists.');
}
$form = $old ?? $editing ?? ['id' => 0, 'name_ta' => '', 'name_en' => '', 'description_ta' => '', 'description_en' => '',
                             'pooja_date' => '', 'pooja_time' => '', 'pooja_type' => 'special', 'is_active' => 1,
                             'start_time' => '', 'end_time' => '', 'sponsorship_amount' => '', 'sponsorship_available' => 1,
                             'banner_url' => '', 'is_featured' => 0, 'live_stream_enabled' => 0];
$isEditing = (int) ($form['id'] ?? 0) > 0;

// ── Data ─────────────────────────────────────────────────────────────────────
$dbToday = (string) $db->query('SELECT CURDATE()')->fetchColumn();

$kpi  = $db->query("SELECT COUNT(*) AS total,
                           COALESCE(SUM(pooja_date >= CURDATE() AND is_active = 1), 0) AS upcoming,
                           COALESCE(SUM(pooja_date >= CURDATE() AND pooja_date < DATE_ADD(CURDATE(), INTERVAL 30 DAY) AND is_active = 1), 0) AS next30,
                           COALESCE(SUM(is_active = 0), 0) AS hidden
                      FROM poojas")->fetch();
$next = $db->query("SELECT name_en, pooja_date FROM poojas WHERE is_active = 1 AND pooja_date >= CURDATE() ORDER BY pooja_date ASC, id ASC LIMIT 1")->fetch();
$linkedSponsors = (int) $db->query("SELECT COUNT(*) FROM sponsors WHERE pooja_id IS NOT NULL")->fetchColumn();

$whenSql = $when === 'upcoming' ? 'p.pooja_date >= CURDATE()' : ($when === 'past' ? 'p.pooja_date < CURDATE()' : '');

// Type chip counts — same predicates as the table (minus the type itself) so a chip
// never advertises rows that clicking it will not produce.
$typeCounts = [];
$cntWhere   = [];
$cntParams  = [];
if ($whenSql)   $cntWhere[] = $whenSql;
if ($q !== '') { $cntWhere[] = '(p.name_ta LIKE ? OR p.name_en LIKE ?)'; $cntParams[] = "%$q%"; $cntParams[] = "%$q%"; }
$cnt = $db->prepare('SELECT p.pooja_type, COUNT(*) AS c FROM poojas p'
     . ($cntWhere ? ' WHERE ' . implode(' AND ', $cntWhere) : '') . ' GROUP BY p.pooja_type');
$cnt->execute($cntParams);
foreach ($cnt->fetchAll() as $r) {
    $typeCounts[$r['pooja_type']] = (int) $r['c'];
}
$allCount = array_sum($typeCounts);

$where  = [];
$params = [];
if ($whenSql)      $where[] = $whenSql;
if ($type !== '') { $where[] = 'p.pooja_type = ?'; $params[] = $type; }
if ($q !== '')    { $where[] = '(p.name_ta LIKE ? OR p.name_en LIKE ?)'; $params[] = "%$q%"; $params[] = "%$q%"; }
$sql  = 'SELECT p.*, (SELECT COUNT(*) FROM sponsors s WHERE s.pooja_id = p.id) AS sponsor_count FROM poojas p'
      . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
      . ' ORDER BY ' . $sortCols[$sort] . ' ' . strtoupper($dir) . ', p.id DESC';
$list = adminPaginate($db, $sql, $params, $page, $perPage);
$hasFilters = $type !== '' || $q !== '' || $when !== 'all';

/** "Today" / "In 9 days" / "3 days ago" relative to the database's current date. */
$relDay = function (string $iso) use ($dbToday): string {
    try {
        $diff = (int) (new DateTimeImmutable($dbToday))->diff(new DateTimeImmutable($iso))->format('%r%a');
    } catch (Throwable) {
        return '';
    }
    if ($diff === 0)  return 'Today';
    if ($diff === 1)  return 'Tomorrow';
    if ($diff === -1) return 'Yesterday';
    return $diff > 0 ? "In $diff days" : abs($diff) . ' days ago';
};
$fieldAttrs = fn(string $k): string => isset($errors[$k]) ? ' aria-invalid="true" aria-describedby="p-' . $k . '-err"' : '';
$fieldError = fn(string $k): string => isset($errors[$k]) ? '<span class="field__error" id="p-' . $k . '-err">' . adminIcon('alert-circle') . h($errors[$k]) . '</span>' : '';

// ── Page ─────────────────────────────────────────────────────────────────────
adminHeader('Poojas', 'Temple', [
    'actions' => '<a href="/admin/sponsors.php" class="btn btn-ghost btn--sm">' . adminIcon('heart-hands') . 'Sponsors</a>',
]);
echo $msg;
echo adminPageIntro(
    'Schedule the Pournami, Amavasai, Pradosham, Sankatahara Chaturthi, Ekadasi, Sashti and special poojas shown on the public website' . ($pV2 ? ', or generate a season of them from the Panchangam' : '') . '; hidden poojas stay here but are not published.',
    '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="pooja-panel" aria-expanded="false">' . adminIcon('plus') . ' New pooja</button>' .
    '<a href="/admin/bulk_upload.php?entity=poojas" class="btn btn--sm">' . adminIcon('upload') . ' Import CSV</a>'
);
echo adminKpi([
    ['label' => 'Upcoming',       'value' => (int) $kpi['upcoming'], 'icon' => 'flame',    'variant' => 'accent', 'sub' => $next ? 'Next: ' . adminFmtDate($next['pooja_date']) . ' · ' . $next['name_en'] : 'Nothing scheduled'],
    ['label' => 'Next 30 days',   'value' => (int) $kpi['next30'],   'icon' => 'calendar', 'href' => '/admin/poojas.php'],
    ['label' => 'Hidden',         'value' => (int) $kpi['hidden'],   'icon' => 'eye-off',  'href' => '/admin/poojas.php?when=all', 'sub' => 'Not shown on the website'],
    ['label' => 'All poojas',     'value' => (int) $kpi['total'],    'icon' => 'layers',   'href' => '/admin/poojas.php?when=all', 'sub' => $linkedSponsors . ' sponsor' . ($linkedSponsors === 1 ? '' : 's') . ' linked'],
]);
?>

<div class="admin-two-col admin-two-col--collapsible" id="pooja-panel"<?= $isEditing ? ' data-editing="1"' : '' ?>>

  <section class="admin-form-box card card--static" id="new" aria-labelledby="pooja-form-title">
    <h2 id="pooja-form-title"><?= adminIcon($isEditing ? 'pencil' : 'plus', 'ico--sm') ?> <?= $isEditing ? 'Edit pooja' : 'Add pooja' ?></h2>
    <form method="POST" action="<?= h($listUrl) ?>">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save" />
      <?php if ($isEditing): ?><input type="hidden" name="id" value="<?= (int) $form['id'] ?>" /><?php endif; ?>

      <label for="p-name_ta">
        <span class="field__label">Tamil name <span class="field__required" aria-hidden="true">*</span></span>
        <input id="p-name_ta" name="name_ta" lang="ta" required aria-required="true" maxlength="200"
               value="<?= h($form['name_ta']) ?>" placeholder="பௌர்ணமி பூஜை"<?= $fieldAttrs('name_ta') ?> />
        <?= $fieldError('name_ta') ?>
      </label>

      <label for="p-name_en">
        <span class="field__label">English name <span class="field__required" aria-hidden="true">*</span></span>
        <input id="p-name_en" name="name_en" required aria-required="true" maxlength="200"
               value="<?= h($form['name_en']) ?>" placeholder="Pournami Pooja"<?= $fieldAttrs('name_en') ?> />
        <?= $fieldError('name_en') ?>
      </label>

      <div class="form-grid">
        <label for="p-pooja_date">
          <span class="field__label">Date <span class="field__required" aria-hidden="true">*</span></span>
          <input id="p-pooja_date" type="date" name="pooja_date" required aria-required="true"
                 value="<?= h($form['pooja_date']) ?>"<?= $fieldAttrs('pooja_date') ?> />
          <?= $fieldError('pooja_date') ?>
        </label>
        <label for="p-pooja_time">
          Time
          <input id="p-pooja_time" name="pooja_time" maxlength="20" value="<?= h($form['pooja_time']) ?>" placeholder="07:00 AM" autocomplete="off" />
          <span class="field__hint">Shown as typed, e.g. 07:00 AM<?= $pV2 ? ' — or leave it empty and set the times below' : '' ?></span>
        </label>
      </div>

      <?php if ($pV2): ?>
      <div class="form-grid">
        <label for="p-start_time">
          Start time
          <input id="p-start_time" type="time" name="start_time" value="<?= h(substr((string) ($form['start_time'] ?? ''), 0, 5)) ?>"<?= $fieldAttrs('start_time') ?> />
          <?= $fieldError('start_time') ?>
        </label>
        <label for="p-end_time">
          End time
          <input id="p-end_time" type="time" name="end_time" value="<?= h(substr((string) ($form['end_time'] ?? ''), 0, 5)) ?>"<?= $fieldAttrs('end_time') ?> />
          <?= $fieldError('end_time') ?>
        </label>
      </div>
      <div class="form-grid">
        <label for="p-amount">
          Sponsorship amount (₹)
          <input id="p-amount" type="number" name="sponsorship_amount" min="0" step="1" inputmode="numeric"
                 value="<?= h($form['sponsorship_amount'] !== null && $form['sponsorship_amount'] !== '' ? (string) (0 + $form['sponsorship_amount']) : '') ?>"<?= $fieldAttrs('sponsorship_amount') ?> />
          <?= $fieldError('sponsorship_amount') ?>
          <span class="field__hint">Shown on the website as the price to sponsor this pooja. Leave empty when it is not sponsorable.</span>
        </label>
        <label for="p-banner">
          Banner image
          <input id="p-banner" name="banner_url" maxlength="500" value="<?= h((string) ($form['banner_url'] ?? '')) ?>" placeholder="/uploads/pooja-banner.webp"<?= $fieldAttrs('banner_url') ?> />
          <?= $fieldError('banner_url') ?>
          <span class="field__hint">A photo already in the Gallery (its /uploads/… address) or an https:// picture.</span>
        </label>
      </div>
      <label class="switch">
        <input type="checkbox" name="sponsorship_available" value="1"<?= !empty($form['sponsorship_available']) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label">Open for sponsorship<span class="switch__desc">Turn off once the pooja is fully sponsored; the website then says so.</span></span>
      </label>
      <label class="switch">
        <input type="checkbox" name="is_featured" value="1"<?= !empty($form['is_featured']) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label">Featured<span class="switch__desc">Highlighted on the Pooja page.</span></span>
      </label>
      <label class="switch">
        <input type="checkbox" name="live_stream_enabled" value="1"<?= !empty($form['live_stream_enabled']) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label">Will be streamed live<span class="switch__desc">Shows a "Live" mark; schedule the broadcast itself under Live Streaming.</span></span>
      </label>
      <?php endif; ?>

      <label for="p-pooja_type">
        <span class="field__label">Type <span class="field__required" aria-hidden="true">*</span></span>
        <select id="p-pooja_type" name="pooja_type" required aria-required="true">
          <?php foreach ($typeLabels as $val => $lbl): ?>
            <option value="<?= h($val) ?>"<?= ($form['pooja_type'] ?? 'special') === $val ? ' selected' : '' ?>><?= h($lbl) ?></option>
          <?php endforeach; ?>
        </select>
      </label>

      <label for="p-description_ta">
        Description (Tamil)
        <textarea id="p-description_ta" name="description_ta" lang="ta" rows="3" maxlength="2000" data-counter><?= h($form['description_ta'] ?? '') ?></textarea>
      </label>

      <label for="p-description_en">
        Description (English)
        <textarea id="p-description_en" name="description_en" rows="3" maxlength="2000" data-counter><?= h($form['description_en'] ?? '') ?></textarea>
      </label>

      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= !empty($form['is_active']) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label">Visible on the website<span class="switch__desc">Hidden poojas stay in the admin but are not published.</span></span>
      </label>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> <?= $isEditing ? 'Save changes' : 'Save pooja' ?></button>
        <?php if ($isEditing): ?>
          <a href="<?= h($listUrl) ?>" class="btn btn-ghost">Cancel</a>
        <?php endif; ?>
      </div>
    </form>

    <?php if ($pV2): ?>
    <details class="mt-4" id="generate">
      <summary><?= adminIcon('calendar', 'ico--sm') ?> Generate from Panchangam</summary>
      <form method="POST" action="<?= h($listUrl) ?>" class="mt-4" aria-label="Generate recurring poojas">
        <?= csrfField() ?>
        <input type="hidden" name="action" value="generate" />
        <div class="form-grid">
          <label for="g-obs">
            <span class="field__label">Observance <span class="field__required" aria-hidden="true">*</span></span>
            <select id="g-obs" name="observance" required aria-required="true">
              <?php foreach (PANCH_OBSERVANCES as $key => $o): ?>
                <option value="<?= h($key) ?>"><?= h($o['ta'] . ' (' . $o['en'] . ')') ?></option>
              <?php endforeach; ?>
            </select>
          </label>
          <label for="g-months">
            Months ahead
            <input id="g-months" type="number" name="months" min="1" max="12" value="6" inputmode="numeric" />
          </label>
        </div>
        <div class="form-grid">
          <label for="g-name_ta">
            Tamil name
            <input id="g-name_ta" name="g_name_ta" lang="ta" maxlength="200" placeholder="பௌர்ணமி பூஜை" />
          </label>
          <label for="g-name_en">
            English name
            <input id="g-name_en" name="g_name_en" maxlength="200" placeholder="Pournami Pooja" />
          </label>
        </div>
        <div class="form-grid">
          <label for="g-start">Start time <input id="g-start" type="time" name="g_start_time" /></label>
          <label for="g-end">End time <input id="g-end" type="time" name="g_end_time" /></label>
          <label for="g-amount">Sponsorship amount (₹) <input id="g-amount" type="number" name="g_amount" min="0" step="1" inputmode="numeric" /></label>
        </div>
        <span class="field__hint">Adds one pooja on every date the observance falls on, from today for the months chosen, skipping dates that already have a pooja of that type. Each row is marked with the observance as its recurrence type, so this can be run again next season.</span>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary"><?= adminIcon('calendar') ?> Generate</button>
        </div>
      </form>
    </details>
    <?php endif; ?>
  </section>

  <div class="admin-list">
    <form method="GET" action="/admin/poojas.php" class="toolbar" role="search">
      <?php if ($type !== ''): ?><input type="hidden" name="type" value="<?= h($type) ?>" /><?php endif; ?>
      <?php if ($when !== 'upcoming'): ?><input type="hidden" name="when" value="<?= h($when) ?>" /><?php endif; ?>
      <input type="hidden" name="sort" value="<?= h($sort) ?>" />
      <input type="hidden" name="dir" value="<?= h($dir) ?>" />
      <div class="toolbar__search">
        <?= adminIcon('search') ?>
        <label class="sr-only" for="pooja-q">Search poojas by name</label>
        <input id="pooja-q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search by name…" autocomplete="off" />
      </div>
      <div class="toolbar__group">
        <button type="submit" class="btn btn--sm">Search</button>
        <?php if ($q !== ''): ?><a href="<?= h('/admin/poojas.php' . adminQuery($query, ['q' => null, 'page' => null])) ?>" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Clear</a><?php endif; ?>
      </div>
      <nav class="tabs" aria-label="Show poojas by date">
        <?php foreach (['upcoming' => 'Upcoming', 'past' => 'Past', 'all' => 'All dates'] as $w => $lbl): ?>
          <a class="tab" href="<?= h('/admin/poojas.php' . adminQuery($query, ['when' => $w === 'upcoming' ? null : $w, 'sort' => null, 'dir' => null, 'page' => null])) ?>"<?= $when === $w ? ' aria-current="page"' : '' ?>><?= $lbl ?></a>
        <?php endforeach; ?>
      </nav>
      <span class="toolbar__count"><?= $list['total'] ?> record<?= $list['total'] === 1 ? '' : 's' ?></span>
    </form>

    <div class="filter-chips mb-4" role="group" aria-label="Filter by pooja type">
      <a class="chip" href="<?= h('/admin/poojas.php' . adminQuery($query, ['type' => null, 'page' => null])) ?>"<?= $type === '' ? ' aria-current="page"' : '' ?>>All <span class="chip__count"><?= $allCount ?></span></a>
      <?php foreach ($typeEnglish as $val => $lbl): ?>
        <a class="chip" href="<?= h('/admin/poojas.php' . adminQuery($query, ['type' => $val, 'page' => null])) ?>"<?= $type === $val ? ' aria-current="page"' : '' ?>><?= h($lbl) ?> <span class="chip__count"><?= $typeCounts[$val] ?? 0 ?></span></a>
      <?php endforeach; ?>
    </div>

    <?php if ($list['rows']): ?>
      <div class="table-wrap">
        <table class="table" data-no-search>
          <thead>
            <tr>
              <?= adminSortLink('pooja_date', 'Date', $query) ?>
              <?= adminSortLink('name_en', 'Pooja', $query) ?>
              <?= adminSortLink('pooja_type', 'Type', $query) ?>
              <th scope="col" class="num">Sponsors</th>
              <th scope="col">Status</th>
              <th scope="col" class="cell-actions"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <?php foreach ($list['rows'] as $row): $rid = (int) $row['id']; $when_txt = $relDay($row['pooja_date']); ?>
              <tr>
                <td>
                  <time class="cell-title" datetime="<?= h($row['pooja_date']) ?>"><?= adminFmtDate($row['pooja_date']) ?></time>
                  <?php $timeLabel = panchTimeLabel($row['start_time'] ?? null, $row['end_time'] ?? null, $row['pooja_time']); ?>
                  <span class="cell-sub"><?= $timeLabel !== '' ? h($timeLabel) . ' · ' : '' ?><?= h($when_txt) ?></span>
                </td>
                <td>
                  <span class="cell-title" lang="ta"><?= h($row['name_ta']) ?></span>
                  <span class="cell-sub"><?= h($row['name_en']) ?></span>
                </td>
                <td>
                  <?= adminBadge($typeEnglish[$row['pooja_type']] ?? $row['pooja_type'], $typeTones[$row['pooja_type']] ?? '') ?>
                  <?php if (!empty($row['is_featured'])) echo ' ' . adminBadge('Featured', 'gold'); ?>
                  <?php if (!empty($row['live_stream_enabled'])) echo ' ' . adminBadge('Live', 'info'); ?>
                  <?php if (isset($row['sponsorship_available']) && (int) $row['sponsorship_available'] === 0) echo ' ' . adminBadge('Sponsored', 'muted'); ?>
                </td>
                <td class="num">
                  <?php if ((int) $row['sponsor_count'] > 0): ?>
                    <a href="/admin/sponsors.php?pooja=<?= $rid ?>" data-tip="View sponsors"><?= (int) $row['sponsor_count'] ?></a>
                  <?php else: ?>
                    <span class="text-muted">—</span>
                  <?php endif; ?>
                  <?php if (!empty($row['sponsorship_amount'])): ?><span class="cell-sub">₹<?= number_format((float) $row['sponsorship_amount']) ?></span><?php endif; ?>
                </td>
                <td><?= $row['is_active'] ? adminBadge('Active', 'success') : adminBadge('Hidden', 'muted') ?></td>
                <td class="cell-actions">
                  <?= adminMenu([
                      ['label' => 'Edit', 'icon' => 'pencil', 'href' => '/admin/poojas.php' . adminQuery($query, ['edit' => $rid]) . '#new'],
                      ['label' => $row['is_active'] ? 'Hide from website' : 'Show on website', 'icon' => $row['is_active'] ? 'eye-off' : 'eye', 'form' => ['action' => 'toggle', 'id' => $rid], 'action' => $listUrl],
                      ['label' => 'Sponsors', 'icon' => 'heart-hands', 'href' => '/admin/sponsors.php?pooja=' . $rid],
                      'divider',
                      ['label' => 'Delete', 'icon' => 'trash', 'danger' => true, 'form' => ['action' => 'delete', 'id' => $rid], 'action' => $listUrl,
                       'confirm' => 'Delete "' . $row['name_en'] . '" on ' . adminFmtDate($row['pooja_date']) . '? Linked sponsors are kept but unlinked.'],
                  ], 'Actions for ' . $row['name_en']) ?>
                </td>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      </div>
      <?= adminPagination($list['page'], $list['pages'], $query, $list['total'], $perPage) ?>
    <?php elseif ($hasFilters): ?>
      <?= adminEmpty('filter', $when === 'upcoming' && $type === '' && $q === '' ? 'No upcoming poojas' : 'No poojas match these filters',
          'Try another type, clear the search, or show all dates.',
          '<a href="/admin/poojas.php?when=all" class="btn btn--sm">' . adminIcon('layers') . ' Show all poojas</a>' .
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' Add pooja</a>') ?>
    <?php else: ?>
      <?= adminEmpty('flame', 'No poojas scheduled yet', 'Add the first Pournami or Amavasai pooja with the form, or import a CSV of dates.',
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' Add pooja</a>' .
          '<a href="/admin/bulk_upload.php?entity=poojas" class="btn btn--sm">' . adminIcon('upload') . ' Import CSV</a>') ?>
    <?php endif; ?>
  </div>

</div>
<?php adminFooter(); ?>
