<?php
// backend/admin/devotees.php — Family Registrations (docs/registration/SPEC.md §8).
//
// Every family that registered on the public site's /register form, and what
// the committee needs to keep that list right: search and filter (family
// members' names included), correct a registration and its members, record or
// withdraw consent to temple updates, merge or clear a possible duplicate,
// archive, restore or delete, and export families or members as CSV.
//
// The rules a registration must meet live in includes/registration.php, shared
// with the public form, so the office cannot save what the form would refuse.
// Everything that touches more than one row (a save with its members, a merge,
// a delete) runs there, in one transaction.
//
// Nobody signs in to a registration, so there are no passwords, confirmations or
// sign-in times to show. Reading needs `view` and exporting `export`; every
// change needs `devotees.edit`, which requireAdminAuth() enforces for each POST
// before this page runs, and which the handler below checks again.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/registration.php';
require_once __DIR__ . '/includes/admin_layout.php';

const DV_BASE     = '/admin/devotees.php';
const DV_PER_PAGE = 20;
/** Lowercase so "Volunteer" and "volunteer" are one group; ":" allows families such as interest:annadanam. */
const DV_TAG_RE   = '/^[a-z0-9:_-]{1,40}$/';
const DV_TAG_MAX  = 50;

/**
 * The list's filters besides All, and the condition each adds. Duplicates and
 * consent are about registrations still in use, so they leave archived ones out;
 * Archived lists only those.
 */
const DV_STATUS_SQL = [
    'duplicates' => 'd.is_active = 1 AND d.duplicate_of IS NOT NULL',
    'consented'  => 'd.is_active = 1 AND d.updates_consent_at IS NOT NULL AND d.unsubscribed_at IS NULL',
    'no_consent' => 'd.is_active = 1 AND (d.updates_consent_at IS NULL OR d.unsubscribed_at IS NOT NULL)',
    'archived'   => 'd.is_active = 0',
];

/** Column => how a flash message and the activity log name it. */
const DV_FIELD_LABELS = [
    'name'          => 'name',
    'date_of_birth' => 'date of birth',
    'email'         => 'email',
    'phone'         => 'phone number',
    'phone_country' => "phone number's country",
    'address1'      => 'house and street',
    'address2'      => 'area or landmark',
    'city'          => 'city or town',
    'state'         => 'state or province',
    'country'       => 'country',
    'postcode'      => 'PIN or postal code',
    'lang'          => 'language',
];

$db = getDB();

// Without migration 009 there are no family members, consent or duplicate
// flags to show, so the page explains that instead of failing on a column.
if (!registrationReady() || !publicGuardHasColumn('devotees', 'duplicate_of') || !publicGuardHasColumn('devotees', 'lang')) {
    adminHeader('Family Registrations', 'Devotees');
    echo adminEmpty(
        'users',
        'Family registration is not switched on yet',
        'Apply database/migrations/009_family_registration.sql (after 003 to 008) to keep registered families and their members here. Until then the public registration form tells visitors it is not available yet.',
        '<a href="/register" target="_blank" rel="noopener" class="btn btn--sm">' . adminIcon('external') . 'Public registration form</a>'
    );
    adminFooter();
    exit;
}

/**
 * Tags arrive with migration 007 (devotee_tags). They are how the committee
 * forms groups the site has no module for (volunteers, members, people
 * interested in annadanam) so a notification audience can reach them.
 */
$hasTags = registrationTableExists($db, 'devotee_tags');
$canEdit = adminCan('devotees.edit');

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * What the committee typed ("Volunteer, interest:annadanam") as tags: split on
 * commas and whitespace, lowercased, de-duplicated. Anything that is not a valid
 * tag comes back separately so the page can say exactly which one.
 */
function dvParseTags(string $input): array
{
    $ok = $bad = [];
    foreach (preg_split('/[\s,]+/u', mb_strtolower(trim($input))) ?: [] as $t) {
        if ($t === '') continue;
        if (preg_match(DV_TAG_RE, $t)) $ok[$t] = true;
        else $bad[] = mb_substr($t, 0, 60);
    }
    return ['ok' => array_keys($ok), 'bad' => $bad];
}

/**
 * A phone number as the office reads it: a full international number with its
 * plus, and the ten digits an older record holds exactly as stored.
 */
function dvPhoneDisplay(?string $phone): string
{
    $d = preg_replace('/\D+/', '', (string) $phone) ?? '';
    if ($d === '') return '';
    return strlen($d) >= 11 ? '+' . $d : $d;
}

/** A tel: link that dials older ten-digit Indian numbers correctly too. */
function dvTelHref(?string $phone, ?string $country): string
{
    $intl = devoteeIntlPhone($phone, $country);
    return strlen($intl) >= 7 ? 'tel:+' . $intl : '';
}

/** A UTC time from the database (consent, unsubscribe), as the temple reads it. */
function dvIst(?string $utc): string
{
    if ($utc === null || $utc === '') return '';
    try {
        return (new DateTimeImmutable($utc, new DateTimeZone('UTC')))
            ->setTimezone(new DateTimeZone(REG_TIME_ZONE))
            ->format('d M Y, H:i') . ' IST';
    } catch (Throwable) {
        return $utc;
    }
}

function dvLangLabel(?string $lang): string
{
    return $lang === 'en' ? 'English' : 'Tamil';
}

/** "1 member" / "3 members". */
function dvCount(int $n, string $one, string $many): string
{
    return $n . ' ' . ($n === 1 ? $one : $many);
}

/** When and how this registration's consent to temple updates was given or withdrawn, in one sentence. */
function dvConsentText(array $r): string
{
    if (!empty($r['unsubscribed_at'])) {
        return 'Withdrawn from a link in a message on ' . dvIst($r['unsubscribed_at'])
            . '. Temple updates have stopped; messages about their own bookings and donations still reach them.';
    }
    if (!empty($r['updates_consent_at'])) {
        return empty($r['updates_consent_by'])
            ? 'Agreed on the registration form on ' . dvIst($r['updates_consent_at']) . '.'
            : 'Recorded by ' . $r['updates_consent_by'] . ' on ' . dvIst($r['updates_consent_at']) . '.';
    }
    return 'No consent on file. They receive only messages about their own bookings and donations.';
}

function dvConsentBadge(array $r): string
{
    if (!empty($r['unsubscribed_at']))    return adminBadge('Unsubscribed', 'warning');
    if (!empty($r['updates_consent_at'])) return adminBadge('Agreed to updates', 'success');
    return adminBadge('No consent', 'muted');
}

function dvFlash(string $tone, string $text): void
{
    $_SESSION['flash_devotees'] = [$tone, $text];
}

function dvGo(string $url): never
{
    header('Location: ' . $url);
    exit;
}

/**
 * The WHERE clause shared by the list, its chip counts and both exports, on the
 * alias d. $status is '' for the chip counts, which show what each chip lists.
 * Returns [sql starting " WHERE" or '', params].
 */
function dvFilterSql(string $q, string $country, string $tag, string $status): array
{
    $where  = [];
    $params = [];
    if ($q !== '') {
        $like = '%' . addcslashes($q, '%_\\') . '%';
        $cols = [
            'd.name LIKE :q_name', 'd.email LIKE :q_email', 'd.city LIKE :q_city',
            'd.address1 LIKE :q_addr1', 'd.address2 LIKE :q_addr2',
            // A family is found by any of its members' names.
            'EXISTS (SELECT 1 FROM devotee_family_members fm WHERE fm.devotee_id = d.id AND fm.name LIKE :q_member)',
        ];
        foreach (['name', 'email', 'city', 'addr1', 'addr2', 'member'] as $k) $params[":q_$k"] = $like;

        // A PIN is stored without spaces, so "627 719" finds 627719.
        $compact = preg_replace('/\s+/u', '', $q) ?? '';
        if ($compact !== '') {
            $cols[] = 'd.postcode LIKE :q_post';
            $params[':q_post'] = '%' . addcslashes($compact, '%_\\') . '%';
        }
        // Phones are stored as digits: "+91 98765 43210" and "98765" both match,
        // and a full Indian number also finds an older ten-digit record.
        $digits = preg_replace('/\D+/', '', $q) ?? '';
        if (strlen($digits) >= 3) {
            $cols[] = 'd.phone LIKE :q_phone';
            $params[':q_phone'] = '%' . $digits . '%';
            if (strlen($digits) === 12 && str_starts_with($digits, '91')) {
                $cols[] = 'd.phone = :q_phone10';
                $params[':q_phone10'] = substr($digits, 2);
            }
        }
        $where[] = '(' . implode(' OR ', $cols) . ')';
    }
    if ($country !== '') {
        $where[] = 'd.country = :country';
        $params[':country'] = $country;
    }
    if ($tag !== '') {
        // EXISTS on the (devotee_id, tag) primary key: one indexed probe per row, no duplicate rows.
        $where[] = 'EXISTS (SELECT 1 FROM devotee_tags dt WHERE dt.devotee_id = d.id AND dt.tag = :tag)';
        $params[':tag'] = $tag;
    }
    if (isset(DV_STATUS_SQL[$status])) $where[] = DV_STATUS_SQL[$status];
    return [$where ? ' WHERE ' . implode(' AND ', $where) : '', $params];
}

