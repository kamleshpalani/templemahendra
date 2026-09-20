<?php
// backend/admin/sponsors.php — Sponsors: devotees sponsoring poojas
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db = getDB();

// Migration 016 adds the family name, email, event link, amount, payment and
// publish-consent columns. Without them the page still works with the original
// four fields, and nothing is published until the migration is applied.
$hasConsent = (function () use ($db): bool {
    try {
        $stmt = $db->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?');
        $stmt->execute(['sponsors', 'publish_consent']);
        return (int) $stmt->fetchColumn() > 0;
    } catch (Throwable) {
        return false;
    }
})();

$typeTones      = ['pournami' => 'moon', 'amavasai' => '', 'ekadasi' => 'sage', 'sashti' => 'sage', 'special' => 'gold', 'monthly' => 'info', 'daily' => 'info'];
$paymentStates  = ['PENDING' => 'Pending', 'PAID' => 'Paid', 'FAILED' => 'Failed', 'REFUNDED' => 'Refunded', 'WAIVED' => 'Waived'];
$paymentTones   = ['PENDING' => 'warning', 'PAID' => 'success', 'FAILED' => 'danger', 'REFUNDED' => 'info', 'WAIVED' => 'muted'];
$fmtAmount      = fn($amount): string => '₹' . number_format((float) $amount, ((float) $amount) == floor((float) $amount) ? 0 : 2);

// ── Filters (GET, whitelisted) ───────────────────────────────────────────────
$get  = fn(string $k): string => is_string($_GET[$k] ?? null) ? $_GET[$k] : '';
$post = fn(string $k): string => is_string($_POST[$k] ?? null) ? $_POST[$k] : '';

$sortCols = ['created_at' => 's.created_at', 'name' => 's.name', 'pooja_date' => 'p.pooja_date'];
if ($hasConsent) $sortCols['amount'] = 's.amount';
$q        = mb_substr(trim($get('q')), 0, 100);
$statuses = $hasConsent ? ['active', 'hidden', 'published', 'unpaid'] : ['active', 'hidden'];
$status   = in_array($get('status'), $statuses, true) ? $get('status') : '';
$poojaId  = max(0, (int) $get('pooja'));
$sort     = isset($sortCols[$get('sort')]) ? $get('sort') : 'created_at';
$dir      = in_array($get('dir'), ['asc', 'desc'], true) ? $get('dir') : ($sort === 'created_at' ? 'desc' : 'asc');
$page     = max(1, (int) $get('page'));
$perPage  = 25;

// Pooja filter (link from the Poojas page) — ignored when the pooja no longer exists
$filterPooja = null;
if ($poojaId > 0) {
    $stmt = $db->prepare('SELECT id, name_en, name_ta, pooja_date, pooja_type FROM poojas WHERE id = :id');
    $stmt->execute([':id' => $poojaId]);
    $filterPooja = $stmt->fetch() ?: null;
    if (!$filterPooja) $poojaId = 0;
}

