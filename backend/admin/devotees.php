<?php
// backend/admin/devotees.php — the people who registered an account on the
// public site: search, filter, edit their details, confirm an address by hand,
// close or reopen an account, and export. Each row links through to that
// devotee's own bookings and donations.
//
// A devotee's password is never shown or settable here. It is a bcrypt hash and
// nobody, committee included, can read it back; if someone is locked out they
// use the reset link on the public site. The committee's job is the details.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/includes/admin_layout.php';

$db      = getDB();
$perPage = 20;

/**
 * The devotee tables arrive with migration 003. Until it is applied the page
 * explains that rather than throwing, which is how every other optional
 * feature in this admin behaves.
 */
function devoteesTableExists(PDO $db): bool
{
    static $exists = null;
    if ($exists !== null) return $exists;
    try {
        $db->query('SELECT 1 FROM devotees LIMIT 1');
        return $exists = true;
    } catch (Throwable) {
        return $exists = false;
    }
}

/**
 * Columns added by later migrations; the page adapts rather than failing.
 *
 * information_schema, not SHOW COLUMNS: the latter does not accept a bound
 * parameter in its LIKE, so the prepared statement threw, the catch swallowed
 * it, and every optional column read as absent — which quietly dropped the
 * whole location column from the table.
 */
function devoteeHasColumn(PDO $db, string $column): bool
{
    static $cache = [];
    if (isset($cache[$column])) return $cache[$column];
    try {
        $stmt = $db->prepare(
            'SELECT 1 FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c'
        );
        $stmt->execute([':t' => 'devotees', ':c' => $column]);
        return $cache[$column] = (bool) $stmt->fetchColumn();
    } catch (Throwable) {
        return $cache[$column] = false;
    }
}

if (!devoteesTableExists($db)) {
    adminHeader('Devotee Accounts', 'Devotees');
    echo adminEmpty(
        'users',
        'Devotee accounts are not switched on yet',
        'Apply database/migrations/003_devotee_accounts.sql (and 004, 005) to let devotees register on the public site. Until then the site hides every account entry point and nothing else changes.',
        '<a href="/register" target="_blank" rel="noopener" class="btn btn--sm">' . adminIcon('external') . 'Public sign-up page</a>'
    );
    adminFooter();
    exit;
}

$hasLocation = devoteeHasColumn($db, 'country');
$hasAddress  = devoteeHasColumn($db, 'address1');
$hasState    = devoteeHasColumn($db, 'state');
$hasPhoneIso = devoteeHasColumn($db, 'phone_country');

/**
 * Tags arrive with migration 007 (devotee_tags). They are how the committee
 * forms the groups the site has no module for — volunteers, members, people
 * interested in annadanam — so a notification audience can reach them. Without
 * the table the page simply shows no tags.
 */
$hasTags = (static function (PDO $db): bool {
    try {
        $db->query('SELECT 1 FROM devotee_tags LIMIT 1');
        return true;
    } catch (Throwable) {
        return false;
    }
})($db);

/** Lowercase so "Volunteer" and "volunteer" are one group; ":" allows families such as interest:annadanam. */
const DEVOTEE_TAG_RE  = '/^[a-z0-9:_-]{1,40}$/';
const DEVOTEE_TAG_MAX = 50;

/**
 * What the committee typed ("Volunteer, interest:annadanam") as tags: split on
 * commas and whitespace, lowercased, de-duplicated. Anything that is not a valid
 * tag comes back separately so the page can say exactly which one.
 */
function devoteeParseTags(string $input): array
{
    $ok = $bad = [];
    foreach (preg_split('/[\s,]+/u', mb_strtolower(trim($input))) ?: [] as $t) {
        if ($t === '') continue;
        if (preg_match(DEVOTEE_TAG_RE, $t)) $ok[$t] = true;
        else $bad[] = mb_substr($t, 0, 60);
    }
    return ['ok' => array_keys($ok), 'bad' => $bad];
}

/** E.164 digits are stored without the plus; show them as a person dials them. */
function devoteePhoneDisplay(?string $phone): string
{
    $d = preg_replace('/\D+/', '', (string) $phone) ?? '';
    return $d === '' ? '' : '+' . $d;
}

// ── Filters (GET, whitelisted) ───────────────────────────────────────────────
$str = static fn(string $k): string => is_string($_GET[$k] ?? null) ? trim($_GET[$k]) : '';

$q       = $str('q');
$status  = in_array($str('status'), ['verified', 'unverified', 'closed'], true) ? $str('status') : '';
$country = preg_match('/^[A-Za-z]{2}$/', $str('country')) ? strtoupper($str('country')) : '';
$sortCol = in_array($str('sort'), ['created_at', 'name', 'last_login_at'], true) ? $str('sort') : 'created_at';
$editId  = (int) $str('edit');
$dir     = $str('dir') === 'asc' ? 'asc' : 'desc';
$page    = max(1, (int) $str('page'));
$tag     = $hasTags && preg_match(DEVOTEE_TAG_RE, mb_strtolower($str('tag'))) ? mb_strtolower($str('tag')) : '';