/**
 * The hint and error under a form control, and the attributes that tie them to
 * it: announced with the field, and the field marked invalid while in error.
 * Returns [attributes for the control, HTML to place after it].
 */
function dvDescribe(string $id, string $hint, string $error): array
{
    $ids  = [];
    $html = '';
    if ($hint !== '') {
        $ids[] = $id . '-hint';
        $html .= '<p class="field__hint" id="' . h($id . '-hint') . '">' . h($hint) . '</p>';
    }
    if ($error !== '') {
        $ids[] = $id . '-err';
        $html .= '<p class="field__error" id="' . h($id . '-err') . '">' . adminIcon('alert-circle') . h($error) . '</p>';
    }
    $attrs = ($ids ? ' aria-describedby="' . h(implode(' ', $ids)) . '"' : '') . ($error !== '' ? ' aria-invalid="true"' : '');
    return [$attrs, $html];
}

/** The label of a field, with its required or optional marker. */
function dvLabel(string $id, string $label, array $o): string
{
    $mark = !empty($o['required'])
        ? ' <span class="field__required" aria-hidden="true">*</span>'
        : (!empty($o['optional']) ? ' <span class="field__optional">(optional)</span>' : '');
    return '<label class="field__label" for="' . h($id) . '">' . h($label) . $mark . '</label>';
}

/** Extra attributes from an options array, escaped. */
function dvAttrs(array $attrs): string
{
    $out = '';
    foreach ($attrs as $k => $v) $out .= ' ' . h((string) $k) . '="' . h((string) $v) . '"';
    return $out;
}

/**
 * One text-like input with its label, hint and error.
 * $o: required, optional, hint, error, attrs (type, maxlength, autocomplete, …).
 */
function dvInput(string $id, string $name, string $label, string $value, array $o = []): string
{
    [$described, $after] = dvDescribe($id, (string) ($o['hint'] ?? ''), (string) ($o['error'] ?? ''));
    $attrs = ($o['attrs'] ?? []) + ['type' => 'text'];
    return '<div class="field">' . dvLabel($id, $label, $o)
        . '<input id="' . h($id) . '" name="' . h($name) . '" value="' . h($value) . '"' . dvAttrs($attrs)
        . (!empty($o['required']) ? ' aria-required="true"' : '') . $described . ' />'
        . $after . '</div>';
}

/** One <select> with its label, hint and error. $options: value => text. */
function dvSelect(string $id, string $name, string $label, string $value, array $options, array $o = []): string
{
    [$described, $after] = dvDescribe($id, (string) ($o['hint'] ?? ''), (string) ($o['error'] ?? ''));
    $html = '<div class="field">' . dvLabel($id, $label, $o)
        . '<select id="' . h($id) . '" name="' . h($name) . '"' . (!empty($o['required']) ? ' aria-required="true"' : '') . $described . '>';
    foreach ($options as $v => $text) {
        $v     = (string) $v;
        $html .= '<option value="' . h($v) . '"' . ($v === $value ? ' selected' : '') . '>' . h((string) $text) . '</option>';
    }
    return $html . '</select>' . $after . '</div>';
}

/** Where a 422 key's field is on the form, for the error summary's links. */
function dvFieldId(string $key): string
{
    $map = [
        'name' => 'd-name', 'dateOfBirth' => 'd-dob', 'phone' => 'd-phone', 'email' => 'd-email', 'lang' => 'd-lang',
        'address1' => 'd-addr1', 'address2' => 'd-addr2', 'city' => 'd-city', 'state' => 'd-state',
        'country' => 'd-country', 'postcode' => 'd-postcode', 'members' => 'd-members',
    ];
    if (isset($map[$key])) return $map[$key];
    if (preg_match('/^members\.(\d+)\.(name|relationship|age)$/', $key, $m)) return 'm-' . $m[1] . '-' . $m[2];
    return 'reg-form';
}

/**
 * One family member on the edit form. $n is its index in the posted list (or
 * __N__ in the template JavaScript copies). An existing member is removed with
 * a tick box, so removal works without JavaScript; a row added by the script
 * can simply be taken away again.
 */
function dvMemberRow(string $n, array $row, array $errors, string $legend, bool $removable, bool $scriptRow = false): string
{
    $key     = 'members.' . $n;
    $options = ['' => 'Choose a relationship'];
    foreach (REG_RELATIONSHIPS as $k => $labels) $options[$k] = $labels['en'];
    // A relationship taken off the list since is still shown for what it is.
    if ($row['relationship'] !== '' && !isset($options[$row['relationship']])) {
        $options[$row['relationship']] = $row['relationship'] . ' (no longer offered)';
    }

    $out = '<li data-repeat-row><fieldset class="reg-member"><legend>' . h($legend) . '</legend>'
        . '<input type="hidden" name="members[' . h($n) . '][id]" value="' . ($row['id'] > 0 ? (int) $row['id'] : '') . '" />'
        . '<div class="reg-member__grid">'
        . dvInput("m-$n-name", "members[$n][name]", 'Name', $row['name'], [
            'required' => true, 'error' => $errors["$key.name"] ?? '',
            'attrs'    => ['maxlength' => (string) REG_LENGTHS['member_name'][1], 'autocomplete' => 'off'],
        ])
        . dvSelect("m-$n-relationship", "members[$n][relationship]", 'Relationship', $row['relationship'], $options, [
            'required' => true, 'error' => $errors["$key.relationship"] ?? '',
        ])
        . dvInput("m-$n-age", "members[$n][age]", 'Age', $row['age'], [
            'optional' => true, 'error' => $errors["$key.age"] ?? '',
            'attrs'    => ['inputmode' => 'numeric', 'maxlength' => '3', 'autocomplete' => 'off'],
        ])
        . '</div>';
    if ($removable) {
        $who  = trim($row['name']) !== '' ? trim($row['name']) : $legend;
        $out .= '<div class="reg-member__foot"><label class="checkbox-label"><input type="checkbox" name="members[' . h($n) . '][remove]" value="1"'
            . ($row['remove'] ? ' checked' : '') . ' aria-label="' . h('Remove ' . $who . ' from this family') . '" /> Remove from this family</label></div>';
    } elseif ($scriptRow) {
        $out .= '<div class="reg-member__foot"><button type="button" class="btn btn-ghost btn--sm" data-repeat-remove>' . adminIcon('x') . 'Remove this row</button></div>';
    }
    return $out . '</fieldset></li>';
}

/* ── Filters (GET, whitelisted) ─────────────────────────────────────────── */
$str = static fn(string $k): string => is_string($_GET[$k] ?? null) ? trim($_GET[$k]) : '';

$q       = mb_substr($str('q'), 0, 120);
$status  = isset(DV_STATUS_SQL[$str('status')]) ? $str('status') : '';
$country = preg_match('/^[A-Za-z]{2}$/', $str('country')) ? strtoupper($str('country')) : '';
$sortCol = $str('sort') === 'name' ? 'name' : 'created_at';
$dir     = in_array($str('dir'), ['asc', 'desc'], true) ? $str('dir') : ($sortCol === 'name' ? 'asc' : 'desc');
$page    = max(1, (int) $str('page'));
$editId  = preg_match('/^[1-9][0-9]{0,9}$/', $str('edit')) ? (int) $str('edit') : 0;
$tag     = $hasTags && preg_match(DV_TAG_RE, mb_strtolower($str('tag'))) ? mb_strtolower($str('tag')) : '';

$query      = ['q' => $q, 'status' => $status, 'country' => $country, 'tag' => $tag, 'sort' => $sortCol, 'dir' => $dir];
$hasFilters = $q !== '' || $status !== '' || $country !== '' || $tag !== '';
$listUrl    = DV_BASE . adminQuery($query, ['page' => $page > 1 ? $page : null]);
$editUrlFor = static fn(int $id): string => DV_BASE . adminQuery($query, ['edit' => $id]);

/* ── POST actions → flash + redirect ────────────────────────────────────── */
$msg  = adminCsrfGuard();
$form = null; // a Save that did not pass validation, shown again with its errors