$query   = ['q' => $q, 'status' => $status, 'pooja' => $poojaId > 0 ? $poojaId : null, 'sort' => $sort, 'dir' => $dir, 'page' => $page > 1 ? $page : null];
$listUrl = '/admin/sponsors.php' . adminQuery($query);

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
            $name      = sanitizeText($post('name'), 200);      // sponsors.name is VARCHAR(200)
            $phone     = sanitizeText($post('phone'), 30);
            $note      = sanitizeText($post('note'), 1000);
            $pooja_id  = ((int) ($_POST['pooja_id'] ?? 0)) ?: null;
            $is_active = isset($_POST['is_active']) ? 1 : 0;
            $id        = (int) ($_POST['id'] ?? 0);

            // Migration 016 fields
            $family_name     = sanitizeText($post('family_name'), 200);
            $email           = mb_substr(trim($post('email')), 0, 190);
            $event_id        = ((int) ($_POST['event_id'] ?? 0)) ?: null;
            $amountRaw       = trim(str_replace([',', '₹'], '', $post('amount')));
            $amount          = null;
            $payment_ref     = sanitizeText($post('payment_ref'), 100);
            $payment_status  = isset($paymentStates[$post('payment_status')]) ? $post('payment_status') : 'PENDING';
            $publish_consent = isset($_POST['publish_consent']) ? 1 : 0;

            if ($name === '') $errors['name'] = 'Sponsor name is required.';
            if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) $errors['email'] = 'That email address does not look right.';
            if ($amountRaw !== '') {
                if (!is_numeric($amountRaw) || (float) $amountRaw < 0 || (float) $amountRaw > 99999999) {
                    $errors['amount'] = 'Amount must be a number of rupees, 0 or more.';
                } else {
                    $amount = number_format((float) $amountRaw, 2, '.', '');
                }
            }
            // The pooja / event may have been deleted after the select was rendered — check
            // before the write so the foreign keys cannot raise an uncaught PDOException.
            if ($pooja_id !== null) {
                $chk = $db->prepare('SELECT 1 FROM poojas WHERE id = :id');
                $chk->execute([':id' => $pooja_id]);
                if (!$chk->fetchColumn()) $errors['pooja_id'] = 'That pooja no longer exists — pick another or choose "None".';
            }
            if ($event_id !== null) {
                $chk = $db->prepare('SELECT 1 FROM events WHERE id = :id');
                $chk->execute([':id' => $event_id]);
                if (!$chk->fetchColumn()) $errors['event_id'] = 'That event no longer exists — pick another or choose "None".';
            }

            if ($errors) {
                $msg = $alert('error', reset($errors));
                $old = ['id' => $id, 'name' => $name, 'family_name' => $family_name, 'phone' => $phone, 'email' => $email, 'note' => $note,
                        'pooja_id' => $pooja_id, 'event_id' => $event_id, 'amount' => $amountRaw, 'payment_ref' => $payment_ref,
                        'payment_status' => $payment_status, 'publish_consent' => $publish_consent, 'is_active' => $is_active];
            } else {
                $params = [':n' => $name, ':ph' => $phone !== '' ? $phone : null, ':nt' => $note !== '' ? $note : null, ':pid' => $pooja_id, ':a' => $is_active];
                $cols   = 'name=:n,phone=:ph,note=:nt,pooja_id=:pid,is_active=:a';
                if ($hasConsent) {
                    $cols  .= ',family_name=:fn,email=:em,event_id=:eid,amount=:amt,payment_ref=:ref,payment_status=:ps,publish_consent=:pc';
                    $params += [':fn' => $family_name !== '' ? $family_name : null, ':em' => $email !== '' ? $email : null, ':eid' => $event_id,
                                ':amt' => $amount, ':ref' => $payment_ref !== '' ? $payment_ref : null, ':ps' => $payment_status, ':pc' => $publish_consent];
                }
                $detail = $name . ($amount !== null ? ' · ' . $fmtAmount($amount) . ' ' . $payment_status : '')
                        . ($hasConsent ? ($publish_consent ? ' · consent' : ' · no consent') : '');
                if ($id > 0) {
                    $stmt = $db->prepare('UPDATE sponsors SET ' . $cols . ' WHERE id=:id');
                    $stmt->execute($params + [':id' => $id]);
                    if ($stmt->rowCount() === 0) {
                        $chk = $db->prepare('SELECT 1 FROM sponsors WHERE id = :id');
                        $chk->execute([':id' => $id]);
                        if (!$chk->fetchColumn()) $redirect($alert('warning', 'That sponsor no longer exists.'));
                    }
                    adminAudit('sponsor_updated', 'sponsor:' . $id, $detail);
                    $redirect($alert('success', 'Sponsor updated.'));
                } else {
                    $db->prepare('INSERT INTO sponsors SET ' . $cols)->execute($params);
                    adminAudit('sponsor_created', 'sponsor:' . (int) $db->lastInsertId(), $detail);
                    $redirect($alert('success', 'Sponsor added.'));
                }
            }
        } elseif ($action === 'delete') {
            $id = (int) ($_POST['id'] ?? 0);
            if ($id > 0) {
                $stmt = $db->prepare('SELECT name FROM sponsors WHERE id=:id');
                $stmt->execute([':id' => $id]);
                $victim = $stmt->fetchColumn();
                $stmt = $db->prepare('DELETE FROM sponsors WHERE id=:id');
                $stmt->execute([':id' => $id]);
                if ($stmt->rowCount()) adminAudit('sponsor_deleted', 'sponsor:' . $id, (string) $victim);
                $redirect($stmt->rowCount()
                    ? $alert('success', 'Sponsor deleted.')
                    : $alert('warning', 'That sponsor no longer exists.'));
            }
        } elseif ($action === 'toggle') {
            $id = (int) ($_POST['id'] ?? 0);
            if ($id > 0) {
                $db->prepare('UPDATE sponsors SET is_active = 1 - is_active WHERE id=:id')->execute([':id' => $id]);
                $stmt = $db->prepare('SELECT is_active FROM sponsors WHERE id=:id');
                $stmt->execute([':id' => $id]);
                $state = $stmt->fetchColumn();
                if ($state !== false) {
                    adminAudit('sponsor_toggled', 'sponsor:' . $id, (int) $state ? 'active' : 'hidden');
                    $redirect($alert('success', (int) $state ? 'Sponsor is now active.' : 'Sponsor hidden.'));
                } else {
                    $redirect($alert('warning', 'That sponsor no longer exists.'));
                }
            }
        } elseif ($action === 'consent' && $hasConsent) {
            $id = (int) ($_POST['id'] ?? 0);
            if ($id > 0) {
                $db->prepare('UPDATE sponsors SET publish_consent = 1 - publish_consent WHERE id=:id')->execute([':id' => $id]);
                $stmt = $db->prepare('SELECT publish_consent FROM sponsors WHERE id=:id');
                $stmt->execute([':id' => $id]);
                $state = $stmt->fetchColumn();
                if ($state !== false) {
                    adminAudit('sponsor_consent', 'sponsor:' . $id, (int) $state ? 'granted' : 'withdrawn');
                    $redirect($alert('success', (int) $state ? 'Sponsor may now be named on the website.' : 'Sponsor will no longer be named on the website.'));
                } else {
                    $redirect($alert('warning', 'That sponsor no longer exists.'));
                }
            }
        }
    }
}