$query      = ['q' => $q, 'status' => $status, 'country' => $country, 'tag' => $tag, 'sort' => $sortCol, 'dir' => $dir];
$hasFilters = $q !== '' || $status !== '' || $country !== '' || $tag !== '';
$selfUrl    = '/admin/devotees.php' . adminQuery($query, ['page' => $page > 1 ? $page : null]);

$where  = [];
$params = [];
if ($q !== '') {
    $like = '%' . addcslashes($q, '%_\\') . '%';
    $cols = ['name LIKE :q_name', 'email LIKE :q_email', 'phone LIKE :q_phone'];
    $params[':q_name'] = $like;
    $params[':q_email'] = $like;
    $params[':q_phone'] = $like;
    if ($hasLocation) {
        $cols[] = 'city LIKE :q_city';
        $params[':q_city'] = $like;
    }
    if ($hasAddress) {
        $cols[] = 'address1 LIKE :q_addr';
        $cols[] = 'postcode LIKE :q_post';
        $params[':q_addr'] = $like;
        $params[':q_post'] = $like;
    }
    $where[] = '(' . implode(' OR ', $cols) . ')';
}
if ($status === 'verified')   $where[] = 'email_verified_at IS NOT NULL AND is_active = 1';
if ($status === 'unverified') $where[] = 'email_verified_at IS NULL AND is_active = 1';
if ($status === 'closed')     $where[] = 'is_active = 0';
if ($country !== '' && $hasLocation) {
    $where[] = 'country = :country';
    $params[':country'] = $country;
}
if ($tag !== '') {
    // EXISTS on the (devotee_id, tag) primary key: one indexed probe per devotee, no duplicate rows.
    $where[] = 'EXISTS (SELECT 1 FROM devotee_tags dt WHERE dt.devotee_id = devotees.id AND dt.tag = :tag)';
    $params[':tag'] = $tag;
}
$whereSql = $where ? ' WHERE ' . implode(' AND ', $where) : '';
// $sortCol comes from a whitelist above, so this interpolation is safe.
$orderSql = ' ORDER BY ' . $sortCol . ' ' . strtoupper($dir) . ', id DESC';

/** Editing a devotee is an editor capability; a viewer keeps read + export. */
$canEdit = adminCan('devotees.edit');