if ($_SERVER['REQUEST_METHOD'] === 'POST' && $msg !== '') {
    // Nothing was changed; the status says so as plainly as the message does.
    http_response_code(403);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && $msg === '') {
    $action = is_string($_POST['action'] ?? null) ? $_POST['action'] : '';
    $id     = is_string($_POST['id'] ?? null) && preg_match('/^[1-9][0-9]{0,9}$/', $_POST['id']) ? (int) $_POST['id'] : 0;

    // Second line of defence behind requireAdminAuth()'s write policy.
    if (!$canEdit) {
        dvFlash('error', 'Your role can read and export registrations but not change them.');
        dvGo($listUrl);
    }
    if ($id === 0) {
        dvFlash('error', 'Choose a registration first.');
        dvGo($listUrl);
    }
    $target = registrationLoad($db, $id);
    if (!$target) {
        dvFlash('warning', 'That registration no longer exists. It may have been merged or deleted.');
        dvGo($listUrl);
    }

    $actor   = (string) (currentAdmin()['username'] ?? 'admin');
    $subject = 'Registration #' . $id;
    $who     = (string) $target['name'];
    $editUrl = $editUrlFor($id);
    $back    = ($_POST['return'] ?? null) === 'list' ? $listUrl : $editUrl;

    try {
        if ($action === 'save') {
            // The form's names mapped onto the public form's keys, so both are
            // held to exactly the same rules.
            $input = [];
            foreach ([
                'name' => 'name', 'dateOfBirth' => 'date_of_birth', 'phone' => 'phone', 'phoneCountry' => 'phone_country',
                'email' => 'email', 'lang' => 'lang', 'address1' => 'address1', 'address2' => 'address2',
                'city' => 'city', 'state' => 'state', 'country' => 'country', 'postcode' => 'postcode',
            ] as $apiKey => $postKey) {
                $input[$apiKey] = $_POST[$postKey] ?? null;
            }
            $details = registrationValidateDetails($input);
            $members = registrationValidateMemberRows($_POST['members'] ?? null);
            $consent = ($_POST['consent'] ?? null) === '1';
            $errors  = $details['errors'] + $members['errors'];

            if ($errors) {
                // Shown again below, as typed, with every problem marked.
                $form   = ['id' => $id, 'post' => $_POST, 'members' => $members['rows'], 'consent' => $consent, 'errors' => $errors];
                $editId = $id;
                http_response_code(422);
            } else {
                $result = registrationSave($db, $id, $details['values'], $consent, $members, $actor);
                $name   = $details['values']['name'];
                $notes  = [];
                if ($result['changed']) {
                    $labels = array_map(static fn(string $c): string => DV_FIELD_LABELS[$c] ?? $c, $result['changed']);
                    adminAudit('registration.update', $subject, 'Changed the ' . implode(', ', $labels) . ' of ' . $name);
                    $notes[] = 'Updated the ' . implode(', ', $labels) . '.';
                }
                if ($result['consent'] === 'recorded') {
                    adminAudit('registration.consent', $subject, 'Recorded consent to temple updates for ' . $name);
                    $notes[] = 'Consent to temple updates is recorded in your name.';
                } elseif ($result['consent'] === 'withdrawn') {
                    adminAudit('registration.consent', $subject, 'Withdrew consent to temple updates for ' . $name);
                    $notes[] = 'Consent to temple updates is withdrawn.';
                }
                $m = $result['members'];
                if ($m['added'] || $m['updated'] || $m['removed']) {
                    $bits = [];
                    if ($m['added'])   $bits[] = 'added ' . implode(', ', $m['added']);
                    if ($m['updated']) $bits[] = 'updated ' . implode(', ', $m['updated']);
                    if ($m['removed']) $bits[] = 'removed ' . implode(', ', $m['removed']);
                    adminAudit('registration.members', $subject, ucfirst(implode('; ', $bits)) . ' in the family of ' . $name);
                    $notes[] = 'Family members: ' . implode('; ', $bits) . '.';
                }
                $wasDuplicateOf = $result['before']['duplicate_of'] !== null ? (int) $result['before']['duplicate_of'] : null;
                if ($result['duplicate_of'] !== null && $result['duplicate_of'] !== $wasDuplicateOf) {
                    $notes[] = 'The phone number matches registration #' . $result['duplicate_of'] . ', so this one is flagged as a possible duplicate.';
                }
                dvFlash($notes ? 'success' : 'info', $notes ? 'Saved ' . $name . '. ' . implode(' ', $notes) : 'Nothing changed for ' . $name . '.');
                dvGo($editUrl);
            }
        } elseif ($action === 'archive' || $action === 'restore') {
            $restore = $action === 'restore';
            if (registrationSetActive($db, $id, $restore)) {
                adminAudit('registration.' . $action, $subject, ($restore ? 'Restored' : 'Archived') . ' the registration of ' . $who);
                dvFlash('success', $restore
                    ? "Restored $who's registration. Temple updates reach them again if they agreed to them."
                    : "Archived $who's registration. It stays on file, and temple updates stop until it is restored.");
            } else {
                dvFlash('info', $restore ? "$who's registration is not archived." : "$who's registration was already archived.");
            }
            dvGo($back);
        } elseif ($action === 'delete') {
            $memberCount = count(registrationMembers($db, $id));
            $gone        = registrationDelete($db, $id);
            adminAudit('registration.delete', $subject, 'Deleted the registration of ' . $gone['name'] . ' with ' . dvCount($memberCount, 'family member', 'family members'));
            dvFlash('success', 'Deleted the registration of ' . $gone['name']
                . ($memberCount ? ' and its ' . dvCount($memberCount, 'family member', 'family members') : '') . '.');
            dvGo($listUrl);
        } elseif ($action === 'not_duplicate') {
            if (registrationClearDuplicate($db, $id)) {
                adminAudit('registration.not_duplicate', $subject, 'Marked ' . $who . ' as not a duplicate of registration #' . (int) $target['duplicate_of']);
                dvFlash('success', "$who's registration is no longer flagged as a possible duplicate.");
            } else {
                dvFlash('info', "$who's registration was not flagged as a possible duplicate.");
            }
            dvGo($back);
        } elseif ($action === 'merge') {
            $into = is_string($_POST['target'] ?? null) && preg_match('/^[1-9][0-9]{0,9}$/', $_POST['target']) ? (int) $_POST['target'] : 0;
            if ($into === 0) {
                dvFlash('error', 'Choose the registration to merge this one into.');
                dvGo($editUrl);
            }
            $moved = registrationMerge($db, $id, $into, ($_POST['fill_empty'] ?? null) === '1');
            $parts = [
                dvCount($moved['members'], 'family member', 'family members'),
                dvCount($moved['tags'], 'tag', 'tags'),
                dvCount($moved['bookings'], 'linked seva booking', 'linked seva bookings'),
                dvCount($moved['donations'], 'linked donation', 'linked donations'),
                dvCount($moved['notifications'], 'message', 'messages'),
            ];
            $filled = $moved['filled']
                ? ' Filled in: ' . implode(', ', array_map(static fn(string $f): string => $f === 'consent' ? 'consent to updates' : (DV_FIELD_LABELS[$f] ?? $f), $moved['filled'])) . '.'
                : '';
            adminAudit('registration.merge', 'Registration #' . $into, 'Merged registration #' . $id . ' (' . $who . ') into #' . $into . ': moved ' . implode(', ', $parts) . '.' . $filled);
            dvFlash('success', 'Merged ' . $who . ' (#' . $id . ') into registration #' . $into . ', and deleted #' . $id . '. Moved ' . implode(', ', $parts) . '.' . $filled);
            dvGo($editUrlFor($into));
        } elseif ($action === 'tag_add' || $action === 'tag_remove') {
            $tagsBack = $editUrl . '#devotee-tags';
            // The subject stays the email where there is one, as tag changes were logged before.
            $tagSubject = (string) ($target['email'] ?? '') !== '' ? (string) $target['email'] : $subject;
            if (!$hasTags) {
                dvFlash('error', 'Tags need database/migrations/007_notifications.sql to be applied first.');
                dvGo($tagsBack);
            }
            if ($action === 'tag_add') {
                $parsed = dvParseTags(is_string($_POST['tags'] ?? null) ? $_POST['tags'] : '');
                if ($parsed['bad']) {
                    dvFlash('error', '"' . implode('", "', $parsed['bad']) . '" ' . (count($parsed['bad']) === 1 ? 'is not a valid tag' : 'are not valid tags')
                        . '. A tag is up to 40 lowercase letters, digits, colons, underscores or hyphens, such as volunteer or interest:annadanam. Nothing was added.');
                } elseif (!$parsed['ok']) {
                    dvFlash('error', 'Type a tag to add, such as volunteer.');
                } else {
                    $have = $db->prepare('SELECT tag FROM devotee_tags WHERE devotee_id = :d');
                    $have->execute([':d' => $id]);
                    $existing = $have->fetchAll(PDO::FETCH_COLUMN);
                    $new      = array_values(array_diff($parsed['ok'], $existing));
                    if (count($existing) + count($new) > DV_TAG_MAX) {
                        dvFlash('error', 'A registration can have at most ' . DV_TAG_MAX . ' tags. Remove some before adding more.');
                    } elseif (!$new) {
                        dvFlash('info', $who . ' already has ' . (count($parsed['ok']) === 1 ? 'that tag' : 'those tags') . '.');
                    } else {
                        // INSERT IGNORE: a double-submitted form or a second admin adding the same tag is not an error.
                        $ins = $db->prepare('INSERT IGNORE INTO devotee_tags (devotee_id, tag, created_by, created_at) VALUES (:d, :t, :by, UTC_TIMESTAMP())');
                        foreach ($new as $t) {
                            $ins->execute([':d' => $id, ':t' => $t, ':by' => mb_substr($actor, 0, 120)]);
                        }
                        adminAudit('devotee.tags', $tagSubject, 'Added tag' . (count($new) === 1 ? ' ' : 's ') . implode(', ', $new) . ' to registration #' . $id);
                        dvFlash('success', 'Tagged ' . $who . ' as ' . implode(', ', $new) . '.');
                    }
                }
            } else {
                $t = mb_strtolower(is_string($_POST['tag'] ?? null) ? trim($_POST['tag']) : '');
                if (!preg_match(DV_TAG_RE, $t)) {
                    dvFlash('error', 'That is not a valid tag.');
                } else {
                    $del = $db->prepare('DELETE FROM devotee_tags WHERE devotee_id = :d AND tag = :t');
                    $del->execute([':d' => $id, ':t' => $t]);
                    if ($del->rowCount() > 0) {
                        adminAudit('devotee.tags', $tagSubject, 'Removed tag ' . $t . ' from registration #' . $id);
                        dvFlash('success', 'Removed the tag ' . $t . ' from ' . $who . '.');
                    } else {
                        dvFlash('info', $who . ' did not have the tag ' . $t . '.');
                    }
                }
            }
            dvGo($tagsBack);
        } else {
            http_response_code(400);
            $msg = '<p class="alert alert--error" role="alert">That action is not available on this page.</p>';
        }
    } catch (DomainException $e) {
        // A refusal the committee can act on (someone else changed or removed the
        // registration meanwhile, a member limit, a merge into itself).
        dvFlash('error', $e->getMessage());
        dvGo(registrationLoad($db, $id) ? $editUrl : $listUrl);
    }
}