// ── Editing ──────────────────────────────────────────────────────────────────
$editing = null;
if (isset($_GET['edit'])) {
    $stmt = $db->prepare('SELECT * FROM sponsors WHERE id=:id');
    $stmt->execute([':id' => (int) $_GET['edit']]);
    $editing = $stmt->fetch() ?: null;
    if (!$editing) $msg .= $alert('warning', 'That sponsor no longer exists.');
}
$blank = ['id' => 0, 'name' => '', 'family_name' => '', 'phone' => '', 'email' => '', 'note' => '', 'pooja_id' => $poojaId > 0 ? $poojaId : null,
          'event_id' => null, 'amount' => '', 'payment_ref' => '', 'payment_status' => 'PENDING', 'publish_consent' => 0, 'is_active' => 1];
$form = ($old ?? $editing ?? []) + $blank;
$isEditing = (int) ($form['id'] ?? 0) > 0;

// Poojas for the dropdown (active, latest first) — plus the currently linked one if it is not in that list
$poojas = $db->query(
    "SELECT id, name_ta, name_en, pooja_date FROM poojas
      WHERE is_active=1 ORDER BY pooja_date DESC LIMIT 50"
)->fetchAll();
$selectedPooja = (int) ($form['pooja_id'] ?? 0);
if ($selectedPooja > 0 && !in_array($selectedPooja, array_map(fn($p) => (int) $p['id'], $poojas), true)) {
    $stmt = $db->prepare('SELECT id, name_ta, name_en, pooja_date FROM poojas WHERE id = :id');
    $stmt->execute([':id' => $selectedPooja]);
    if ($extra = $stmt->fetch()) array_unshift($poojas, $extra);
}

// Events for the dropdown (latest first) — plus the currently linked one if it is not in that list
$events = [];
$selectedEvent = (int) ($form['event_id'] ?? 0);
if ($hasConsent) {
    $events = $db->query(
        "SELECT id, title_ta, title_en, event_date FROM events
          WHERE is_active=1 ORDER BY event_date DESC LIMIT 50"
    )->fetchAll();
    if ($selectedEvent > 0 && !in_array($selectedEvent, array_map(fn($e) => (int) $e['id'], $events), true)) {
        $stmt = $db->prepare('SELECT id, title_ta, title_en, event_date FROM events WHERE id = :id');
        $stmt->execute([':id' => $selectedEvent]);
        if ($extra = $stmt->fetch()) array_unshift($events, $extra);
    }
}