// ── POST actions → flash + redirect ─────────────────────────────────────────
$msg = adminCsrfGuard();
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $msg === '') {
    $action = is_string($_POST['action'] ?? null) ? $_POST['action'] : '';
    $id     = is_scalar($_POST['id'] ?? null) ? (int) $_POST['id'] : 0;

    // Second line of defence behind requireAdminAuth()'s write policy.
    if (!$canEdit) {
        $_SESSION['flash_devotees'] = ['error', 'Your role cannot change devotee details.'];
        header('Location: ' . $selfUrl);
        exit;
    }
    if ($id <= 0) {
        $_SESSION['flash_devotees'] = ['error', 'Invalid devotee id.'];
        header('Location: ' . $selfUrl);
        exit;
    }

    $stmt = $db->prepare('SELECT * FROM devotees WHERE id = :id');
    $stmt->execute([':id' => $id]);
    $target = $stmt->fetch();
    if (!$target) {
        $_SESSION['flash_devotees'] = ['warning', 'That devotee no longer exists.'];
        header('Location: ' . $selfUrl);
        exit;
    }

    if ($action === 'save') {
        $name  = sanitizeText($_POST['name'] ?? '', 200);
        $email = mb_strtolower(trim((string) ($_POST['email'] ?? '')));
        $ph    = normalizePhone($_POST['phone'] ?? '', $_POST['phone_country'] ?? null);
        $errors = [];

        if (mb_strlen($name) < 2) $errors[] = 'Enter the devotee\'s name.';
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || mb_strlen($email) > 190) {
            $errors[] = 'Enter a valid email address.';
        }
        if ($ph['error'] !== '') $errors[] = $ph['error'];

        // The address is the devotee's sign-in name, so it has to stay unique.
        if (!$errors) {
            $dupe = $db->prepare('SELECT id FROM devotees WHERE email = :e AND id <> :id LIMIT 1');
            $dupe->execute([':e' => $email, ':id' => $id]);
            if ($dupe->fetch()) $errors[] = 'Another devotee already uses that email address.';
        }

        if ($errors) {
            $_SESSION['flash_devotees'] = ['error', implode(' ', $errors)];
            header('Location: ' . '/admin/devotees.php' . adminQuery($query, ['edit' => $id]));
            exit;
        }

        $sets   = ['name = :n', 'email = :e', 'phone = :p'];
        $values = [
            ':n'  => $name,
            ':e'  => $email,
            ':p'  => $ph['phone'] !== '' ? $ph['phone'] : null,
            ':id' => $id,
        ];
        if ($hasPhoneIso) {
            $sets[] = 'phone_country = :pc';
            $values[':pc'] = $ph['phone'] !== '' ? $ph['country'] : null;
        }
        if ($hasLocation) {
            $sets[] = 'country = :co';
            $sets[] = 'city = :ci';
            $values[':co'] = normalizeCountry($_POST['country'] ?? null);
            $city = sanitizeText($_POST['city'] ?? '', 120);
            $values[':ci'] = $city !== '' ? $city : null;
        }
        if ($hasState) {
            $sets[] = 'state = :st';
            $stateVal = sanitizeText($_POST['state'] ?? '', 120);
            $values[':st'] = $stateVal !== '' ? $stateVal : null;
        }
        if ($hasAddress) {
            $a1 = sanitizeText($_POST['address1'] ?? '', 180);
            $a2 = sanitizeText($_POST['address2'] ?? '', 180);
            $pz = sanitizeText($_POST['postcode'] ?? '', 20);
            $sets[] = 'address1 = :a1';
            $sets[] = 'address2 = :a2';
            $sets[] = 'postcode = :pz';
            $values[':a1'] = $a1 !== '' ? $a1 : null;
            $values[':a2'] = $a2 !== '' ? $a2 : null;
            $values[':pz'] = $pz !== '' ? $pz : null;
        }

        $db->prepare('UPDATE devotees SET ' . implode(', ', $sets) . ' WHERE id = :id')->execute($values);
        adminAudit('devotee.update', $email, 'Updated details for devotee #' . $id);
        $_SESSION['flash_devotees'] = ['success', 'Saved ' . $name . '\'s details.'];
        header('Location: ' . '/admin/devotees.php' . adminQuery($query, ['edit' => $id]));
        exit;
    }

    if ($action === 'verify') {
        // Confirming by hand is for the case the committee actually hits: the
        // devotee never received the email. It does not bypass anything — the
        // address was already theirs to use; this only records it as checked.
        $db->prepare('UPDATE devotees SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = :id')
           ->execute([':id' => $id]);
        adminAudit('devotee.verify', $target['email'], 'Marked email confirmed by the committee');
        $_SESSION['flash_devotees'] = ['success', $target['email'] . ' is now marked as confirmed.'];
        header('Location: ' . $selfUrl);
        exit;
    }

    if ($action === 'close' || $action === 'reopen') {
        $active = $action === 'reopen' ? 1 : 0;
        $db->prepare('UPDATE devotees SET is_active = :a WHERE id = :id')->execute([':a' => $active, ':id' => $id]);
        // A closed account cannot sign in, so any outstanding reset link is void.
        if (!$active) {
            $db->prepare('UPDATE devotee_tokens SET used_at = NOW() WHERE devotee_id = :d AND used_at IS NULL')
               ->execute([':d' => $id]);
        }
        adminAudit('devotee.' . $action, $target['email'], $active ? 'Reopened the account' : 'Closed the account');
        $_SESSION['flash_devotees'] = ['success', $active
            ? $target['email'] . ' can sign in again.'
            : $target['email'] . ' has been closed and can no longer sign in.'];
        header('Location: ' . $selfUrl);
        exit;
    }

    if ($action === 'tag_add' || $action === 'tag_remove') {
        $tagsBack = '/admin/devotees.php' . adminQuery($query, ['edit' => $id]) . '#devotee-tags';
        if (!$hasTags) {
            $_SESSION['flash_devotees'] = ['error', 'Tags need database/migrations/007_notifications.sql to be applied first.'];
            header('Location: ' . $tagsBack);
            exit;
        }

        if ($action === 'tag_add') {
            $parsed = devoteeParseTags(is_string($_POST['tags'] ?? null) ? $_POST['tags'] : '');
            if ($parsed['bad']) {
                $_SESSION['flash_devotees'] = ['error', '"' . implode('", "', $parsed['bad']) . '" ' . (count($parsed['bad']) === 1 ? 'is not a valid tag' : 'are not valid tags')
                    . '. A tag is up to 40 lowercase letters, digits, colons, underscores or hyphens, such as volunteer or interest:annadanam. Nothing was added.'];
            } elseif (!$parsed['ok']) {
                $_SESSION['flash_devotees'] = ['error', 'Type a tag to add, such as volunteer.'];
            } else {
                $have = $db->prepare('SELECT tag FROM devotee_tags WHERE devotee_id = :d');
                $have->execute([':d' => $id]);
                $existing = $have->fetchAll(PDO::FETCH_COLUMN);
                $new      = array_values(array_diff($parsed['ok'], $existing));
                if (count($existing) + count($new) > DEVOTEE_TAG_MAX) {
                    $_SESSION['flash_devotees'] = ['error', 'A devotee can have at most ' . DEVOTEE_TAG_MAX . ' tags. Remove some before adding more.'];
                } elseif (!$new) {
                    $_SESSION['flash_devotees'] = ['info', $target['name'] . ' already has ' . (count($parsed['ok']) === 1 ? 'that tag' : 'those tags') . '.'];
                } else {
                    // INSERT IGNORE: a double-submitted form or a second admin adding the same tag is not an error.
                    $ins = $db->prepare('INSERT IGNORE INTO devotee_tags (devotee_id, tag, created_by, created_at) VALUES (:d, :t, :by, UTC_TIMESTAMP())');
                    foreach ($new as $t) {
                        $ins->execute([':d' => $id, ':t' => $t, ':by' => mb_substr((string) ($_SESSION['admin_user'] ?? 'admin'), 0, 120)]);
                    }
                    adminAudit('devotee.tags', $target['email'], 'Added tag' . (count($new) === 1 ? ' ' : 's ') . implode(', ', $new) . ' to devotee #' . $id);
                    $_SESSION['flash_devotees'] = ['success', 'Tagged ' . $target['name'] . ' as ' . implode(', ', $new) . '.'];
                }
            }
        } else {
            $t = mb_strtolower(is_string($_POST['tag'] ?? null) ? trim($_POST['tag']) : '');
            if (!preg_match(DEVOTEE_TAG_RE, $t)) {
                $_SESSION['flash_devotees'] = ['error', 'Invalid tag.'];
            } else {
                $del = $db->prepare('DELETE FROM devotee_tags WHERE devotee_id = :d AND tag = :t');
                $del->execute([':d' => $id, ':t' => $t]);
                if ($del->rowCount() > 0) {
                    adminAudit('devotee.tags', $target['email'], 'Removed tag ' . $t . ' from devotee #' . $id);
                    $_SESSION['flash_devotees'] = ['success', 'Removed the tag ' . $t . ' from ' . $target['name'] . '.'];
                } else {
                    $_SESSION['flash_devotees'] = ['info', $target['name'] . ' did not have the tag ' . $t . '.'];
                }
            }
        }
        header('Location: ' . $tagsBack);
        exit;
    }

    $msg = '<p class="alert alert--error" role="alert">Unknown action.</p>';
}