/* ── CSV exports: respect the active filters and sort ───────────────────── */
$export = $str('export');
if ($export === 'csv' || $export === 'members_csv') {
    if (!adminCan('export')) adminDeny('export');
    [$whereSql, $params] = dvFilterSql($q, $country, $tag, $status);
    // Ties (families registered in the same second, or sharing a name) follow the
// same direction by id, so "oldest first" really is oldest first.
$orderSql = ' ORDER BY d.' . $sortCol . ' ' . strtoupper($dir) . ', d.id ' . strtoupper($dir);

    // Every header before the first byte of the file.
    header('Content-Type: text/csv; charset=utf-8');
    header('Cache-Control: no-store');
    header('Content-Disposition: attachment; filename="' . ($export === 'csv' ? 'family-registrations-' : 'family-members-') . date('Y-m-d') . '.csv"');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF"); // BOM so Excel reads Tamil correctly
    // Every cell goes through registrationCsvCell(): registrations are typed by
    // the public, and a cell starting = + - @ would run as a formula.
    $put = static function (array $cells) use ($out): void {
        fputcsv($out, array_map('registrationCsvCell', $cells), ',', '"', '');
    };

    if ($export === 'csv') {
        $members = [];
        $stmt = $db->prepare(
            'SELECT m.devotee_id, m.name, m.relationship, m.age FROM devotee_family_members m
               JOIN devotees d ON d.id = m.devotee_id' . $whereSql . ' ORDER BY m.devotee_id, m.sort_order, m.id'
        );
        $stmt->execute($params);
        foreach ($stmt->fetchAll() as $m) $members[(int) $m['devotee_id']][] = $m;

        $cols = ['id', 'name', 'date_of_birth', 'phone', 'phone_country', 'email', 'lang', 'address1', 'address2', 'city', 'state',
                 'country', 'postcode', 'consent', 'updates_consent_at', 'updates_consent_by', 'unsubscribed_at', 'duplicate_of',
                 'is_active', 'created_at', 'member_count', 'members'];
        $select = 'd.id, d.name, d.date_of_birth, d.phone, d.phone_country, d.email, d.lang, d.address1, d.address2, d.city, d.state,
                   d.country, d.postcode, d.updates_consent_at, d.updates_consent_by, d.unsubscribed_at, d.duplicate_of, d.is_active, d.created_at';
        if ($hasTags) {
            // Space-separated, the way a tag list reads in a spreadsheet cell.
            $select .= ", (SELECT GROUP_CONCAT(dt.tag ORDER BY dt.tag SEPARATOR ' ') FROM devotee_tags dt WHERE dt.devotee_id = d.id) AS tags";
            $cols[]  = 'tags';
        }
        $put($cols);
        $stmt = $db->prepare('SELECT ' . $select . ' FROM devotees d' . $whereSql . $orderSql);
        $stmt->execute($params);
        while ($r = $stmt->fetch()) {
            $family          = $members[(int) $r['id']] ?? [];
            $r['consent']      = !empty($r['unsubscribed_at']) ? 'unsubscribed' : (!empty($r['updates_consent_at']) ? 'yes' : 'no');
            $r['member_count'] = count($family);
            $r['members']      = registrationMembersText($family);
            $put(array_map(static fn(string $c) => $r[$c] ?? '', $cols));
        }
    } else {
        $put(['registration_id', 'registrant', 'registrant_phone', 'member_position', 'member_name', 'relationship', 'relationship_en', 'relationship_ta', 'age']);
        $stmt = $db->prepare(
            'SELECT d.id AS registration_id, d.name AS registrant, d.phone, m.name, m.relationship, m.age
               FROM devotee_family_members m JOIN devotees d ON d.id = m.devotee_id' . $whereSql
            . $orderSql . ', m.sort_order, m.id'
        );
        $stmt->execute($params);
        $position = [];
        while ($r = $stmt->fetch()) {
            $rid = (int) $r['registration_id'];
            $position[$rid] = ($position[$rid] ?? 0) + 1;
            $put([$rid, $r['registrant'], $r['phone'], $position[$rid], $r['name'], $r['relationship'],
                  registrationRelationshipLabel($r['relationship'], 'en'), registrationRelationshipLabel($r['relationship'], 'ta'), $r['age']]);
        }
    }
    fclose($out);
    exit;
}

/* ── Flash from a previous redirect ─────────────────────────────────────── */
$flash = $_SESSION['flash_devotees'] ?? null;
unset($_SESSION['flash_devotees']);
if (is_array($flash) && count($flash) === 2) {
    [$tone, $text] = $flash;
    $tone = in_array($tone, ['success', 'error', 'warning', 'info'], true) ? $tone : 'info';
    $msg .= '<p class="alert alert--' . $tone . '" role="' . ($tone === 'error' ? 'alert' : 'status') . '">' . h((string) $text) . '</p>';
}

$editing = $editId > 0 ? registrationLoad($db, $editId) : null;
if ($editId > 0 && !$editing) {
    $msg .= '<p class="alert alert--warning" role="status">That registration no longer exists. It may have been merged or deleted.</p>';
}

/* ══════════════════════════════════════════════════════════════════════════
   One registration: details, family members, duplicates and tags
   ══════════════════════════════════════════════════════════════════════════ */