// ── Data ─────────────────────────────────────────────────────────────────────
$kpi = $db->query("SELECT COUNT(*) AS total,
                          COALESCE(SUM(is_active = 1), 0) AS active,
                          COALESCE(SUM(pooja_id IS NOT NULL), 0) AS linked,
                          COALESCE(SUM(created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')), 0) AS this_month"
                . ($hasConsent ? ",
                          COALESCE(SUM(is_active = 1 AND publish_consent = 1), 0) AS published,
                          COALESCE(SUM(CASE WHEN payment_status = 'PAID' THEN amount END), 0) AS paid_total,
                          COALESCE(SUM(CASE WHEN payment_status = 'PENDING' THEN amount END), 0) AS pending_total" : '')
                . " FROM sponsors")->fetch();

// Search: name, phone and note as before; family name, email and payment reference once migration 016 is in.
$searchSql    = '(s.name LIKE ? OR s.phone LIKE ? OR s.note LIKE ?' . ($hasConsent ? ' OR s.family_name LIKE ? OR s.email LIKE ? OR s.payment_ref LIKE ?' : '') . ')';
$searchParams = array_fill(0, $hasConsent ? 6 : 3, "%$q%");
$statusSql    = [
    'active'    => 's.is_active = 1',
    'hidden'    => 's.is_active = 0',
    'published' => 's.is_active = 1 AND s.publish_consent = 1',
    'unpaid'    => "s.payment_status = 'PENDING'",
];

$where  = [];
$params = [];
if ($q !== '')      { $where[] = $searchSql; array_push($params, ...$searchParams); }
if ($status !== '') $where[] = $statusSql[$status];
if ($poojaId > 0)   { $where[] = 's.pooja_id = ?'; $params[] = $poojaId; }
$sql = 'SELECT s.*, p.name_en AS pooja_name_en, p.name_ta AS pooja_name_ta, p.pooja_date, p.pooja_type'
     . ($hasConsent ? ', e.title_en AS event_title_en, e.title_ta AS event_title_ta, e.event_date' : '')
     . ' FROM sponsors s
          LEFT JOIN poojas p ON p.id = s.pooja_id'
     . ($hasConsent ? ' LEFT JOIN events e ON e.id = s.event_id' : '')
     . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
     . ' ORDER BY ' . $sortCols[$sort] . ' ' . strtoupper($dir) . ', s.id DESC';
$list = adminPaginate($db, $sql, $params, $page, $perPage);

// Status chip counts (respecting search + pooja filter)
$countWhere  = [];
$countParams = [];
if ($q !== '')    { $countWhere[] = $searchSql; array_push($countParams, ...$searchParams); }
if ($poojaId > 0) { $countWhere[] = 's.pooja_id = ?'; $countParams[] = $poojaId; }
$stmt = $db->prepare('SELECT ' . implode(', ', array_map(fn($k, $cond) => "COALESCE(SUM($cond), 0) AS `$k`", $statuses, array_map(fn($k) => $statusSql[$k], $statuses)))
                   . ' FROM sponsors s' . ($countWhere ? ' WHERE ' . implode(' AND ', $countWhere) : ''));
$stmt->execute($countParams);
$statusCounts = array_map('intval', $stmt->fetch());
$statusLabels = ['active' => 'Active', 'hidden' => 'Hidden', 'published' => 'On website', 'unpaid' => 'Payment pending'];
$hasFilters   = $q !== '' || $status !== '' || $poojaId > 0;

$fieldAttrs = fn(string $k): string => isset($errors[$k]) ? ' aria-invalid="true" aria-describedby="s-' . $k . '-err"' : '';
$fieldError = fn(string $k): string => isset($errors[$k]) ? '<span class="field__error" id="s-' . $k . '-err">' . adminIcon('alert-circle') . h($errors[$k]) . '</span>' : '';
/** Turn a stored phone string into a dialable tel: href (digits and a leading +). */
$telHref = fn(string $phone): string => 'tel:' . (str_starts_with(trim($phone), '+') ? '+' : '') . preg_replace('/\D/', '', $phone);

// ── Page ─────────────────────────────────────────────────────────────────────
adminHeader('Sponsors', 'Worship', [
    'actions' => '<a href="/admin/poojas.php" class="btn btn-ghost btn--sm">' . adminIcon('flame') . 'Poojas</a>',
]);
echo $msg;
echo adminPageIntro(
    'Record the devotees and families sponsoring poojas and events, with the amount and payment status. A sponsor is named on the website only when active and they have given publish consent; phone, email and payment details never leave the admin.',
    '<button type="button" class="btn btn-primary btn--sm form-drawer-toggle" aria-controls="sponsor-panel" aria-expanded="false">' . adminIcon('plus') . ' New sponsor</button>' .
    '<a href="/admin/bulk_upload.php?entity=sponsors" class="btn btn--sm">' . adminIcon('upload') . ' Import CSV</a>'
);
echo adminKpi([
    ['label' => 'Sponsors',       'value' => (int) $kpi['total'],      'icon' => 'heart-hands', 'variant' => 'accent', 'sub' => (int) $kpi['active'] . ' active'],
    ['label' => 'Active',         'value' => (int) $kpi['active'],     'icon' => 'check-circle', 'href' => '/admin/sponsors.php?status=active'],
    ['label' => 'Linked to a pooja', 'value' => (int) $kpi['linked'],  'icon' => 'flame',       'href' => '/admin/poojas.php', 'sub' => 'Open the Poojas page to see who sponsors what'],
    $hasConsent
        ? ['label' => 'On website', 'value' => (int) $kpi['published'], 'icon' => 'globe', 'href' => '/admin/sponsors.php?status=published', 'sub' => 'Active with publish consent']
        : ['label' => 'Added this month','value' => (int) $kpi['this_month'],'icon' => 'trending',    'href' => '/admin/sponsors.php?sort=created_at&dir=desc'],
] + ($hasConsent ? [
    4 => ['label' => 'Received', 'value' => $fmtAmount($kpi['paid_total']), 'icon' => 'banknote', 'variant' => 'success',
          'sub' => $fmtAmount($kpi['pending_total']) . ' pending', 'href' => '/admin/sponsors.php?status=unpaid'],
] : []));
?>

<div class="admin-two-col admin-two-col--collapsible" id="sponsor-panel"<?= $isEditing ? ' data-editing="1"' : '' ?>>

  <section class="admin-form-box card card--static" id="new" aria-labelledby="sponsor-form-title">
    <h2 id="sponsor-form-title"><?= adminIcon($isEditing ? 'pencil' : 'plus', 'ico--sm') ?> <?= $isEditing ? 'Edit sponsor' : 'Add sponsor' ?></h2>
    <form method="POST" action="<?= h($listUrl) ?>">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save" />
      <?php if ($isEditing): ?><input type="hidden" name="id" value="<?= (int) $form['id'] ?>" /><?php endif; ?>

      <label for="s-name">
        <span class="field__label">Sponsor name <span class="field__required" aria-hidden="true">*</span></span>
        <input id="s-name" name="name" required aria-required="true" maxlength="200" autocomplete="off"
               value="<?= h($form['name']) ?>" placeholder="Murugan Family / ஸ்ரீ முருகன் குடும்பம்"<?= $fieldAttrs('name') ?> />
        <?= $fieldError('name') ?>
      </label>

      <?php if ($hasConsent): ?>
      <label for="s-family">
        Family name for the website
        <input id="s-family" name="family_name" maxlength="200" autocomplete="off"
               value="<?= h($form['family_name'] ?? '') ?>" placeholder="Palanichamy Family / பழனிச்சாமி குடும்பம்" />
        <span class="field__hint">Optional. When given, this is the name shown publicly instead of the sponsor's own name.</span>
      </label>
      <?php endif; ?>

      <div class="form-grid">
        <label for="s-phone">
          Contact number
          <input id="s-phone" type="tel" name="phone" maxlength="30" autocomplete="off" inputmode="tel"
                 value="<?= h($form['phone'] ?? '') ?>" placeholder="+91 98765 43210" />
          <span class="field__hint">Kept private — shown only here in the admin.</span>
        </label>
        <?php if ($hasConsent): ?>
        <label for="s-email">
          Email
          <input id="s-email" type="email" name="email" maxlength="190" autocomplete="off" inputmode="email"
                 value="<?= h($form['email'] ?? '') ?>" placeholder="devotee@example.com"<?= $fieldAttrs('email') ?> />
          <?= $fieldError('email') ?>
          <span class="field__hint">Private. Used for the sponsorship confirmation.</span>
        </label>
        <?php endif; ?>
      </div>

      <label for="s-pooja">
        Linked pooja
        <select id="s-pooja" name="pooja_id"<?= $fieldAttrs('pooja_id') ?>>
          <option value="">— None —</option>
          <?php foreach ($poojas as $p): ?>
            <option value="<?= (int) $p['id'] ?>"<?= $selectedPooja === (int) $p['id'] ? ' selected' : '' ?>><?= h($p['name_ta'] . ' (' . $p['name_en'] . ') · ' . adminFmtDate($p['pooja_date'])) ?></option>
          <?php endforeach; ?>
        </select>
        <?= $fieldError('pooja_id') ?>
        <span class="field__hint">Optional. Only active poojas are listed (latest 50).</span>
      </label>

      <?php if ($hasConsent): ?>
      <label for="s-event">
        Linked event
        <select id="s-event" name="event_id"<?= $fieldAttrs('event_id') ?>>
          <option value="">— None —</option>
          <?php foreach ($events as $e): ?>
            <option value="<?= (int) $e['id'] ?>"<?= $selectedEvent === (int) $e['id'] ? ' selected' : '' ?>><?= h($e['title_ta'] . ' (' . $e['title_en'] . ') · ' . adminFmtDate($e['event_date'])) ?></option>
          <?php endforeach; ?>
        </select>
        <?= $fieldError('event_id') ?>
        <span class="field__hint">Optional, for festival or event sponsorships.</span>
      </label>

      <div class="form-grid">
        <label for="s-amount">
          Sponsorship amount (₹)
          <input id="s-amount" name="amount" type="text" inputmode="decimal" autocomplete="off" maxlength="14"
                 value="<?= h((string) ($form['amount'] ?? '')) ?>" placeholder="5000"<?= $fieldAttrs('amount') ?> />
          <?= $fieldError('amount') ?>
        </label>
        <label for="s-status">
          Payment status
          <select id="s-status" name="payment_status">
            <?php foreach ($paymentStates as $k => $label): ?>
              <option value="<?= $k ?>"<?= ($form['payment_status'] ?? 'PENDING') === $k ? ' selected' : '' ?>><?= $label ?></option>
            <?php endforeach; ?>
          </select>
        </label>
      </div>

      <label for="s-ref">
        Payment reference
        <input id="s-ref" name="payment_ref" maxlength="100" autocomplete="off"
               value="<?= h($form['payment_ref'] ?? '') ?>" placeholder="Receipt no, UPI / bank reference or CCAvenue order id" />
        <span class="field__hint">Private. Helps the finance team match the payment.</span>
      </label>

      <label class="switch">
        <input type="checkbox" name="publish_consent" value="1"<?= !empty($form['publish_consent']) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label">Publish consent<span class="switch__desc">Tick only when the sponsor has agreed to be named on the website. Without it the sponsor is never shown publicly, even when active.</span></span>
      </label>
      <?php endif; ?>

      <label for="s-note">
        Note
        <textarea id="s-note" name="note" rows="3" maxlength="1000" data-counter placeholder="Dedication, message or special request…"><?= h($form['note'] ?? '') ?></textarea>
      </label>

      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= !empty($form['is_active']) ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label">Active<span class="switch__desc">Hidden sponsors stay in the admin but are not featured on the website.</span></span>
      </label>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> <?= $isEditing ? 'Save changes' : 'Save sponsor' ?></button>
        <?php if ($isEditing): ?>
          <a href="<?= h($listUrl) ?>" class="btn btn-ghost">Cancel</a>
        <?php endif; ?>
      </div>
    </form>
  </section>

  <div class="admin-list">
    <form method="GET" action="/admin/sponsors.php" class="toolbar" role="search">
      <?php if ($status !== ''): ?><input type="hidden" name="status" value="<?= h($status) ?>" /><?php endif; ?>
      <?php if ($poojaId > 0): ?><input type="hidden" name="pooja" value="<?= $poojaId ?>" /><?php endif; ?>
      <input type="hidden" name="sort" value="<?= h($sort) ?>" />
      <input type="hidden" name="dir" value="<?= h($dir) ?>" />
      <div class="toolbar__search">
        <?= adminIcon('search') ?>
        <label class="sr-only" for="sponsor-q">Search sponsors by name, phone, email, payment reference or note</label>
        <input id="sponsor-q" type="search" name="q" value="<?= h($q) ?>" placeholder="<?= $hasConsent ? 'Search name, phone, email, reference or note…' : 'Search name, phone or note…' ?>" autocomplete="off" />
      </div>
      <div class="toolbar__group">
        <button type="submit" class="btn btn--sm">Search</button>
        <?php if ($q !== ''): ?><a href="<?= h('/admin/sponsors.php' . adminQuery($query, ['q' => null, 'page' => null])) ?>" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Clear</a><?php endif; ?>
      </div>
      <span class="toolbar__count"><?= $list['total'] ?> record<?= $list['total'] === 1 ? '' : 's' ?></span>
    </form>

    <div class="filter-chips mb-4" role="group" aria-label="Filter by status">
      <a class="chip" href="<?= h('/admin/sponsors.php' . adminQuery($query, ['status' => null, 'page' => null])) ?>"<?= $status === '' ? ' aria-current="page"' : '' ?>>All <span class="chip__count"><?= $statusCounts['active'] + $statusCounts['hidden'] ?></span></a>
      <?php foreach ($statuses as $st): ?>
      <a class="chip" href="<?= h('/admin/sponsors.php' . adminQuery($query, ['status' => $st, 'page' => null])) ?>"<?= $status === $st ? ' aria-current="page"' : '' ?>><?= $statusLabels[$st] ?> <span class="chip__count"><?= $statusCounts[$st] ?></span></a>
      <?php endforeach; ?>
      <?php if ($filterPooja): ?>
        <a class="chip" aria-current="page" href="<?= h('/admin/sponsors.php' . adminQuery($query, ['pooja' => null, 'page' => null])) ?>" aria-label="Remove pooja filter: <?= h($filterPooja['name_en']) ?>">
          <?= adminIcon('flame', 'ico--xs') ?> <?= h($filterPooja['name_en']) ?> · <?= adminFmtDate($filterPooja['pooja_date']) ?> <?= adminIcon('x', 'ico--xs') ?>
        </a>
      <?php endif; ?>
    </div>

    <?php if ($list['rows']): ?>
      <div class="table-wrap">
        <table class="table" data-no-search>
          <thead>
            <tr>
              <?= adminSortLink('name', 'Sponsor', $query) ?>
              <th scope="col">Contact</th>
              <?= adminSortLink('pooja_date', 'Linked to', $query) ?>
              <?php if ($hasConsent): ?><?= adminSortLink('amount', 'Amount', $query) ?><?php endif; ?>
              <?= adminSortLink('created_at', 'Added', $query) ?>
              <th scope="col">Status</th>
              <th scope="col" class="cell-actions"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <?php foreach ($list['rows'] as $row): $rid = (int) $row['id']; ?>
              <tr>
                <td>
                  <span class="cell-title"><?= h($row['name']) ?></span>
                  <?php if ($hasConsent && ($row['family_name'] ?? '') !== '' && $row['family_name'] !== null): ?><span class="cell-sub"><?= adminIcon('globe', 'ico--xs') ?> <?= h($row['family_name']) ?></span><?php endif; ?>
                  <?php if ($row['note'] !== null && $row['note'] !== ''): ?><span class="cell-sub cell-clip"><?= h($row['note']) ?></span><?php endif; ?>
                </td>
                <td>
                  <?php if ($row['phone'] !== null && $row['phone'] !== ''): ?>
                    <a href="<?= h($telHref($row['phone'])) ?>" class="nowrap"><?= adminIcon('phone', 'ico--xs') ?> <?= h($row['phone']) ?></a>
                  <?php endif; ?>
                  <?php if ($hasConsent && ($row['email'] ?? '') !== '' && $row['email'] !== null): ?>
                    <span class="cell-sub"><a href="mailto:<?= h($row['email']) ?>"><?= h($row['email']) ?></a></span>
                  <?php endif; ?>
                  <?php if (($row['phone'] ?? '') === '' && ($row['email'] ?? '') === ''): ?><span class="text-muted">—</span><?php endif; ?>
                </td>
                <td>
                  <?php if ($row['pooja_id']): ?>
                    <?= adminBadge($row['pooja_name_en'] ?? 'Pooja #' . (int) $row['pooja_id'], $typeTones[$row['pooja_type'] ?? ''] ?? '') ?>
                    <?php if ($row['pooja_date']): ?><span class="cell-sub"><?= adminFmtDate($row['pooja_date']) ?></span><?php endif; ?>
                  <?php endif; ?>
                  <?php if ($hasConsent && !empty($row['event_id'])): ?>
                    <?= adminBadge($row['event_title_en'] ?? 'Event #' . (int) $row['event_id'], 'info') ?>
                    <?php if (!empty($row['event_date'])): ?><span class="cell-sub"><?= adminFmtDate($row['event_date']) ?></span><?php endif; ?>
                  <?php endif; ?>
                  <?php if (!$row['pooja_id'] && empty($row['event_id'])): ?><span class="text-muted">—</span><?php endif; ?>
                </td>
                <?php if ($hasConsent): ?>
                <td>
                  <?php if ($row['amount'] !== null): ?>
                    <span class="cell-title nowrap"><?= h($fmtAmount($row['amount'])) ?></span>
                  <?php else: ?>
                    <span class="text-muted">—</span>
                  <?php endif; ?>
                  <span class="cell-sub"><?= adminBadge($paymentStates[$row['payment_status']] ?? $row['payment_status'], $paymentTones[$row['payment_status']] ?? '') ?></span>
                  <?php if (($row['payment_ref'] ?? '') !== '' && $row['payment_ref'] !== null): ?><span class="cell-sub cell-clip"><?= h($row['payment_ref']) ?></span><?php endif; ?>
                </td>
                <?php endif; ?>
                <td class="cell-date"><time datetime="<?= h($row['created_at']) ?>" data-tip="<?= h(adminFmtDate($row['created_at'], true)) ?>"><?= adminAgo($row['created_at']) ?></time></td>
                <td>
                  <?= $row['is_active'] ? adminBadge('Active', 'success') : adminBadge('Hidden', 'muted') ?>
                  <?php if ($hasConsent): ?>
                    <span class="cell-sub"><?= (int) $row['publish_consent'] ? adminBadge('Consent given', 'info') : adminBadge('No consent', 'muted') ?></span>
                  <?php endif; ?>
                </td>
                <td class="cell-actions">
                  <?= adminMenu([
                      ['label' => 'Edit', 'icon' => 'pencil', 'href' => '/admin/sponsors.php' . adminQuery($query, ['edit' => $rid]) . '#new'],
                      ['label' => $row['is_active'] ? 'Hide sponsor' : 'Activate sponsor', 'icon' => $row['is_active'] ? 'eye-off' : 'eye', 'form' => ['action' => 'toggle', 'id' => $rid], 'action' => $listUrl],
                  ] + ($hasConsent ? [
                      2 => ['label' => (int) $row['publish_consent'] ? 'Withdraw publish consent' : 'Record publish consent', 'icon' => 'globe', 'form' => ['action' => 'consent', 'id' => $rid], 'action' => $listUrl],
                  ] : []) + [
                      3 => 'divider',
                      4 => ['label' => 'Delete', 'icon' => 'trash', 'danger' => true, 'form' => ['action' => 'delete', 'id' => $rid], 'action' => $listUrl,
                       'confirm' => 'Delete sponsor "' . $row['name'] . '"? This cannot be undone.'],
                  ], 'Actions for ' . $row['name']) ?>
                </td>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      </div>
      <?= adminPagination($list['page'], $list['pages'], $query, $list['total'], $perPage) ?>
    <?php elseif ($hasFilters): ?>
      <?= adminEmpty('filter', 'No sponsors match these filters', 'Try a different search, clear the status filter, or add a new sponsor.',
          '<a href="/admin/sponsors.php" class="btn btn--sm">' . adminIcon('x') . ' Clear filters</a>' .
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' Add sponsor</a>') ?>
    <?php else: ?>
      <?= adminEmpty('heart-hands', 'No sponsors yet', 'Add the devotees and families who sponsor poojas, or import a list from CSV.',
          '<a href="#new" class="btn btn-primary btn--sm">' . adminIcon('plus') . ' Add sponsor</a>' .
          '<a href="/admin/bulk_upload.php?entity=sponsors" class="btn btn--sm">' . adminIcon('upload') . ' Import CSV</a>') ?>
    <?php endif; ?>
  </div>

</div>
<?php adminFooter(); ?>