// ── CSV export — respects the active filters and sort ───────────────────────
if ($str('export') === 'csv') {
    $cols = ['id', 'name', 'email', 'phone'];
    if ($hasPhoneIso) $cols[] = 'phone_country';
    if ($hasLocation) { $cols[] = 'country'; }
    if ($hasState)    { $cols[] = 'state'; }
    if ($hasAddress)  { $cols[] = 'address1'; $cols[] = 'address2'; }
    if ($hasLocation) { $cols[] = 'city'; }
    if ($hasAddress)  { $cols[] = 'postcode'; }
    $cols = array_merge($cols, ['email_verified_at', 'is_active', 'last_login_at', 'created_at']);

    $select = implode(', ', $cols);
    if ($hasTags) {
        // Space-separated, the way a tag list reads in a spreadsheet cell.
        $select .= ", (SELECT GROUP_CONCAT(dt.tag ORDER BY dt.tag SEPARATOR ' ') FROM devotee_tags dt WHERE dt.devotee_id = devotees.id) AS tags";
        $cols[]  = 'tags';
    }
    $stmt = $db->prepare('SELECT ' . $select . ' FROM devotees' . $whereSql . $orderSql);
    $stmt->execute($params);
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="devotees-' . date('Y-m-d') . '.csv"');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF"); // BOM so Excel reads Tamil correctly
    fputcsv($out, $cols, ',', '"', '');
    while ($r = $stmt->fetch()) {
        fputcsv($out, array_map(static fn($c) => $r[$c] ?? '', $cols), ',', '"', '');
    }
    fclose($out);
    exit;
}

// ── Data ─────────────────────────────────────────────────────────────────────
$totals = $db->query(
    'SELECT COUNT(*) AS all_n,
            SUM(email_verified_at IS NOT NULL AND is_active = 1) AS verified_n,
            SUM(email_verified_at IS NULL AND is_active = 1)     AS pending_n,
            SUM(is_active = 0)                                   AS closed_n,
            SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY))  AS month_n
       FROM devotees'
)->fetch();

// One query for every devotee's activity, rather than two per row.
$activity = [];
try {
    $act = $db->query(
        'SELECT d.id,
                (SELECT COUNT(*) FROM seva_bookings b WHERE b.devotee_id = d.id)          AS bookings,
                (SELECT COUNT(*) FROM donations  n WHERE n.devotee_id = d.id)             AS donations,
                (SELECT COALESCE(SUM(n.amount),0) FROM donations n WHERE n.devotee_id = d.id) AS given
           FROM devotees d'
    );
    foreach ($act as $r) $activity[(int) $r['id']] = $r;
} catch (Throwable) {
    // devotee_id arrives with migration 003 too; without it the column is simply absent.
}

$selectCols = 'id, name, email, phone, email_verified_at, is_active, last_login_at, created_at'
    . ($hasPhoneIso ? ', phone_country' : '')
    . ($hasLocation ? ', country, city' : '')
    . ($hasState ? ', state' : '')
    . ($hasAddress ? ', address1, address2, postcode' : '');
$result = adminPaginate($db, 'SELECT ' . $selectCols . ' FROM devotees' . $whereSql . $orderSql, $params, $page, $perPage);
$rows   = $result['rows'];

// The devotee open in the edit panel, if any. Loaded by id rather than taken
// from the page's rows, so a link from search or another page still works.
$editing = null;
if ($editId > 0 && $canEdit) {
    $stmt = $db->prepare('SELECT * FROM devotees WHERE id = :id');
    $stmt->execute([':id' => $editId]);
    $editing = $stmt->fetch() ?: null;
    if (!$editing) $msg .= '<p class="alert alert--warning" role="status">That devotee no longer exists.</p>';
}