if ($editing) {
    $id        = (int) $editing['id'];
    $editUrl   = $editUrlFor($id);
    $members   = registrationMembers($db, $id);
    $samePhone = registrationSamePhone($db, $id, $editing['phone'], $editing['phone_country']);
    $dupOf     = $editing['duplicate_of'] !== null ? (int) $editing['duplicate_of'] : null;
    $active    = (int) $editing['is_active'] === 1;
    $age       = registrationAgeFrom($editing['date_of_birth']);

    // Bookings and donations linked to this person's old website account. No new
    // links are made, but a merge keeps these, so the office should see them.
    $legacy = ['seva_bookings' => 0, 'donations' => 0];
    foreach (array_keys($legacy) as $table) {
        if (!publicGuardHasColumn($table, 'devotee_id')) continue;
        $stmt = $db->prepare("SELECT COUNT(*) FROM `$table` WHERE devotee_id = :d");
        $stmt->execute([':d' => $id]);
        $legacy[$table] = (int) $stmt->fetchColumn();
    }

    $editingTags = [];
    $tagsInUse   = [];
    if ($hasTags) {
        $stmt = $db->prepare('SELECT tag FROM devotee_tags WHERE devotee_id = :d ORDER BY tag');
        $stmt->execute([':d' => $id]);
        $editingTags = $stmt->fetchAll(PDO::FETCH_COLUMN);
        foreach ($db->query('SELECT tag, COUNT(*) AS n FROM devotee_tags GROUP BY tag ORDER BY n DESC, tag LIMIT 300') as $r) {
            $tagsInUse[(string) $r['tag']] = (int) $r['n'];
        }
    }

    // A failed Save shows what was typed; otherwise the registration as stored.
    $f      = $form !== null && $form['id'] === $id ? $form : null;
    $errors = $f['errors'] ?? [];
    $val    = static function (string $postKey, ?string $stored) use ($f): string {
        if ($f === null) return (string) ($stored ?? '');
        $v = $f['post'][$postKey] ?? '';
        return is_string($v) ? $v : '';
    };
    $err = static fn(string $key): string => (string) ($errors[$key] ?? '');
    $memberRows = $f !== null ? $f['members'] : array_map(static fn(array $m): array => [
        'id' => (int) $m['id'], 'name' => (string) $m['name'], 'relationship' => (string) $m['relationship'],
        'age' => $m['age'] === null ? '' : (string) $m['age'], 'remove' => false,
    ], $members);
    $consentTicked = $f !== null ? $f['consent'] : registrationHasConsent($editing);
    $disabled      = $canEdit ? '' : ' disabled';
    $inForm        = static fn(): string => csrfField() . '<input type="hidden" name="id" value="' . $id . '" />';

    adminHeader($canEdit ? 'Edit registration' : 'Registration details', 'Family Registrations', [
        'actions' => '<a href="' . h($listUrl) . '" class="btn btn-ghost btn--sm">' . adminIcon('arrow-left') . 'All registrations</a>',
    ]);
    echo $msg;
    ?>

<section class="card card--static reg-summary" aria-labelledby="reg-title">
  <div class="card__body">
    <div class="reg-summary__head">
      <div>
        <h2 class="reg-summary__title" id="reg-title"><?= h($editing['name']) ?></h2>
        <p class="reg-summary__meta">
          Registration #<?= $id ?> · Registered <?= adminFmtDate($editing['created_at']) ?><?= $age !== null ? ' · Age ' . $age : '' ?> · Writes in <?= h(dvLangLabel($editing['lang'])) ?>
        </p>
        <div class="reg-badges">
          <?= dvConsentBadge($editing) ?>
          <?php if ($dupOf !== null): ?><?= adminBadge('Possible duplicate of #' . $dupOf, 'warning') ?><?php endif; ?>
          <?php if (!$active): ?><?= adminBadge('Archived', 'danger') ?><?php endif; ?>
        </div>
      </div>
      <?php if ($canEdit): ?>
      <div class="cluster">
        <form method="POST" action="<?= h($editUrl) ?>" class="reg-inline-form">
          <?= $inForm() ?>
          <input type="hidden" name="action" value="<?= $active ? 'archive' : 'restore' ?>" />
          <?php if ($active): ?>
            <button type="submit" class="btn btn--sm" data-confirm="<?= h('Archive ' . $editing['name'] . "'s registration? It stays on file, and temple updates stop until it is restored.") ?>" data-confirm-label="Archive"><?= adminIcon('lock') ?> Archive</button>
          <?php else: ?>
            <button type="submit" class="btn btn--sm"><?= adminIcon('undo') ?> Restore</button>
          <?php endif; ?>
        </form>
        <form method="POST" action="<?= h($editUrl) ?>" class="reg-inline-form">
          <?= $inForm() ?>
          <input type="hidden" name="action" value="delete" />
          <button type="submit" class="btn btn-danger btn--sm" data-confirm="<?= h('Delete ' . $editing['name'] . "'s registration" . ($members ? ' and its ' . dvCount(count($members), 'family member', 'family members') : '') . '? This cannot be undone.') ?>" data-confirm-label="Delete"><?= adminIcon('trash') ?> Delete registration</button>
        </form>
      </div>
      <?php endif; ?>
    </div>
    <dl class="dl-grid mt-4">
      <dt>Family</dt>
      <dd><?= $members ? 'The registrant and ' . h(dvCount(count($members), 'family member', 'family members')) : 'The registrant only; no family members added' ?></dd>
      <dt>Temple updates</dt>
      <dd><?= h(dvConsentText($editing)) ?></dd>
      <?php if ($legacy['seva_bookings'] || $legacy['donations']): ?>
      <dt>Older records</dt>
      <dd><?= h(dvCount($legacy['seva_bookings'], 'seva booking', 'seva bookings') . ' and ' . dvCount($legacy['donations'], 'donation', 'donations')) ?> linked to this person's old website account.</dd>
      <?php endif; ?>
    </dl>
  </div>
</section>

<div class="reg-view">
  <div class="reg-view__main">
    <section class="card card--static" aria-labelledby="reg-form-title">
      <div class="card__head"><h2 id="reg-form-title"><?= adminIcon($canEdit ? 'pencil' : 'eye', 'ico--sm') ?> Registration details</h2></div>
      <div class="card__body">
        <?php if (!$canEdit): ?>
          <p class="field__hint mb-4">Your role can read this registration but not change it.</p>
        <?php endif; ?>
        <form method="POST" action="<?= h($editUrl) ?>" class="stack reg-form" id="reg-form" novalidate>
          <?= $inForm() ?>
          <input type="hidden" name="action" value="save" />

          <?php if ($errors): ?>
          <div class="alert alert--error reg-error-summary" role="alert" tabindex="-1" id="reg-errors" data-keep data-focus-on-load>
            <div>
              <p><strong><?= h(dvCount(count($errors), 'thing needs', 'things need')) ?> correcting before this registration can be saved. Nothing has been saved yet.</strong></p>
              <ul>
                <?php foreach ($errors as $key => $message):
                    $prefix = preg_match('/^members\.(\d+)\./', (string) $key, $mm) ? 'Family member ' . ((int) $mm[1] + 1) . ': ' : ''; ?>
                  <li><a href="#<?= h(dvFieldId((string) $key)) ?>"><?= h($prefix . $message) ?></a></li>
                <?php endforeach; ?>
              </ul>
            </div>
          </div>
          <?php endif; ?>

          <fieldset<?= $disabled ?>>
            <legend>Personal details</legend>
            <?= dvInput('d-name', 'name', 'Full name', $val('name', $editing['name']), [
                'required' => true, 'error' => $err('name'),
                'attrs'    => ['maxlength' => (string) REG_LENGTHS['name'][1], 'autocomplete' => 'off'],
            ]) ?>
            <div class="form-grid">
              <?= dvInput('d-phone', 'phone', 'Phone number', $val('phone', dvPhoneDisplay($editing['phone'])), [
                  'required' => true, 'error' => $err('phone'),
                  'hint'     => 'The full international number, such as +919876543210.',
                  'attrs'    => ['type' => 'tel', 'maxlength' => '24', 'autocomplete' => 'off', 'inputmode' => 'tel'],
              ]) ?>
              <?= dvInput('d-pcountry', 'phone_country', "Phone number's country", $val('phone_country', $editing['phone_country']), [
                  'optional' => true, 'hint' => 'Two letters, such as IN, SG or GB.',
                  'attrs'    => ['maxlength' => '2', 'class' => 'input--code', 'autocomplete' => 'off', 'spellcheck' => 'false'],
              ]) ?>
            </div>
            <div class="form-grid">
              <?= dvInput('d-email', 'email', 'Email address', $val('email', $editing['email']), [
                  'optional' => true, 'error' => $err('email'),
                  'hint'     => 'Only if the family would like receipts or notices by email.',
                  'attrs'    => ['type' => 'email', 'maxlength' => '190', 'autocomplete' => 'off', 'spellcheck' => 'false', 'autocapitalize' => 'off'],
              ]) ?>
              <?= dvInput('d-dob', 'date_of_birth', 'Date of birth', $val('date_of_birth', $editing['date_of_birth']), [
                  'optional' => true, 'error' => $err('dateOfBirth'),
                  'hint'     => $age !== null && $f === null ? 'Age ' . $age . ' today.' : 'Not in the future, and no more than ' . REG_MAX_AGE . ' years ago.',
                  'attrs'    => ['type' => 'date', 'max' => registrationTempleToday(),
                                 'min' => (new DateTimeImmutable(registrationTempleToday()))->modify('-' . REG_MAX_AGE . ' years')->format('Y-m-d')],
              ]) ?>
            </div>
            <?= dvSelect('d-lang', 'lang', 'Language the temple writes in', $val('lang', $editing['lang']), ['ta' => 'Tamil', 'en' => 'English'], [
                'required' => true, 'error' => $err('lang'),
            ]) ?>
          </fieldset>

          <fieldset<?= $disabled ?>>
            <legend>Home address</legend>
            <?= dvInput('d-addr1', 'address1', 'House number and street', $val('address1', $editing['address1']), [
                'required' => true, 'error' => $err('address1'),
                'attrs'    => ['maxlength' => (string) REG_LENGTHS['address1'][1], 'autocomplete' => 'off'],
            ]) ?>
            <?= dvInput('d-addr2', 'address2', 'Area or landmark', $val('address2', $editing['address2']), [
                'optional' => true, 'error' => $err('address2'),
                'attrs'    => ['maxlength' => (string) REG_LENGTHS['address2'][1], 'autocomplete' => 'off'],
            ]) ?>
            <div class="form-grid">
              <?= dvInput('d-city', 'city', 'City or town', $val('city', $editing['city']), [
                  'required' => true, 'error' => $err('city'),
                  'attrs'    => ['maxlength' => (string) REG_LENGTHS['city'][1], 'autocomplete' => 'off'],
              ]) ?>
              <?= dvInput('d-country', 'country', 'Country', $val('country', $editing['country']), [
                  'required' => true, 'error' => $err('country'), 'hint' => 'Two letters, such as IN for India.',
                  'attrs'    => ['maxlength' => '2', 'class' => 'input--code', 'autocomplete' => 'off', 'spellcheck' => 'false'],
              ]) ?>
            </div>
            <div class="form-grid">
              <?= dvInput('d-state', 'state', 'State or province', $val('state', $editing['state']), [
                  'error' => $err('state'),
                  'hint'  => 'Needed where the public form offers a list (India among them); use its code, such as TN for Tamil Nadu.',
                  'attrs' => ['maxlength' => (string) REG_LENGTHS['state'][1], 'autocomplete' => 'off'],
              ]) ?>
              <?= dvInput('d-postcode', 'postcode', 'PIN or postal code', $val('postcode', $editing['postcode']), [
                  'error' => $err('postcode'), 'hint' => 'Needed for India: 6 digits. Optional elsewhere.',
                  'attrs' => ['maxlength' => '20', 'autocomplete' => 'off', 'inputmode' => 'text'],
              ]) ?>
            </div>
          </fieldset>

          <?php
            [$membersDescribed, $membersAfter] = dvDescribe('d-members', '', $err('members'));
            $listed = count($memberRows);
            $blankIndex = $listed;
          ?>
          <fieldset id="d-members"<?= $disabled ?> aria-describedby="d-members-intro<?= $err('members') !== '' ? ' d-members-err' : '' ?>">
            <legend>Family members</legend>
            <p class="field__hint" id="d-members-intro">
              The registrant is not listed here. A family can have no members, or up to <?= REG_MAX_MEMBERS ?>.
              <?= $canEdit ? 'Leave the blank row empty to add nobody.' : '' ?>
            </p>
            <?= $membersAfter ?>
            <?php if (!$memberRows && !$canEdit): ?>
              <p class="reg-consent">No family members added.</p>
            <?php endif; ?>
            <ol class="reg-members__list" data-repeat-list="members">
              <?php foreach ($memberRows as $i => $row): ?>
                <?= dvMemberRow((string) $i, $row, $errors, $row['id'] > 0 ? 'Family member ' . ($i + 1) : 'New family member', $canEdit && $row['id'] > 0) ?>
              <?php endforeach; ?>
              <?php if ($canEdit && $listed < REG_MAX_MEMBERS): ?>
                <?= dvMemberRow((string) $blankIndex, ['id' => 0, 'name' => '', 'relationship' => '', 'age' => '', 'remove' => false], [], 'New family member', false) ?>
              <?php endif; ?>
            </ol>
            <?php if ($canEdit): ?>
              <template data-repeat-template="members" data-repeat-next="<?= $blankIndex + 1 ?>">
                <?= dvMemberRow('__N__', ['id' => 0, 'name' => '', 'relationship' => '', 'age' => '', 'remove' => false], [], 'New family member', false, true) ?>
              </template>
              <div class="form-actions">
                <button type="button" class="btn btn--sm" data-repeat-add="members" data-repeat-max="<?= REG_MAX_MEMBERS ?>"
                        data-repeat-added="Added a row for a new family member." data-repeat-removed="Removed the row." hidden><?= adminIcon('plus') ?> Add another family member</button>
              </div>
              <p class="sr-only" aria-live="polite" data-repeat-status="members"></p>
            <?php endif; ?>
          </fieldset>

          <fieldset<?= $disabled ?>>
            <legend>Temple updates</legend>
            <label class="checkbox-label" for="d-consent">
              <input type="checkbox" id="d-consent" name="consent" value="1"<?= $consentTicked ? ' checked' : '' ?> aria-describedby="d-consent-status d-consent-hint" />
              Agrees to festival, pooja and temple updates by WhatsApp, SMS or email
            </label>
            <p class="reg-consent" id="d-consent-status"><?= h(dvConsentText($editing)) ?></p>
            <p class="field__hint" id="d-consent-hint">Tick only when the family has told the temple they agree. Ticking records your name and the time, and lifts an earlier unsubscribe. Messages about their own bookings and donations are sent either way.</p>
          </fieldset>

          <?php if ($canEdit): ?>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> Save registration</button>
            <a href="<?= h($listUrl) ?>" class="btn btn-ghost"><?= adminIcon('x') ?> Cancel</a>
          </div>
          <?php endif; ?>
        </form>
      </div>
    </section>
  </div>

  <div class="reg-view__aside">
    <?php if ($samePhone || $dupOf !== null): ?>
    <section class="card card--static" id="duplicates" aria-labelledby="dupes-title">
      <div class="card__head"><h2 id="dupes-title"><?= adminIcon('copy', 'ico--sm') ?> Possible duplicates</h2></div>
      <div class="card__body stack">
        <p class="reg-consent">
          <?php if ($dupOf !== null): ?>
            Flagged as a possible duplicate of registration #<?= $dupOf ?>, registered earlier with the same phone number.
          <?php else: ?>
            <?= h(dvCount(count($samePhone), 'other registration has', 'other registrations have')) ?> the same phone number.
          <?php endif; ?>
          <?= $canEdit ? 'Merge when they are the same family, clear the flag when they are not, or delete this registration if it was sent twice.' : '' ?>
        </p>
        <?php if ($samePhone): ?>
        <ul class="reg-dupes">
          <?php foreach ($samePhone as $other):
            $oid   = (int) $other['id'];
            $place = implode(', ', array_filter([(string) $other['city'], (string) $other['country']]));
            $meta  = array_filter([
                'Registered ' . adminFmtDate($other['created_at']),
                $place,
                dvCount((int) $other['member_count'], 'family member', 'family members'),
                registrationHasConsent($other) ? 'agreed to updates' : 'no consent',
                (int) $other['is_active'] === 1 ? '' : 'archived',
            ]);
          ?>
          <li class="reg-dupe">
            <div>
              <a class="reg-dupe__name" href="<?= h($editUrlFor($oid)) ?>">#<?= $oid ?> · <?= h($other['name']) ?></a>
              <p class="reg-dupe__meta"><?= h(implode(' · ', $meta)) ?></p>
            </div>
            <?php if ($canEdit): ?>
            <form method="POST" action="<?= h($editUrl) ?>" class="reg-dupe__merge">
              <?= $inForm() ?>
              <input type="hidden" name="action" value="merge" />
              <input type="hidden" name="target" value="<?= $oid ?>" />
              <label class="checkbox-label" for="fill-<?= $oid ?>">
                <input type="checkbox" id="fill-<?= $oid ?>" name="fill_empty" value="1" />
                Fill #<?= $oid ?>'s empty details from this registration
              </label>
              <button type="submit" class="btn btn--sm"
                      data-confirm="<?= h('Merge ' . $editing['name'] . ' (#' . $id . ') into #' . $oid . '? Its family members, tags, linked bookings and donations and message history move to #' . $oid . ', and #' . $id . ' is deleted.') ?>"
                      data-confirm-label="Merge"><?= adminIcon('copy') ?> Merge into #<?= $oid ?></button>
            </form>
            <?php endif; ?>
          </li>
          <?php endforeach; ?>
        </ul>
        <?php endif; ?>
        <?php if ($canEdit): ?>
        <div class="form-actions">
          <?php if ($dupOf !== null): ?>
          <form method="POST" action="<?= h($editUrl) ?>" class="reg-inline-form">
            <?= $inForm() ?>
            <input type="hidden" name="action" value="not_duplicate" />
            <button type="submit" class="btn btn--sm"><?= adminIcon('user-check') ?> Not a duplicate</button>
          </form>
          <?php endif; ?>
          <form method="POST" action="<?= h($editUrl) ?>" class="reg-inline-form">
            <?= $inForm() ?>
            <input type="hidden" name="action" value="delete" />
            <button type="submit" class="btn btn-danger btn--sm" data-confirm="<?= h('Delete ' . $editing['name'] . "'s registration (#" . $id . ')? This cannot be undone.') ?>" data-confirm-label="Delete"><?= adminIcon('trash') ?> Delete this registration</button>
          </form>
        </div>
        <?php endif; ?>
      </div>
    </section>
    <?php endif; ?>

    <?php if ($hasTags): ?>
    <section class="card card--static" aria-labelledby="devotee-tags-title">
      <div class="card__body">
        <div class="devotee-tags" id="devotee-tags" role="group" aria-labelledby="devotee-tags-title">
          <h3 class="subhead" id="devotee-tags-title">Tags</h3>
          <p class="field__hint">Groups this family belongs to, such as volunteer, member or interest:annadanam. A notification audience can be built from a tag.</p>
          <?php if ($editingTags): ?>
            <ul class="devotee-tags__list" aria-label="Tags of <?= h($editing['name']) ?>">
              <?php foreach ($editingTags as $t): ?>
              <li>
                <?php if ($canEdit): ?>
                <form method="POST" action="<?= h($editUrl) ?>">
                  <?= $inForm() ?>
                  <input type="hidden" name="action" value="tag_remove" />
                  <input type="hidden" name="tag" value="<?= h($t) ?>" />
                  <button type="submit" class="chip devotee-tag" aria-label="Remove the tag <?= h($t) ?>" data-no-loading><?= h($t) ?><?= adminIcon('x') ?></button>
                </form>
                <?php else: ?>
                  <span class="chip devotee-tag"><?= h($t) ?></span>
                <?php endif; ?>
              </li>
              <?php endforeach; ?>
            </ul>
          <?php else: ?>
            <p class="field__hint">No tags yet.</p>
          <?php endif; ?>
          <?php if ($canEdit): ?>
          <form method="POST" action="<?= h($editUrl) ?>" class="devotee-tags__add">
            <?= $inForm() ?>
            <input type="hidden" name="action" value="tag_add" />
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
          <?php endif; ?>
        </div>
      </div>
    </section>
    <?php endif; ?>
  </div>
</div>

<?php
    adminFooter();
    exit;
}

/* ══════════════════════════════════════════════════════════════════════════
   The list
   ══════════════════════════════════════════════════════════════════════════ */
[$whereSql, $params]     = dvFilterSql($q, $country, $tag, $status);
[$baseWhere, $baseParams] = dvFilterSql($q, $country, $tag, '');
// Ties (families registered in the same second, or sharing a name) follow the
// same direction by id, so "oldest first" really is oldest first.
$orderSql = ' ORDER BY d.' . $sortCol . ' ' . strtoupper($dir) . ', d.id ' . strtoupper($dir);

$totals = $db->query(
    'SELECT COALESCE(SUM(is_active = 1), 0)                                                             AS families,
            COALESCE(SUM(is_active = 0), 0)                                                             AS archived,
            COALESCE(SUM(is_active = 1 AND duplicate_of IS NOT NULL), 0)                                AS duplicates,
            COALESCE(SUM(is_active = 1 AND updates_consent_at IS NOT NULL AND unsubscribed_at IS NULL), 0) AS consented,
            COALESCE(SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)), 0)                            AS recent
       FROM devotees'
)->fetch();
$memberTotal = (int) $db->query(
    'SELECT COUNT(*) FROM devotee_family_members m JOIN devotees d ON d.id = m.devotee_id AND d.is_active = 1'
)->fetchColumn();