// Tags: this page's devotees in one query, the tags in use (for the filter and
// the editor's suggestions), and the open devotee's own list.
$tagsById    = [];
$tagsInUse   = [];
$editingTags = [];
if ($hasTags) {
    $ids = array_map(static fn($r) => (int) $r['id'], $rows);
    if ($ids) {
        $marks = implode(',', array_fill(0, count($ids), '?'));
        $stmt  = $db->prepare('SELECT devotee_id, tag FROM devotee_tags WHERE devotee_id IN (' . $marks . ') ORDER BY tag');
        $stmt->execute($ids);
        foreach ($stmt->fetchAll() as $r) $tagsById[(int) $r['devotee_id']][] = (string) $r['tag'];
    }
    foreach ($db->query('SELECT tag, COUNT(*) AS n FROM devotee_tags GROUP BY tag ORDER BY n DESC, tag LIMIT 300') as $r) {
        $tagsInUse[(string) $r['tag']] = (int) $r['n'];
    }
    if ($editing) {
        $stmt = $db->prepare('SELECT tag FROM devotee_tags WHERE devotee_id = :d ORDER BY tag');
        $stmt->execute([':d' => (int) $editing['id']]);
        $editingTags = $stmt->fetchAll(PDO::FETCH_COLUMN);
    }
}

// Countries present, for the filter — only ones that actually have devotees.
$countries = [];
if ($hasLocation) {
    foreach ($db->query('SELECT country, COUNT(*) n FROM devotees WHERE country IS NOT NULL GROUP BY country ORDER BY n DESC, country') as $r) {
        $countries[(string) $r['country']] = (int) $r['n'];
    }
}

// Flash from a previous redirect
$flash = $_SESSION['flash_devotees'] ?? null;
unset($_SESSION['flash_devotees']);
if (is_array($flash) && count($flash) === 2) {
    [$tone, $text] = $flash;
    $tone = in_array($tone, ['success', 'error', 'warning', 'info'], true) ? $tone : 'info';
    $msg .= '<p class="alert alert--' . $tone . '" role="' . ($tone === 'error' ? 'alert' : 'status') . '">' . h((string) $text) . '</p>';
}

$exportHref = 'devotees.php' . adminQuery($query, ['export' => 'csv', 'page' => null]);

$statusChips = [
    'All'            => '',
    'Confirmed'      => 'verified',
    'Not confirmed'  => 'unverified',
    'Closed'         => 'closed',
];

// ── Page ─────────────────────────────────────────────────────────────────────
adminHeader('Devotee Accounts', 'Devotees', [
    'actions' => '<a href="/register" target="_blank" rel="noopener" class="btn btn--sm">' . adminIcon('external') . 'Sign-up page</a>',
]);
echo $msg;
echo adminPageIntro(
    'Devotees who registered an account on the public website. Their bookings and donations are linked to the account, so a devotee sees their own history. '
    . ($canEdit ? 'Correct a name, address or number here; ' : 'You have read access; ')
    . 'passwords are never shown — a devotee who is locked out resets their own from the sign-in page.',
    '<a href="' . h($exportHref) . '" class="btn btn-primary btn--sm">' . adminIcon('download') . ($hasFilters ? 'Export filtered CSV' : 'Export CSV') . '</a>'
);

echo adminKpi([
    ['icon' => 'users',        'value' => (int) $totals['all_n'],      'label' => 'Registered devotees', 'variant' => 'accent'],
    ['icon' => 'check-circle', 'value' => (int) $totals['verified_n'], 'label' => 'Email confirmed'],
    ['icon' => 'alert',        'value' => (int) $totals['pending_n'],  'label' => 'Awaiting confirmation',
                               'href'  => 'devotees.php' . adminQuery([], ['status' => 'unverified'])],
    ['icon' => 'trending',     'value' => (int) $totals['month_n'],    'label' => 'Joined in 30 days'],
]);
?>

<form method="GET" action="devotees.php" class="toolbar" role="search" aria-label="Filter devotees">
  <input type="hidden" name="sort" value="<?= h($sortCol) ?>" />
  <input type="hidden" name="dir" value="<?= h($dir) ?>" />
  <?php if ($status !== ''): ?><input type="hidden" name="status" value="<?= h($status) ?>" /><?php endif; ?>
  <div class="toolbar__search">
    <?= adminIcon('search') ?>
    <label class="sr-only" for="f-q">Search devotees</label>
    <input id="f-q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search name, email, phone or town…" autocomplete="off" />
  </div>
  <div class="toolbar__group">
    <?php if ($countries): ?>
      <label for="f-country">Country
        <select id="f-country" name="country">
          <option value="">Anywhere</option>
          <?php foreach ($countries as $code => $n): ?>
            <option value="<?= h($code) ?>"<?= $country === $code ? ' selected' : '' ?>><?= h($code) ?> (<?= $n ?>)</option>
          <?php endforeach; ?>
        </select>
      </label>
    <?php endif; ?>
    <?php if ($hasTags && ($tagsInUse || $tag !== '')): ?>
      <label for="f-tag">Tag
        <select id="f-tag" name="tag">
          <option value="">Any tag</option>
          <?php if ($tag !== '' && !isset($tagsInUse[$tag])): ?><option value="<?= h($tag) ?>" selected><?= h($tag) ?> (0)</option><?php endif; ?>
          <?php foreach ($tagsInUse as $t => $n): ?>
            <option value="<?= h($t) ?>"<?= $tag === $t ? ' selected' : '' ?>><?= h($t) ?> (<?= $n ?>)</option>
          <?php endforeach; ?>
        </select>
      </label>
    <?php endif; ?>
    <button type="submit" class="btn btn--sm"><?= adminIcon('filter') ?> Apply</button>
    <?php if ($hasFilters): ?>
      <a href="devotees.php" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Reset</a>
    <?php endif; ?>
  </div>
  <span class="toolbar__count"><?= $result['total'] ?> devotee<?= $result['total'] === 1 ? '' : 's' ?></span>