// How many each chip lists under the current search, country and tag.
$chipSql = 'SELECT COUNT(*) AS all_n';
foreach (DV_STATUS_SQL as $key => $condition) $chipSql .= ", COALESCE(SUM($condition), 0) AS $key";
$stmt = $db->prepare($chipSql . ' FROM devotees d' . $baseWhere);
$stmt->execute($baseParams);
$chipCounts = $stmt->fetch();

$result = adminPaginate(
    $db,
    'SELECT d.id, d.name, d.date_of_birth, d.email, d.phone, d.phone_country, d.address1, d.address2, d.city, d.state,
            d.country, d.postcode, d.lang, d.updates_consent_at, d.updates_consent_by, d.unsubscribed_at, d.duplicate_of,
            d.is_active, d.created_at,
            (SELECT COUNT(*) FROM devotee_family_members cm WHERE cm.devotee_id = d.id) AS member_count
       FROM devotees d' . $whereSql . $orderSql,
    $params,
    $page,
    DV_PER_PAGE
);
$rows = $result['rows'];
$ids  = array_map(static fn(array $r): int => (int) $r['id'], $rows);

// The first few members' names for each row, and each row's tags, in one query each.
$namesById = [];
$tagsById  = [];
if ($ids) {
    $marks = implode(',', array_fill(0, count($ids), '?'));
    $stmt  = $db->prepare("SELECT devotee_id, name FROM devotee_family_members WHERE devotee_id IN ($marks) ORDER BY devotee_id, sort_order, id");
    $stmt->execute($ids);
    foreach ($stmt->fetchAll() as $r) $namesById[(int) $r['devotee_id']][] = (string) $r['name'];
    if ($hasTags) {
        $stmt = $db->prepare("SELECT devotee_id, tag FROM devotee_tags WHERE devotee_id IN ($marks) ORDER BY tag");
        $stmt->execute($ids);
        foreach ($stmt->fetchAll() as $r) $tagsById[(int) $r['devotee_id']][] = (string) $r['tag'];
    }
}
$tagsInUse = [];
if ($hasTags) {
    foreach ($db->query('SELECT tag, COUNT(*) AS n FROM devotee_tags GROUP BY tag ORDER BY n DESC, tag LIMIT 300') as $r) {
        $tagsInUse[(string) $r['tag']] = (int) $r['n'];
    }
}
// Countries present, for the filter: only ones that actually have registrations.
$countries = [];
foreach ($db->query('SELECT country, COUNT(*) n FROM devotees WHERE country IS NOT NULL GROUP BY country ORDER BY n DESC, country') as $r) {
    $countries[(string) $r['country']] = (int) $r['n'];
}

$exportFamilies = DV_BASE . adminQuery($query, ['export' => 'csv']);
$exportMembers  = DV_BASE . adminQuery($query, ['export' => 'members_csv']);
$statusChips = [
    ''           => ['All', (int) $chipCounts['all_n']],
    'duplicates' => ['Possible duplicates', (int) $chipCounts['duplicates']],
    'consented'  => ['Agreed to updates', (int) $chipCounts['consented']],
    'no_consent' => ['No consent', (int) $chipCounts['no_consent']],
    'archived'   => ['Archived', (int) $chipCounts['archived']],
];

adminHeader('Family Registrations', 'Devotees', [
    'actions' => '<a href="/register" target="_blank" rel="noopener" class="btn btn--sm">' . adminIcon('external') . 'Registration form</a>',
]);
echo $msg;
echo adminPageIntro(
    'Families who registered on the website. Nobody signs in to a registration: a family asks the temple office to change its details, and the office makes the change here. '
    . ($canEdit
        ? 'Open a registration to correct it, change its family members or record consent, and merge or clear possible duplicates.'
        : 'Your role can read and export registrations but not change them.'),
    '<a href="' . h($exportFamilies) . '" class="btn btn-primary btn--sm">' . adminIcon('download') . ($hasFilters ? 'Export filtered families' : 'Export families CSV') . '</a>'
    . '<a href="' . h($exportMembers) . '" class="btn btn--sm">' . adminIcon('download') . 'Export members CSV</a>'
);

echo adminKpi([
    ['icon' => 'users', 'value' => (int) $totals['families'], 'label' => 'Families', 'variant' => 'accent',
     'sub'  => (int) $totals['archived'] > 0 ? dvCount((int) $totals['archived'], 'more archived', 'more archived') : 'Active registrations'],
    ['icon' => 'user', 'value' => $memberTotal, 'label' => 'Family members', 'sub' => 'Besides the registrants'],
    ['icon' => 'alert', 'value' => (int) $totals['duplicates'], 'label' => 'Possible duplicates', 'sub' => 'Same phone number',
     'href' => DV_BASE . '?status=duplicates'],
    ['icon' => 'check-circle', 'value' => (int) $totals['consented'], 'label' => 'Agreed to updates', 'href' => DV_BASE . '?status=consented'],
    ['icon' => 'trending', 'value' => (int) $totals['recent'], 'label' => 'Registered in the last 30 days'],
]);
?>