</form>

<nav class="filter-chips mb-4" aria-label="Filter by account status">
  <?php foreach ($statusChips as $label => $value): ?>
    <a class="chip" href="<?= h('devotees.php' . adminQuery($query, ['status' => $value, 'page' => null])) ?>"<?= $status === $value ? ' aria-current="page"' : '' ?>><?= h($label) ?></a>
  <?php endforeach; ?>
</nav>

<?php if ($editing): ?>
<section class="card card--solid card--static admin-form-box mb-4" id="edit-devotee" aria-labelledby="edit-devotee-title">
  <h2 id="edit-devotee-title"><?= adminIcon('pencil') ?>Edit <?= h($editing['name']) ?></h2>
  <form method="POST" action="/admin/devotees.php">
    <?= csrfField() ?>
    <input type="hidden" name="action" value="save" />
    <input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" />

    <label for="d-name">Full name <span class="field__required" aria-hidden="true">*</span>
      <input id="d-name" name="name" required aria-required="true" maxlength="200" value="<?= h($editing['name']) ?>" />
    </label>

    <div class="form-grid">
      <label for="d-email">Email address <span class="field__required" aria-hidden="true">*</span>
        <input id="d-email" type="email" name="email" required aria-required="true" maxlength="190" spellcheck="false"
               autocapitalize="off" value="<?= h($editing['email']) ?>" />
        <span class="field__hint">This is how the devotee signs in. Changing it changes their sign-in name.</span>
      </label>
      <label for="d-phone">Phone
        <input id="d-phone" type="tel" name="phone" maxlength="20" placeholder="+919876543210"
               value="<?= h(devoteePhoneDisplay($editing['phone'] ?? '')) ?>" />
        <span class="field__hint">Full international number, country code included.</span>
      </label>
    </div>

    <div class="form-grid">
      <?php if ($hasPhoneIso): ?>
      <label for="d-pcountry">Number's country
        <input id="d-pcountry" class="input--code" name="phone_country" maxlength="2" placeholder="IN"
               spellcheck="false" value="<?= h($editing['phone_country'] ?? '') ?>" />
        <span class="field__hint">Two letters: IN, GB, SG.</span>
      </label>
      <?php endif; ?>
    </div>

    <?php if ($hasAddress): ?>
    <p class="field__label">Postal address <span class="field__hint">— where a receipt is sent</span></p>
    <label for="d-addr1">House and street
      <input id="d-addr1" name="address1" maxlength="180" value="<?= h($editing['address1'] ?? '') ?>" />
    </label>
    <label for="d-addr2">Area or landmark
      <input id="d-addr2" name="address2" maxlength="180" value="<?= h($editing['address2'] ?? '') ?>" />
    </label>
    <?php endif; ?>

    <?php /* State, city, PIN, country — the order the devotee's own account
             page asks for them, so the two forms read the same way. Left
             optional here: the committee corrects older records that were
             created before these columns existed. */ ?>
    <div class="form-grid">
      <?php if ($hasLocation): ?>
      <?php if ($hasState): ?>
      <label for="d-state">State or region
        <input id="d-state" name="state" maxlength="120" placeholder="TN" value="<?= h($editing['state'] ?? '') ?>" />
      </label>
      <?php endif; ?>
      <label for="d-city">City or town
        <input id="d-city" name="city" maxlength="120" value="<?= h($editing['city'] ?? '') ?>" />
      </label>
      <?php endif; ?>
      <?php if ($hasAddress): ?>
      <label for="d-postcode">PIN or postal code
        <input id="d-postcode" name="postcode" maxlength="20" value="<?= h($editing['postcode'] ?? '') ?>" />
      </label>
      <?php endif; ?>
      <?php if ($hasLocation): ?>
      <label for="d-country">Country
        <input id="d-country" class="input--code" name="country" maxlength="2" placeholder="IN"
               spellcheck="false" value="<?= h($editing['country'] ?? '') ?>" />
      </label>
      <?php endif; ?>
    </div>

    <p class="field__hint">
      Joined <?= adminFmtDate($editing['created_at'], true) ?>.
      <?= $editing['email_verified_at'] ? 'Email confirmed ' . adminFmtDate($editing['email_verified_at']) . '.' : 'Email not confirmed yet.' ?>
      <?= $editing['last_login_at'] ? 'Last signed in ' . h(adminAgo($editing['last_login_at'])) . '.' : 'Has never signed in.' ?>
      Passwords are stored hashed and cannot be read or set here — a devotee who is locked out uses the reset link on the sign-in page.
    </p>

    <div class="form-actions">
      <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> Save details</button>
      <a href="<?= h($selfUrl) ?>" class="btn btn-ghost"><?= adminIcon('x') ?> Cancel</a>
    </div>
  </form>

  <?php if ($hasTags):
      $tagFormAction = '/admin/devotees.php' . rtrim(adminQuery($query, ['edit' => (int) $editing['id']]), '?');
  ?>
  <div class="devotee-tags" id="devotee-tags" role="group" aria-labelledby="devotee-tags-title">
    <h3 class="subhead" id="devotee-tags-title">Tags</h3>
    <p class="field__hint">Groups this devotee belongs to, such as volunteer, member or interest:annadanam. A notification audience can be built from a tag.</p>
    <?php if ($editingTags): ?>
      <ul class="devotee-tags__list" aria-label="Tags of <?= h($editing['name']) ?>">
        <?php foreach ($editingTags as $t): ?>
        <li>
          <form method="POST" action="<?= h($tagFormAction) ?>">
            <?= csrfField() ?>
            <input type="hidden" name="action" value="tag_remove" />
            <input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" />
            <input type="hidden" name="tag" value="<?= h($t) ?>" />
            <button type="submit" class="chip devotee-tag" aria-label="Remove the tag <?= h($t) ?>" data-no-loading><?= h($t) ?><?= adminIcon('x') ?></button>
          </form>
        </li>
        <?php endforeach; ?>
      </ul>
    <?php else: ?>
      <p class="field__hint">No tags yet.</p>
    <?php endif; ?>
    <form method="POST" action="<?= h($tagFormAction) ?>" class="devotee-tags__add">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="tag_add" />
      <input type="hidden" name="id" value="<?= (int) $editing['id'] ?>" />
      <label for="d-tag-new">
        <span class="field__label">Add tags</span>
        <input id="d-tag-new" name="tags" type="text" list="devotee-tag-suggestions" maxlength="400" autocomplete="off"
               spellcheck="false" autocapitalize="off" placeholder="volunteer, interest:annadanam" aria-describedby="d-tag-hint" />
        <span class="field__hint" id="d-tag-hint">Lowercase letters, digits, colon, underscore or hyphen; up to 40 characters each. Separate several with commas.</span>
      </label>
      <?php if ($tagsInUse): ?>
      <datalist id="devotee-tag-suggestions">
        <?php foreach (array_keys($tagsInUse) as $t): if (in_array($t, $editingTags, true)) continue; ?><option value="<?= h($t) ?>"></option><?php endforeach; ?>
      </datalist>
      <?php endif; ?>
      <button type="submit" class="btn btn--sm"><?= adminIcon('plus') ?> Add</button>
    </form>
  </div>
  <?php endif; ?>
</section>
<?php endif; ?>

<?php if ($rows): ?>
<div class="table-wrap">
  <table class="table" data-no-search>
    <thead>
      <tr>
        <?= adminSortLink('name', 'Devotee', $query) ?>
        <th scope="col">Contact</th>
        <?php if ($hasLocation): ?><th scope="col">Where</th><?php endif; ?>
        <th scope="col">Activity</th>
        <?php if ($hasTags): ?><th scope="col">Tags</th><?php endif; ?>
        <th scope="col">Status</th>
        <?= adminSortLink('created_at', 'Joined', $query) ?>
        <th scope="col"><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      <?php foreach ($rows as $row):
        $id       = (int) $row['id'];
        $verified = $row['email_verified_at'] !== null;
        $active   = (int) $row['is_active'] === 1;
        $tel      = devoteePhoneDisplay($row['phone'] ?? '');
        $act      = $activity[$id] ?? ['bookings' => 0, 'donations' => 0, 'given' => 0];

        $menu = [];
        if ($canEdit) {
            $menu[] = ['label' => 'Edit details', 'href' => '/admin/devotees.php' . adminQuery($query, ['edit' => $id]), 'icon' => 'pencil'];
            if (!$verified) {
                $menu[] = ['label' => 'Mark email confirmed', 'form' => ['action' => 'verify', 'id' => $id], 'icon' => 'check-circle',
                           'confirm' => 'Mark ' . $row['email'] . ' as confirmed? Do this only when you have checked the address is theirs.', 'confirmLabel' => 'Mark confirmed'];
            }
            $menu[] = 'divider';
            $menu[] = $active
                ? ['label' => 'Close account', 'form' => ['action' => 'close', 'id' => $id], 'icon' => 'lock', 'danger' => true,
                   'confirm' => 'Close ' . $row['email'] . '? They will not be able to sign in. Their bookings and donations are kept.', 'confirmLabel' => 'Close account']
                : ['label' => 'Reopen account', 'form' => ['action' => 'reopen', 'id' => $id], 'icon' => 'key',
                   'confirm' => 'Let ' . $row['email'] . ' sign in again?', 'confirmLabel' => 'Reopen'];
        }
        if ($tel !== '') {
            if ($menu) $menu[] = 'divider';
            $menu[] = ['label' => 'Call', 'href' => 'tel:' . $tel, 'icon' => 'phone'];
        }
        $menu[] = ['label' => 'Email', 'href' => 'mailto:' . $row['email'], 'icon' => 'mail'];
      ?>
      <tr<?= $editId === $id ? ' class="row--current"' : ($active ? '' : ' class="row--muted"') ?>>
        <td>
          <span class="cell-title"><?= h($row['name']) ?></span>
          <a class="cell-sub" href="mailto:<?= h($row['email']) ?>"><?= h($row['email']) ?></a>
        </td>
        <td>
          <?php if ($tel !== ''): ?>
            <a href="tel:<?= h($tel) ?>"><?= h($tel) ?></a>
          <?php else: ?>
            <span class="cell-sub">No number</span>
          <?php endif; ?>
          <?php if ($row['last_login_at']): ?>
            <span class="cell-sub">Last in <?= h(adminAgo($row['last_login_at'])) ?></span>
          <?php else: ?>
            <span class="cell-sub">Never signed in</span>
          <?php endif; ?>
        </td>
        <?php if ($hasLocation): ?>
        <td>
          <?php
            $place  = array_filter([$row['city'] ?? '', $hasState ? ($row['state'] ?? '') : '', $row['country'] ?? '']);
            $street = $hasAddress ? array_filter([$row['address1'] ?? '', $row['address2'] ?? '']) : [];
            $post   = $hasAddress ? trim((string) ($row['postcode'] ?? '')) : '';
          ?>
          <?= $place ? h(implode(', ', $place)) : '<span class="cell-sub">Not given</span>' ?>
          <?php if ($street || $post !== ''): ?>
            <span class="cell-sub"><?= h(trim(implode(', ', $street) . ($post !== '' ? ' · ' . $post : ''), ' ·')) ?></span>
          <?php elseif ($place): ?>
            <span class="cell-sub">No posting address</span>
          <?php endif; ?>
        </td>
        <?php endif; ?>
        <td class="cell-num">
          <?php if ((int) $act['bookings'] || (int) $act['donations']): ?>
            <span><?= (int) $act['bookings'] ?> booking<?= (int) $act['bookings'] === 1 ? '' : 's' ?></span>
            <span class="cell-sub"><?= (int) $act['donations'] ?> offering<?= (int) $act['donations'] === 1 ? '' : 's' ?><?= (float) $act['given'] > 0 ? ' · ' . adminFmtMoney((float) $act['given']) : '' ?></span>
          <?php else: ?>
            <span class="cell-sub">None yet</span>
          <?php endif; ?>
        </td>
        <?php if ($hasTags): ?>
        <td>
          <?php if (!empty($tagsById[$id])): ?>
            <span class="devotee-tags__chips">
              <?php foreach ($tagsById[$id] as $t): ?>
                <a class="devotee-tag-link" href="<?= h('devotees.php' . adminQuery($query, ['tag' => $t, 'page' => null])) ?>" aria-label="Show devotees tagged <?= h($t) ?>"><?= h($t) ?></a>
              <?php endforeach; ?>
            </span>
          <?php else: ?>
            <span class="cell-sub">None</span>
          <?php endif; ?>
        </td>
        <?php endif; ?>
        <td>
          <?php if (!$active): ?>
            <?= adminBadge('Closed', 'danger') ?>
          <?php elseif ($verified): ?>
            <?= adminBadge('Confirmed', 'success') ?>
          <?php else: ?>
            <?= adminBadge('Not confirmed', 'warning') ?>
          <?php endif; ?>
        </td>
        <td class="cell-date">
          <time datetime="<?= h($row['created_at']) ?>"><?= adminFmtDate($row['created_at']) ?></time>
          <span class="cell-sub"><?= h(adminAgo($row['created_at'])) ?></span>
        </td>
        <td class="cell-actions"><?= adminMenu($menu, 'Actions for ' . $row['name']) ?></td>
      </tr>

      <?php endforeach; ?>
    </tbody>
  </table>
</div>

<?= adminPagination($result['page'], $result['pages'], $query, $result['total'], $perPage) ?>

<?php elseif ($hasFilters): ?>
  <?= adminEmpty('search', 'No devotees match these filters', 'Try a different search or clear the filters.', '<a href="devotees.php" class="btn btn-primary btn--sm">' . adminIcon('x') . 'Clear filters</a>') ?>
<?php else: ?>
  <?= adminEmpty('users', 'No devotees have registered yet', 'When someone creates an account on the public website they appear here, and anything they book or give is linked to it.', '<a href="/register" target="_blank" rel="noopener" class="btn btn-primary btn--sm">' . adminIcon('external') . 'View the sign-up page</a>') ?>
<?php endif; ?>

<?php adminFooter(); ?>