<nav class="filter-chips mb-4" aria-label="Filter registrations">
  <?php foreach ($statusChips as $value => [$label, $n]): ?>
    <a class="chip" href="<?= h(DV_BASE . adminQuery($query, ['status' => $value, 'page' => null])) ?>"<?= $status === $value ? ' aria-current="page"' : '' ?>><?= h($label) ?><span class="chip__count"><?= $n ?></span></a>
  <?php endforeach; ?>
</nav>

<form method="GET" action="<?= DV_BASE ?>" class="toolbar" role="search" aria-label="Search and filter registrations">
  <input type="hidden" name="sort" value="<?= h($sortCol) ?>" />
  <input type="hidden" name="dir" value="<?= h($dir) ?>" />
  <?php if ($status !== ''): ?><input type="hidden" name="status" value="<?= h($status) ?>" /><?php endif; ?>
  <div class="toolbar__search">
    <?= adminIcon('search') ?>
    <label class="sr-only" for="f-q">Search registrations</label>
    <input id="f-q" type="search" name="q" value="<?= h($q) ?>" maxlength="120" placeholder="Name, family member, phone, email, town, address or PIN…" autocomplete="off" />
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
      <a href="<?= DV_BASE ?>" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Reset</a>
    <?php endif; ?>
  </div>
  <span class="toolbar__count" aria-live="polite"><?= h(dvCount($result['total'], 'registration', 'registrations')) ?></span>
</form>

<?php if ($rows): ?>
<div class="table-wrap">
  <table class="table" data-no-search>
    <caption class="sr-only">Family registrations<?= $hasFilters ? ', filtered' : '' ?></caption>
    <thead>
      <tr>
        <?= adminSortLink('name', 'Registrant', $query) ?>
        <th scope="col">Phone</th>
        <th scope="col">Address</th>
        <th scope="col">Family</th>
        <?php if ($hasTags): ?><th scope="col">Tags</th><?php endif; ?>
        <th scope="col">Updates</th>
        <?= adminSortLink('created_at', 'Registered', $query) ?>
        <th scope="col"><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      <?php foreach ($rows as $row):
        $id       = (int) $row['id'];
        $active   = (int) $row['is_active'] === 1;
        $editHref = $editUrlFor($id);
        $tel      = dvTelHref($row['phone'], $row['phone_country']);
        $email    = (string) ($row['email'] ?? '');
        $age      = registrationAgeFrom($row['date_of_birth']);
        $count    = (int) $row['member_count'];
        $names    = $namesById[$id] ?? [];

        $menu = [['label' => $canEdit ? 'Open and edit' : 'View details', 'href' => $editHref, 'icon' => $canEdit ? 'pencil' : 'eye']];
        if ($canEdit) {
            if ($row['duplicate_of'] !== null) {
                $menu[] = ['label' => 'Review possible duplicate', 'href' => $editHref . '#duplicates', 'icon' => 'copy'];
                $menu[] = ['label' => 'Not a duplicate', 'form' => ['action' => 'not_duplicate', 'id' => $id, 'return' => 'list'], 'icon' => 'user-check'];
            }
            $menu[] = 'divider';
            $menu[] = $active
                ? ['label' => 'Archive', 'form' => ['action' => 'archive', 'id' => $id, 'return' => 'list'], 'icon' => 'lock',
                   'confirm' => 'Archive ' . $row['name'] . "'s registration? It stays on file, and temple updates stop until it is restored.", 'confirmLabel' => 'Archive']
                : ['label' => 'Restore', 'form' => ['action' => 'restore', 'id' => $id, 'return' => 'list'], 'icon' => 'undo'];
            $menu[] = ['label' => 'Delete registration', 'form' => ['action' => 'delete', 'id' => $id, 'return' => 'list'], 'icon' => 'trash', 'danger' => true,
                       'confirm' => 'Delete ' . $row['name'] . "'s registration" . ($count ? ' and its ' . dvCount($count, 'family member', 'family members') : '') . '? This cannot be undone.',
                       'confirmLabel' => 'Delete'];
        }
        if ($tel !== '' || $email !== '') $menu[] = 'divider';
        if ($tel !== '')   $menu[] = ['label' => 'Call', 'href' => $tel, 'icon' => 'phone'];
        if ($email !== '') $menu[] = ['label' => 'Email', 'href' => 'mailto:' . $email, 'icon' => 'mail'];
      ?>
      <tr<?= $active ? '' : ' class="row--muted"' ?>>
        <td>
          <a class="cell-title" href="<?= h($editHref) ?>"><?= h($row['name']) ?></a>
          <?php if ($age !== null): ?><span class="cell-sub">Age <?= $age ?></span><?php endif; ?>
          <?php if ($email !== ''): ?><a class="cell-sub" href="mailto:<?= h($email) ?>"><?= h($email) ?></a><?php endif; ?>
          <?php if ($row['duplicate_of'] !== null || !$active): ?>
            <span class="reg-badges">
              <?php if ($row['duplicate_of'] !== null): ?><?= adminBadge('Possible duplicate of #' . (int) $row['duplicate_of'], 'warning') ?><?php endif; ?>
              <?php if (!$active): ?><?= adminBadge('Archived', 'danger') ?><?php endif; ?>
            </span>
          <?php endif; ?>
        </td>
        <td>
          <?php if ($tel !== ''): ?>
            <a href="<?= h($tel) ?>"><?= h(dvPhoneDisplay($row['phone'])) ?></a>
          <?php else: ?>
            <span class="cell-sub">No number</span>
          <?php endif; ?>
        </td>
        <td>
          <?php
            $street = implode(', ', array_filter([(string) $row['address1'], (string) $row['address2']]));
            $place  = implode(', ', array_filter([(string) $row['city'], (string) $row['state'], (string) $row['country']]));
            $pin    = trim((string) $row['postcode']);
          ?>
          <?= $street !== '' ? h($street) : '<span class="cell-sub">No street address</span>' ?>
          <?php if ($place !== '' || $pin !== ''): ?><span class="cell-sub"><?= h(trim($place . ($pin !== '' ? ' · ' . $pin : ''), ' ·')) ?></span><?php endif; ?>
        </td>
        <td>
          <?php if ($count > 0): ?>
            <span class="cell-num"><?= h(dvCount($count, 'member', 'members')) ?></span>
            <span class="cell-sub reg-family-names"><?= h(implode(', ', array_slice($names, 0, 3)) . ($count > 3 ? ' and ' . ($count - 3) . ' more' : '')) ?></span>
          <?php else: ?>
            <span class="cell-sub">No members added</span>
          <?php endif; ?>
        </td>
        <?php if ($hasTags): ?>
        <td>
          <?php if (!empty($tagsById[$id])): ?>
            <span class="devotee-tags__chips">
              <?php foreach ($tagsById[$id] as $t): ?>
                <a class="devotee-tag-link" href="<?= h(DV_BASE . adminQuery($query, ['tag' => $t, 'page' => null])) ?>" aria-label="Show registrations tagged <?= h($t) ?>"><?= h($t) ?></a>
              <?php endforeach; ?>
            </span>
          <?php else: ?>
            <span class="cell-sub">None</span>
          <?php endif; ?>
        </td>
        <?php endif; ?>
        <td>
          <?= dvConsentBadge($row) ?>
          <span class="cell-sub">Writes in <?= h(dvLangLabel($row['lang'])) ?></span>
        </td>
        <td class="cell-date">
          <time datetime="<?= h(str_replace(' ', 'T', (string) $row['created_at'])) ?>"><?= adminFmtDate($row['created_at']) ?></time>
          <span class="cell-sub"><?= h(adminAgo($row['created_at'])) ?></span>
        </td>
        <td class="cell-actions"><?= adminMenu($menu, 'Actions for ' . $row['name']) ?></td>
      </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
</div>

<?= adminPagination($result['page'], $result['pages'], $query, $result['total'], DV_PER_PAGE) ?>

<?php elseif ($hasFilters): ?>
  <?= adminEmpty('search', 'No registrations match these filters', 'Try a different search, or clear the filters to see every family.', '<a href="' . DV_BASE . '" class="btn btn-primary btn--sm">' . adminIcon('x') . 'Clear filters</a>') ?>
<?php else: ?>
  <?= adminEmpty('users', 'No families have registered yet', 'When a family fills in the registration form on the website, it appears here with its members.', '<a href="/register" target="_blank" rel="noopener" class="btn btn-primary btn--sm">' . adminIcon('external') . 'View the registration form</a>') ?>
<?php endif; ?>

<?php adminFooter(); ?>
