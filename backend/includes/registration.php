<?php
/**
 * backend/includes/registration.php — the family registration rules, shared by
 * the public form (api/registrations.php) and the committee's admin page
 * (admin/devotees.php), so a family is held to exactly the same rules whoever
 * types it in. docs/registration/SPEC.md §4, §5 and §8 are the contract.
 *
 * A registration is one `devotees` row (the person registering) plus one
 * `devotee_family_members` row per member of their family, if they added any
 * (members are optional). Nobody signs in: the family registers once, and later
 * changes go through the temple office.
 *
 * Everything here reads its input defensively. The public endpoint is posted to
 * by anyone, so a value may arrive as an array, a number, an object or null
 * where a string belongs; each of those is a validation error, never a 500.
 * Lengths are counted in characters after trimming and stripping tags, and an
 * over-long value is an error rather than something silently cut short.
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/public_guard.php';
require_once __DIR__ . '/devotee_notify.php';

/**
 * Relationship to the registrant: stored key => option text. The order is the
 * order of the <select> on the form and in the admin, and must stay identical to
 * RELATIONSHIPS in frontend/src/lib/familyRegistration.js (SPEC §4).
 */
const REG_RELATIONSHIPS = [
    // One key for a wife or a husband: the form asks no gender, so the
    // relationship cannot depend on one either.
    'spouse'          => ['ta' => 'வாழ்க்கைத் துணை (மனைவி / கணவர்)', 'en' => 'Spouse (wife / husband)'],
    'son'             => ['ta' => 'மகன்',        'en' => 'Son'],
    'daughter'        => ['ta' => 'மகள்',        'en' => 'Daughter'],
    'father'          => ['ta' => 'தந்தை',       'en' => 'Father'],
    'mother'          => ['ta' => 'தாய்',        'en' => 'Mother'],
    'brother'         => ['ta' => 'சகோதரர்',     'en' => 'Brother'],
    'sister'          => ['ta' => 'சகோதரி',      'en' => 'Sister'],
    'grandfather'     => ['ta' => 'தாத்தா',      'en' => 'Grandfather'],
    'grandmother'     => ['ta' => 'பாட்டி',      'en' => 'Grandmother'],
    'grandson'        => ['ta' => 'பேரன்',       'en' => 'Grandson'],
    'granddaughter'   => ['ta' => 'பேத்தி',      'en' => 'Granddaughter'],
    'son_in_law'      => ['ta' => 'மருமகன்',     'en' => 'Son-in-law'],
    'daughter_in_law' => ['ta' => 'மருமகள்',     'en' => 'Daughter-in-law'],
    'father_in_law'   => ['ta' => 'மாமனார்',     'en' => 'Father-in-law'],
    'mother_in_law'   => ['ta' => 'மாமியார்',    'en' => 'Mother-in-law'],
    'other_relative'  => ['ta' => 'பிற உறவினர்', 'en' => 'Other relative'],
    'other'           => ['ta' => 'மற்றவர்',     'en' => 'Other'],
];

/**
 * The countries whose state or province is picked from a list on the form: the
 * keys of frontend/src/data/subdivisions.js. For these the state is required;
 * anywhere else it is optional free text, because the form cannot offer a list.
 */
const REG_SUBDIVISION_COUNTRIES = [
    'AE', 'AT', 'AU', 'BD', 'BE', 'BH', 'BR', 'BT', 'CA', 'CH', 'DE', 'DK', 'ES', 'FJ', 'FR', 'GB', 'ID',
    'IE', 'IL', 'IN', 'IT', 'JO', 'KE', 'KW', 'LK', 'MM', 'MU', 'MV', 'MX', 'MY', 'NG', 'NL', 'NO', 'NP',
    'NZ', 'OM', 'PH', 'PK', 'PL', 'PT', 'QA', 'SA', 'SE', 'TH', 'TT', 'TZ', 'US', 'VN', 'ZA',
];

/**
 * The most family members one registration can list. Members are optional, so
 * the least is none; the registrant is never counted as a member.
 */
const REG_MAX_MEMBERS = 20;

/** [min, max] characters for each text field; min 0 means optional. Mirrors LIMITS in familyRegistration.js. */
const REG_LENGTHS = [
    'name'        => [2, 200],
    'email'       => [0, 190],
    'address1'    => [2, 180],
    'address2'    => [0, 180],
    'city'        => [2, 120],
    'state'       => [0, 120],
    'postcode'    => [0, 20],
    'member_name' => [2, 120],
];

/** A member's age, and how far back a date of birth may go, in whole years. */
const REG_MAX_AGE = 120;

/**
 * The temple's time zone. "Today" for a date of birth is the temple's today, so
 * a family registering just after midnight in India can give today's date even
 * while the server's clock (UTC) is still on yesterday.
 */
const REG_TIME_ZONE = 'Asia/Kolkata';

/** The one message a 422 leads with; the per-field messages say what to fix. */
const REG_FIELDS_ERROR = 'Please correct the highlighted fields.';

/* ── Availability ─────────────────────────────────────────────────────────── */

/**
 * True when migration 009 is in place: the members table, the consent column
 * and the date of birth column all exist. Without them a registration would
 * lose its family, its consent or a date the family gave, so the form answers
 * 503 instead of saving part of what was sent.
 */
function registrationReady(): bool
{
    static $ready = null;
    if ($ready !== null) return $ready;
    try {
        getDB()->query('SELECT 1 FROM devotee_family_members LIMIT 0')->closeCursor();
    } catch (Throwable) {
        return $ready = false;
    }
    return $ready = publicGuardHasColumn('devotees', 'updates_consent_at')
        && publicGuardHasColumn('devotees', 'date_of_birth');
}

/** Today's date where the temple is, as YYYY-MM-DD. */
function registrationTempleToday(): string
{
    return (new DateTimeImmutable('now', new DateTimeZone(REG_TIME_ZONE)))->format('Y-m-d');
}

/**
 * Age in whole years on the temple's today, for a YYYY-MM-DD date of birth; null
 * when there is no usable date. Shown in the admin beside the registrant's name.
 */
function registrationAgeFrom(?string $dateOfBirth): ?int
{
    if ($dateOfBirth === null || !isValidDate($dateOfBirth)) return null;
    $today = registrationTempleToday();
    if ($dateOfBirth > $today) return null;
    return (new DateTimeImmutable($dateOfBirth))->diff(new DateTimeImmutable($today))->y;
}

/* ── Reading input ────────────────────────────────────────────────────────── */

/**
 * A text value as the rules measure it: trimmed, tags stripped, never cut.
 * Returns [value, ok]. Missing and null read as '' and are fine; an array, a
 * number, a boolean or bytes that are not UTF-8 read as '' with ok = false, so
 * the caller can report the field instead of storing a stringified array.
 */
function registrationText(array $input, string $key): array
{
    if (!array_key_exists($key, $input) || $input[$key] === null) return ['', true];
    $v = $input[$key];
    if (!is_string($v) || !mb_check_encoding($v, 'UTF-8')) return ['', false];
    return [trim(strip_tags(trim($v))), true];
}

/**
 * The problem with a text value's length, or '' when it is acceptable.
 * $what is how the message names the field ("the name", "address line 1").
 */
function registrationLengthProblem(string $value, string $field, string $what, string $missing): string
{
    [$min, $max] = REG_LENGTHS[$field];
    $len = mb_strlen($value);
    if ($len === 0) return $min > 0 ? $missing : '';
    if ($len < $min) return ucfirst($what) . " must be at least $min characters.";
    if ($len > $max) return ucfirst($what) . " must be at most $max characters.";
    return '';
}

/** The option text of a relationship key, or the key itself for one no longer on the list. */
function registrationRelationshipLabel(?string $key, string $lang = 'en'): string
{
    $key = (string) $key;
    return REG_RELATIONSHIPS[$key][$lang === 'ta' ? 'ta' : 'en'] ?? $key;
}

/* ── Validation ───────────────────────────────────────────────────────────── */

/**
 * An optional date of birth: [YYYY-MM-DD or null, problem or ''].
 *
 * Missing, null and blank all mean "not given". Anything else must be a real
 * calendar date (so "2023-02-30" is refused rather than rolled into March), not
 * after the temple's today, and not more than REG_MAX_AGE years before it.
 */
function registrationDateOfBirth(array $input, string $key = 'dateOfBirth'): array
{
    if (!array_key_exists($key, $input) || $input[$key] === null) return [null, ''];
    $raw = $input[$key];
    if (!is_string($raw)) return [null, 'Enter the date of birth as a date, or leave it blank.'];
    $value = trim($raw);
    if ($value === '') return [null, ''];
    if (!isValidDate($value)) return [null, 'Enter a real date of birth, or leave it blank.'];

    $today = registrationTempleToday();
    if ($value > $today) return [null, 'The date of birth cannot be in the future.'];
    $earliest = (new DateTimeImmutable($today))->modify('-' . REG_MAX_AGE . ' years')->format('Y-m-d');
    if ($value < $earliest) return [null, 'The date of birth cannot be more than ' . REG_MAX_AGE . ' years ago.'];
    return [$value, ''];
}

/**
 * The registrant's own details, validated (SPEC §5).
 *
 * $input uses the public API's keys: name, dateOfBirth, phone, phoneCountry,
 * email, lang, address1, address2, city, state, country, postcode. The admin
 * maps its form onto the same keys so both are held to one set of rules. Any
 * other key (a `gender` sent by an old client, say) is simply never read.
 *
 * Returns ['values' => [...], 'errors' => [key => message]]. Values are ready
 * to store under their column names: optional text left blank is null.
 */
function registrationValidateDetails(array $input): array
{
    $errors = [];
    $values = [];

    [$name, $ok] = registrationText($input, 'name');
    $errors['name'] = $ok
        ? registrationLengthProblem($name, 'name', 'the name', 'Please enter your name.')
        : 'Please enter your name.';
    $values['name'] = $name;

    [$values['date_of_birth'], $errors['dateOfBirth']] = registrationDateOfBirth($input);

    // A phone typed as a JSON number is still a phone number; an array is not.
    $rawPhone   = is_string($input['phone'] ?? null) || is_int($input['phone'] ?? null) ? $input['phone'] : '';
    $rawCountry = is_string($input['phoneCountry'] ?? null) ? $input['phoneCountry'] : null;
    if (is_string($rawPhone) && !mb_check_encoding($rawPhone, 'UTF-8')) $rawPhone = '';
    $ph = normalizePhone($rawPhone, $rawCountry, true);
    $errors['phone']         = $ph['error'];
    $values['phone']         = $ph['phone'];
    $values['phone_country'] = $ph['country'];

    [$email, $ok] = registrationText($input, 'email');
    $email = mb_strtolower($email);
    if (!$ok) {
        $errors['email'] = 'Enter a valid email address, or leave it blank.';
    } elseif ($email !== '' && mb_strlen($email) > REG_LENGTHS['email'][1]) {
        $errors['email'] = 'The email address must be at most ' . REG_LENGTHS['email'][1] . ' characters.';
    } elseif ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        $errors['email'] = 'Enter a valid email address, or leave it blank.';
    }
    $values['email'] = $email !== '' ? $email : null;

    $lang = $input['lang'] ?? null;
    if ($lang !== 'ta' && $lang !== 'en') {
        $errors['lang'] = 'Choose Tamil or English.';
    }
    $values['lang'] = $lang === 'en' ? 'en' : 'ta';

    [$address1, $ok] = registrationText($input, 'address1');
    $errors['address1'] = $ok
        ? registrationLengthProblem($address1, 'address1', 'address line 1', 'Please enter the house number and street.')
        : 'Please enter the house number and street.';
    $values['address1'] = $address1;

    [$address2, $ok] = registrationText($input, 'address2');
    $errors['address2'] = $ok
        ? registrationLengthProblem($address2, 'address2', 'the area or landmark', '')
        : 'Enter the area or landmark as text, or leave it blank.';
    $values['address2'] = $address2 !== '' ? $address2 : null;

    [$city, $ok] = registrationText($input, 'city');
    $errors['city'] = $ok
        ? registrationLengthProblem($city, 'city', 'the city or town', 'Please enter the city or town.')
        : 'Please enter the city or town.';
    $values['city'] = $city;

    $country = is_string($input['country'] ?? null) ? normalizeCountry($input['country']) : null;
    if ($country === null) $errors['country'] = 'Please choose a country.';
    $values['country'] = $country;

    [$state, $ok] = registrationText($input, 'state');
    $needsState = $country !== null && in_array($country, REG_SUBDIVISION_COUNTRIES, true);
    if (!$ok) {
        $errors['state'] = $needsState ? 'Please choose a state or province.' : 'Enter the state or province as text, or leave it blank.';
    } elseif ($state === '' && $needsState) {
        $errors['state'] = 'Please choose a state or province.';
    } else {
        $errors['state'] = registrationLengthProblem($state, 'state', 'the state or province', '');
    }
    $values['state'] = $state !== '' ? $state : null;

    // India Post delivers by PIN, so an Indian address needs one, and every PIN is
    // six digits that never start with 0 ("627 719" is accepted and stored as
    // 627719). Many other countries have no postal code at all, so elsewhere it
    // is optional and only its shape is checked.
    [$postcode, $ok] = registrationText($input, 'postcode');
    if ($country === 'IN') {
        $postcode = $ok ? (preg_replace('/\s+/u', '', $postcode) ?? '') : '';
        if (!$ok || $postcode === '') {
            $errors['postcode'] = 'Please enter the 6-digit PIN code.';
        } elseif (!preg_match('/^[1-9][0-9]{5}$/', $postcode)) {
            $errors['postcode'] = 'A PIN code is 6 digits and does not start with 0.';
        }
    } elseif (!$ok) {
        $errors['postcode'] = 'Enter the postal code as letters and digits, or leave it blank.';
    } elseif ($postcode !== '' && mb_strlen($postcode) > REG_LENGTHS['postcode'][1]) {
        $errors['postcode'] = 'The postal code must be at most ' . REG_LENGTHS['postcode'][1] . ' characters.';
    } elseif ($postcode !== '' && !preg_match('/^[A-Za-z0-9][A-Za-z0-9 -]*$/', $postcode)) {
        $errors['postcode'] = 'The postal code can contain only letters, digits, spaces and hyphens.';
    }
    $values['postcode'] = $postcode !== '' ? $postcode : null;

    return ['values' => $values, 'errors' => array_filter($errors, static fn($m) => $m !== '')];
}

/**
 * One family member, validated. $prefix is the key its errors are reported
 * under ("members.3" on the public form, "member" in the admin).
 *
 * Returns ['values' => ['name', 'relationship', 'age' => ?int], 'errors' => [...]].
 */
function registrationValidateMember(mixed $member, string $prefix): array
{
    // A member that is not an object has nothing in it, so it fails like an empty row.
    $m      = is_array($member) && !array_is_list($member) ? $member : [];
    $errors = [];

    [$name, $ok] = registrationText($m, 'name');
    $problem = $ok
        ? registrationLengthProblem($name, 'member_name', "the member's name", "Please enter this family member's name.")
        : "Please enter this family member's name.";
    if ($problem !== '') $errors["$prefix.name"] = $problem;

    $relationship = $m['relationship'] ?? null;
    if (!is_string($relationship) || !isset(REG_RELATIONSHIPS[$relationship])) {
        $errors["$prefix.relationship"] = 'Choose how this person is related to you.';
        $relationship = '';
    }

    // null, "" or a whole number 0–120; "12" counts, 12.5, "abc" and true do not.
    $rawAge = $m['age'] ?? null;
    $age    = null;
    if (is_int($rawAge)) {
        $age = $rawAge;
    } elseif (is_string($rawAge) && trim($rawAge) !== '') {
        $age = preg_match('/^\d{1,3}$/', trim($rawAge)) ? (int) trim($rawAge) : -1;
    } elseif ($rawAge !== null && $rawAge !== '') {
        $age = -1;
    }
    if ($age !== null && ($age < 0 || $age > REG_MAX_AGE)) {
        $errors["$prefix.age"] = 'Enter the age as a whole number from 0 to ' . REG_MAX_AGE . ', or leave it blank.';
        $age = null;
    }

    return ['values' => ['name' => $name, 'relationship' => $relationship, 'age' => $age], 'errors' => $errors];
}

/**
 * The whole family list: 0 to REG_MAX_MEMBERS member objects, each valid.
 * Missing or null is a family that added nobody, which is fine; a string, a
 * number or a single object where the list belongs is not a list at all.
 * Returns ['values' => [member, ...], 'errors' => [...]].
 */
function registrationValidateMembers(mixed $members): array
{
    if ($members === null) {
        return ['values' => [], 'errors' => []];
    }
    if (!is_array($members) || !array_is_list($members)) {
        return ['values' => [], 'errors' => ['members' => 'Send the family members as a list.']];
    }
    if (count($members) > REG_MAX_MEMBERS) {
        return ['values' => [], 'errors' => ['members' => 'A registration can list at most ' . REG_MAX_MEMBERS . ' family members.']];
    }
    $values = [];
    $errors = [];
    foreach ($members as $i => $member) {
        $r        = registrationValidateMember($member, "members.$i");
        $values[] = $r['values'];
        $errors  += $r['errors'];
    }
    return ['values' => $values, 'errors' => $errors];
}

/**
 * A complete public registration: details, consent and members.
 * Returns ['values' => [... 'consent' => bool, 'members' => [...]], 'errors' => [...]].
 */
function registrationValidate(array $input): array
{
    $details = registrationValidateDetails($input);
    $members = registrationValidateMembers($input['members'] ?? null);

    $values            = $details['values'];
    $values['consent'] = publicGuardConsent($input['consent'] ?? null);
    $values['members'] = $members['values'];

    return ['values' => $values, 'errors' => $details['errors'] + $members['errors']];
}

/* ── Duplicates ───────────────────────────────────────────────────────────── */

/**
 * The phone values an earlier registration of this number could be stored as:
 * the E.164 digits, and for an Indian number the bare ten digits every row made
 * before migration 004 holds. A ten-digit Indian number typed without its code
 * is matched against the E.164 form too, so neither spelling hides the other.
 */
function registrationPhoneCandidates(string $phone, ?string $country): array
{
    $digits = preg_replace('/\D+/', '', $phone) ?? '';
    if ($digits === '') return [];
    $out = [$digits, devoteeIntlPhone($digits, $country)];
    foreach ($out as $d) {
        if (strlen($d) === 12 && str_starts_with($d, '91')) $out[] = substr($d, 2);
    }
    return array_values(array_unique($out));
}

/**
 * The id of the earliest registration with the same phone number, or null.
 * $beforeId limits the search to registrations made before that one, which is
 * what keeps "duplicate of" pointing backwards and never round in a circle.
 */
function registrationFindDuplicateOf(PDO $db, string $phone, ?string $country, int $beforeId = 0): ?int
{
    $candidates = registrationPhoneCandidates($phone, $country);
    if (!$candidates) return null;
    $marks = implode(',', array_fill(0, count($candidates), '?'));
    $sql   = "SELECT MIN(id) FROM devotees WHERE phone IN ($marks)";
    $args  = $candidates;
    if ($beforeId > 0) {
        $sql   .= ' AND id < ?';
        $args[] = $beforeId;
    }
    $stmt = $db->prepare($sql);
    $stmt->execute($args);
    $id = $stmt->fetchColumn();
    return $id === null || $id === false ? null : (int) $id;
}

/**
 * Other registrations with this registration's phone number, earliest first,
 * for the admin's duplicates panel.
 */
function registrationSamePhone(PDO $db, int $id, ?string $phone, ?string $country): array
{
    $candidates = registrationPhoneCandidates((string) $phone, $country);
    if (!$candidates) return [];
    $marks = implode(',', array_fill(0, count($candidates), '?'));
    $stmt  = $db->prepare(
        "SELECT d.id, d.name, d.email, d.phone, d.phone_country, d.city, d.state, d.country, d.address1, d.postcode,
                d.is_active, d.duplicate_of, d.created_at, d.updates_consent_at, d.unsubscribed_at,
                (SELECT COUNT(*) FROM devotee_family_members m WHERE m.devotee_id = d.id) AS member_count
           FROM devotees d
          WHERE d.phone IN ($marks) AND d.id <> ?
          ORDER BY d.id"
    );
    $stmt->execute([...$candidates, $id]);
    return $stmt->fetchAll();
}

/* ── Saving a registration ────────────────────────────────────────────────── */

/**
 * Save a validated public registration in one transaction: the registrant, then
 * the members in the order given. A number already on file is saved all the
 * same and flagged for the committee; the same queries run either way, so the
 * response time does not tell anyone the number was known.
 *
 * Returns the new registration's id.
 */
function registrationCreate(PDO $db, array $v): int
{
    $db->beginTransaction();
    try {
        $duplicateOf = registrationFindDuplicateOf($db, $v['phone'], $v['phone_country']);

        $db->prepare(
            'INSERT INTO devotees
                (name, date_of_birth, email, phone, phone_country, duplicate_of, address1, address2, city, state, country, postcode,
                 lang, updates_consent_at, updates_consent_by, is_active)
             VALUES
                (:name, :dob, :email, :phone, :phone_country, :duplicate_of, :address1, :address2, :city, :state, :country, :postcode,
                 :lang, ' . ($v['consent'] ? 'UTC_TIMESTAMP()' : 'NULL') . ', NULL, 1)'
        )->execute([
            ':name'          => $v['name'],
            ':dob'           => $v['date_of_birth'],
            ':email'         => $v['email'],
            ':phone'         => $v['phone'],
            ':phone_country' => $v['phone_country'],
            ':duplicate_of'  => $duplicateOf,
            ':address1'      => $v['address1'],
            ':address2'      => $v['address2'],
            ':city'          => $v['city'],
            ':state'         => $v['state'],
            ':country'       => $v['country'],
            ':postcode'      => $v['postcode'],
            ':lang'          => $v['lang'],
        ]);
        $id = (int) $db->lastInsertId();

        $insert = $db->prepare(
            'INSERT INTO devotee_family_members (devotee_id, name, relationship, age, sort_order)
             VALUES (:d, :n, :r, :a, :o)'
        );
        foreach (array_values($v['members']) as $i => $m) {
            $insert->execute([':d' => $id, ':n' => $m['name'], ':r' => $m['relationship'], ':a' => $m['age'], ':o' => $i]);
        }

        $db->commit();
        return $id;
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
}

/* ══════════════════════════════════════════════════════════════════════════
   The committee's changes (admin/devotees.php, SPEC §8)

   Kept here rather than in the page so every rule a change must keep — the
   member limit, duplicates pointing backwards, a merge losing nothing — is
   in one place and can be exercised without a browser. Each function changes
   the database and returns what happened; the page writes the activity log.
   ══════════════════════════════════════════════════════════════════════════ */

/** Run $work inside one transaction, rolling back on any failure. */
function registrationTransaction(PDO $db, callable $work): mixed
{
    $db->beginTransaction();
    try {
        $result = $work();
        $db->commit();
        return $result;
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
}

/** One registration row, or null. $lock takes a row lock inside a transaction. */
function registrationLoad(PDO $db, int $id, bool $lock = false): ?array
{
    if ($id < 1) return null;
    $stmt = $db->prepare('SELECT * FROM devotees WHERE id = :id' . ($lock ? ' FOR UPDATE' : ''));
    $stmt->execute([':id' => $id]);
    return $stmt->fetch() ?: null;
}

/** A registration's family members in the order they were entered. */
function registrationMembers(PDO $db, int $devoteeId): array
{
    $stmt = $db->prepare(
        'SELECT id, name, relationship, age, sort_order FROM devotee_family_members
          WHERE devotee_id = :d ORDER BY sort_order, id'
    );
    $stmt->execute([':d' => $devoteeId]);
    return $stmt->fetchAll();
}

/** True when this registration's consent to temple updates is in force now. */
function registrationHasConsent(array $row): bool
{
    return !empty($row['updates_consent_at']) && empty($row['unsubscribed_at']);
}

/** True when a table exists; used for the tables older installs may not have. */
function registrationTableExists(PDO $db, string $table): bool
{
    static $cache = [];
    if (isset($cache[$table])) return $cache[$table];
    try {
        $stmt = $db->prepare(
            'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t'
        );
        $stmt->execute([':t' => $table]);
        return $cache[$table] = (int) $stmt->fetchColumn() > 0;
    } catch (Throwable) {
        return $cache[$table] = false;
    }
}

/**
 * Apply the registrant's details and the consent tick box, as the committee
 * recorded them, inside the caller's transaction. $v comes from
 * registrationValidateDetails().
 *
 *   • Ticking consent when it is not in force records it now, in the name of
 *     $actor, and clears an earlier unsubscribe: the family has said yes again,
 *     and the office is recording that. Ticking it when it is already in force
 *     changes nothing, so the original time and source are kept.
 *   • Unticking consent that is in force withdraws it; the activity log keeps
 *     who did so and when. A family that unsubscribed from a message link is
 *     shown unticked already, so saving it unticked leaves that record as it is.
 *   • A changed phone number is checked for duplicates again, against earlier
 *     registrations only, so the flag always points backwards.
 *
 * Returns ['before' => the row as it was, 'changed' => [column, ...],
 * 'consent' => 'recorded'|'withdrawn'|null, 'duplicate_of' => ?int].
 */
function registrationApplyDetails(PDO $db, int $id, array $v, bool $consent, string $actor): array
{
    $row = registrationLoad($db, $id, true);
    if (!$row) throw new DomainException('That registration no longer exists.');

    $fields  = ['name', 'date_of_birth', 'email', 'phone', 'phone_country', 'address1', 'address2', 'city', 'state', 'country', 'postcode', 'lang'];
    $changed = [];
    $sets    = [];
    $params  = [':id' => $id];
    foreach ($fields as $f) {
        if ((string) ($row[$f] ?? '') !== (string) ($v[$f] ?? '')) $changed[] = $f;
        $sets[]        = "$f = :$f";
        $params[":$f"] = $v[$f];
    }

    $duplicateOf = $row['duplicate_of'] !== null ? (int) $row['duplicate_of'] : null;
    if (in_array('phone', $changed, true) || in_array('phone_country', $changed, true)) {
        $duplicateOf    = registrationFindDuplicateOf($db, $v['phone'], $v['phone_country'], $id);
        $sets[]         = 'duplicate_of = :dup';
        $params[':dup'] = $duplicateOf;
    }

    $consentChange = null;
    if ($consent && !registrationHasConsent($row)) {
        $sets[]        = 'updates_consent_at = UTC_TIMESTAMP()';
        $sets[]        = 'updates_consent_by = :by';
        $sets[]        = 'unsubscribed_at = NULL';
        $params[':by'] = mb_substr($actor, 0, 120);
        $consentChange = 'recorded';
    } elseif (!$consent && registrationHasConsent($row)) {
        $sets[]        = 'updates_consent_at = NULL';
        $sets[]        = 'updates_consent_by = NULL';
        $consentChange = 'withdrawn';
    }

    $db->prepare('UPDATE devotees SET ' . implode(', ', $sets) . ' WHERE id = :id')->execute($params);
    return ['before' => $row, 'changed' => $changed, 'consent' => $consentChange, 'duplicate_of' => $duplicateOf];
}

/**
 * The admin's family members table, as posted: one row per member on the form,
 * each ['id' => the member's id, or empty for a new row, 'name', 'relationship',
 * 'age', 'remove' => '1' when ticked]. Posted values can be anything, so each is
 * read as defensively as the public form reads its own.
 *
 *   • A row ticked Remove is removed; a new row ticked Remove is simply dropped.
 *   • A new row left completely empty is dropped too: the form always offers a
 *     blank row, and leaving it blank is not a mistake. Zero members is fine.
 *   • Every other row is validated exactly like a member of the public form,
 *     under "members.{n}", n being its place among the rows shown again.
 *
 * Returns ['rows' => the rows to show again when anything is wrong,
 * 'keep' => [['id' => int, 'name', 'relationship', 'age' => ?int], ...] in order,
 * 'remove' => [member id, ...], 'errors' => [key => message]].
 */
function registrationValidateMemberRows(mixed $posted): array
{
    $out = ['rows' => [], 'keep' => [], 'remove' => [], 'errors' => []];
    if ($posted === null || $posted === '') return $out;
    if (!is_array($posted)) {
        $out['errors']['members'] = 'The family members could not be read. Reload the page and try again.';
        return $out;
    }
    // The form never carries more than the limit and a few blank rows; a post
    // with hundreds of rows is not a family, and is refused before it is read.
    if (count($posted) > REG_MAX_MEMBERS * 3) {
        $out['errors']['members'] = 'A registration can list at most ' . REG_MAX_MEMBERS . ' family members.';
        return $out;
    }

    $seen = [];
    foreach ($posted as $row) {
        if (!is_array($row)) continue;
        $rawId = $row['id'] ?? '';
        $id    = is_string($rawId) && preg_match('/^[1-9][0-9]{0,9}$/', $rawId) ? (int) $rawId : 0;
        // The same member twice on one form is a tampered form; the second copy
        // is read as a new row rather than overwriting the first.
        if ($id > 0 && isset($seen[$id])) $id = 0;
        if ($id > 0) $seen[$id] = true;

        $remove = ($row['remove'] ?? null) === '1';
        $blank  = true;
        foreach (['name', 'relationship', 'age'] as $k) {
            $v = $row[$k] ?? null;
            if ($v !== null && !(is_string($v) && trim($v) === '')) {
                $blank = false;
                break;
            }
        }
        if ($id === 0 && ($blank || $remove)) continue;

        $text = static fn(string $k): string => is_string($row[$k] ?? null) ? $row[$k] : '';
        $pos  = count($out['rows']);
        $out['rows'][] = ['id' => $id, 'name' => $text('name'), 'relationship' => $text('relationship'), 'age' => $text('age'), 'remove' => $remove];
        if ($remove) {
            $out['remove'][] = $id;
            continue;
        }
        $checked        = registrationValidateMember($row, "members.$pos");
        $out['errors'] += $checked['errors'];
        $out['keep'][]  = ['id' => $id] + $checked['values'];
    }

    if (count($out['keep']) > REG_MAX_MEMBERS) {
        $over = count($out['keep']) - REG_MAX_MEMBERS;
        $out['errors']['members'] = 'A registration can list at most ' . REG_MAX_MEMBERS . ' family members. Remove '
            . $over . ' more before saving.';
    }
    return $out;
}

/**
 * Make the family's members exactly the kept rows, in their order, inside the
 * caller's transaction: rows ticked Remove are deleted, existing rows updated
 * where something changed, new rows added. A kept row naming a member this
 * family no longer has means someone changed the family meanwhile, so the whole
 * save is refused rather than guessing.
 *
 * Returns ['added' => [name, ...], 'updated' => [name, ...], 'removed' => [name, ...]].
 */
function registrationApplyMembers(PDO $db, int $devoteeId, array $keep, array $removeIds): array
{
    if (count($keep) > REG_MAX_MEMBERS) {
        throw new DomainException('A registration can list at most ' . REG_MAX_MEMBERS . ' family members.');
    }
    $stmt = $db->prepare(
        'SELECT id, name, relationship, age, sort_order FROM devotee_family_members WHERE devotee_id = :d FOR UPDATE'
    );
    $stmt->execute([':d' => $devoteeId]);
    $existing = [];
    foreach ($stmt->fetchAll() as $m) $existing[(int) $m['id']] = $m;

    $done   = ['added' => [], 'updated' => [], 'removed' => []];
    $delete = $db->prepare('DELETE FROM devotee_family_members WHERE id = :id');
    foreach (array_unique(array_map('intval', $removeIds)) as $memberId) {
        // Already gone (another committee member removed it) is what was wanted.
        if (!isset($existing[$memberId])) continue;
        $delete->execute([':id' => $memberId]);
        $done['removed'][] = (string) $existing[$memberId]['name'];
        unset($existing[$memberId]);
    }

    $update = $db->prepare(
        'UPDATE devotee_family_members SET name = :n, relationship = :r, age = :a, sort_order = :o WHERE id = :id'
    );
    $insert = $db->prepare(
        'INSERT INTO devotee_family_members (devotee_id, name, relationship, age, sort_order) VALUES (:d, :n, :r, :a, :o)'
    );
    foreach (array_values($keep) as $pos => $m) {
        if ($m['id'] > 0) {
            $was = $existing[$m['id']] ?? null;
            if (!$was) {
                throw new DomainException('A family member on this form is no longer on this registration. Reload the page and try again.');
            }
            $same = (string) $was['name'] === $m['name']
                && (string) $was['relationship'] === $m['relationship']
                && ($was['age'] === null ? $m['age'] === null : (int) $was['age'] === $m['age']);
            if ($same && (int) $was['sort_order'] === $pos) continue;
            $update->execute([':n' => $m['name'], ':r' => $m['relationship'], ':a' => $m['age'], ':o' => $pos, ':id' => $m['id']]);
            if (!$same) $done['updated'][] = $m['name'];
        } else {
            $insert->execute([':d' => $devoteeId, ':n' => $m['name'], ':r' => $m['relationship'], ':a' => $m['age'], ':o' => $pos]);
            $done['added'][] = $m['name'];
        }
    }
    return $done;
}

/**
 * The committee's Save on a registration: details, consent and family members
 * in one transaction, so a family is never left half-saved. $memberRows comes
 * from registrationValidateMemberRows().
 *
 * Returns registrationApplyDetails()'s result, plus 'members' =>
 * registrationApplyMembers()'s.
 */
function registrationSave(PDO $db, int $id, array $details, bool $consent, array $memberRows, string $actor): array
{
    return registrationTransaction($db, function () use ($db, $id, $details, $consent, $memberRows, $actor): array {
        $result            = registrationApplyDetails($db, $id, $details, $consent, $actor);
        $result['members'] = registrationApplyMembers($db, $id, $memberRows['keep'], $memberRows['remove']);
        return $result;
    });
}

/** "Not a duplicate": the committee checked, and this registration stands on its own. True when a flag was cleared. */
function registrationClearDuplicate(PDO $db, int $id): bool
{
    $stmt = $db->prepare('UPDATE devotees SET duplicate_of = NULL WHERE id = :id AND duplicate_of IS NOT NULL');
    $stmt->execute([':id' => $id]);
    return $stmt->rowCount() > 0;
}

/** Archive (0) or restore (1). True when the state changed. */
function registrationSetActive(PDO $db, int $id, bool $active): bool
{
    $stmt = $db->prepare('UPDATE devotees SET is_active = :a WHERE id = :id AND is_active <> :b');
    $stmt->execute([':a' => $active ? 1 : 0, ':b' => $active ? 1 : 0, ':id' => $id]);
    return $stmt->rowCount() > 0;
}

/**
 * Registrations flagged as duplicates of $goneId now point at the earliest of
 * themselves instead, so deleting or merging the first of several copies of a
 * number leaves the rest still flagged against each other.
 */
function registrationRepointDuplicates(PDO $db, int $goneId, ?int $to = null): void
{
    $stmt = $db->prepare('SELECT id FROM devotees WHERE duplicate_of = :g ORDER BY id');
    $stmt->execute([':g' => $goneId]);
    $ids = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    if (!$ids) return;

    if ($to !== null) {
        $db->prepare('UPDATE devotees SET duplicate_of = :t WHERE duplicate_of = :g AND id <> :t2')
           ->execute([':t' => $to, ':g' => $goneId, ':t2' => $to]);
        $db->prepare('UPDATE devotees SET duplicate_of = NULL WHERE id = :t AND duplicate_of = :g')
           ->execute([':t' => $to, ':g' => $goneId]);
        return;
    }
    $first = array_shift($ids);
    $db->prepare('UPDATE devotees SET duplicate_of = NULL WHERE id = :f')->execute([':f' => $first]);
    if ($ids) {
        $marks = implode(',', array_fill(0, count($ids), '?'));
        $db->prepare("UPDATE devotees SET duplicate_of = ? WHERE id IN ($marks)")->execute([$first, ...$ids]);
    }
}

/**
 * Delete a registration. Its members, tags and message history go with it (the
 * foreign keys cascade); a legacy booking or donation keeps its own name and
 * phone and simply loses the link. Returns the deleted row.
 */
function registrationDelete(PDO $db, int $id): array
{
    return registrationTransaction($db, function () use ($db, $id): array {
        $row = registrationLoad($db, $id, true);
        if (!$row) throw new DomainException('That registration no longer exists.');
        registrationRepointDuplicates($db, $id);
        $db->prepare('DELETE FROM devotees WHERE id = :id')->execute([':id' => $id]);
        return $row;
    });
}

/**
 * Merge registration $sourceId into $targetId, in one transaction, and delete
 * the source. Nothing that hangs off the source is lost:
 *
 *   1. its family members join the target's, after the target's own;
 *   2. its tags are added to the target's (a tag both have is kept once);
 *   3. legacy seva booking and donation links, which would otherwise quietly
 *      unlink, and its notification history, which would otherwise be deleted
 *      with it, move to the target;
 *   4. when $fillEmpty, each of the target's empty details is filled from the
 *      source — never overwriting what the target already has. Consent counts
 *      as a detail: the target takes the source's consent only when it has none
 *      of its own and the source's is still in force;
 *   5. an unsubscribe on the source is kept on the target when it is newer than
 *      the target's own consent, because a family that said stop must not start
 *      receiving updates because two records were joined;
 *   6. registrations flagged as duplicates of the source now point at the target.
 *
 * Returns counts of what moved, for the flash message and the activity log.
 */
function registrationMerge(PDO $db, int $sourceId, int $targetId, bool $fillEmpty): array
{
    if ($sourceId === $targetId) throw new DomainException('A registration cannot be merged into itself.');

    return registrationTransaction($db, function () use ($db, $sourceId, $targetId, $fillEmpty): array {
        // Lock in id order so two merges of the same pair cannot deadlock.
        $first  = registrationLoad($db, min($sourceId, $targetId), true);
        $second = registrationLoad($db, max($sourceId, $targetId), true);
        $source = $sourceId < $targetId ? $first : $second;
        $target = $sourceId < $targetId ? $second : $first;
        if (!$source) throw new DomainException('The registration being merged no longer exists.');
        if (!$target) throw new DomainException('Registration #' . $targetId . ' no longer exists, so nothing was merged.');

        $moved = ['members' => 0, 'tags' => 0, 'bookings' => 0, 'donations' => 0, 'notifications' => 0, 'filled' => []];

        // 1. Members, appended after the target's own.
        $last = $db->prepare('SELECT COALESCE(MAX(sort_order), -1) FROM devotee_family_members WHERE devotee_id = :t');
        $last->execute([':t' => $targetId]);
        $offset = (int) $last->fetchColumn() + 1;
        $stmt = $db->prepare('UPDATE devotee_family_members SET devotee_id = :t, sort_order = sort_order + :o WHERE devotee_id = :s');
        $stmt->execute([':t' => $targetId, ':o' => $offset, ':s' => $sourceId]);
        $moved['members'] = $stmt->rowCount();

        // 2. Tags. INSERT IGNORE keeps one copy of a tag both carry.
        if (registrationTableExists($db, 'devotee_tags')) {
            $stmt = $db->prepare(
                'INSERT IGNORE INTO devotee_tags (devotee_id, tag, created_by, created_at)
                 SELECT :t, tag, created_by, created_at FROM devotee_tags WHERE devotee_id = :s'
            );
            $stmt->execute([':t' => $targetId, ':s' => $sourceId]);
            $moved['tags'] = $stmt->rowCount();
        }

        // 3. Legacy links and message history.
        foreach (['seva_bookings' => 'bookings', 'donations' => 'donations', 'notifications' => 'notifications'] as $table => $key) {
            if (!publicGuardHasColumn($table, 'devotee_id')) continue;
            $stmt = $db->prepare("UPDATE `$table` SET devotee_id = :t WHERE devotee_id = :s");
            $stmt->execute([':t' => $targetId, ':s' => $sourceId]);
            $moved[$key] = $stmt->rowCount();
        }

        // 4. Empty details, only when asked.
        $sets   = [];
        $params = [':id' => $targetId];
        if ($fillEmpty) {
            foreach (['date_of_birth', 'email', 'address1', 'address2', 'city', 'state', 'country', 'postcode', 'phone_country'] as $f) {
                if (trim((string) ($target[$f] ?? '')) === '' && trim((string) ($source[$f] ?? '')) !== '') {
                    $sets[]        = "$f = :$f";
                    $params[":$f"] = $source[$f];
                    $moved['filled'][] = $f;
                }
            }
            if (empty($target['updates_consent_at']) && registrationHasConsent($source)) {
                $sets[]        = 'updates_consent_at = :cat';
                $sets[]        = 'updates_consent_by = :cby';
                $params[':cat'] = $source['updates_consent_at'];
                $params[':cby'] = $source['updates_consent_by'];
                $moved['filled'][] = 'consent';
            }
        }

        // 5. A newer unsubscribe wins.
        $consentAt = in_array('consent', $moved['filled'], true) ? $source['updates_consent_at'] : $target['updates_consent_at'];
        if (!empty($source['unsubscribed_at']) && empty($target['unsubscribed_at'])
            && ($consentAt === null || $consentAt === '' || strcmp((string) $source['unsubscribed_at'], (string) $consentAt) >= 0)) {
            $sets[]         = 'unsubscribed_at = :unsub';
            $params[':unsub'] = $source['unsubscribed_at'];
        }
        if ($sets) {
            $db->prepare('UPDATE devotees SET ' . implode(', ', $sets) . ' WHERE id = :id')->execute($params);
        }

        // 6. Duplicate flags, then the source itself.
        registrationRepointDuplicates($db, $sourceId, $targetId);
        $db->prepare('DELETE FROM devotees WHERE id = :id')->execute([':id' => $sourceId]);

        // The target may now point at a registration that points back at it.
        $dup = $db->prepare('SELECT d.duplicate_of FROM devotees d JOIN devotees o ON o.id = d.duplicate_of WHERE d.id = :t AND o.duplicate_of = :t2');
        $dup->execute([':t' => $targetId, ':t2' => $targetId]);
        if ($dup->fetchColumn() !== false) {
            $db->prepare('UPDATE devotees SET duplicate_of = NULL WHERE id = :t')->execute([':t' => $targetId]);
        }

        return $moved;
    });
}

/* ── Exports ──────────────────────────────────────────────────────────────── */

/**
 * A CSV cell a spreadsheet will show as text. Registrations are typed by the
 * public, and Excel runs a cell that begins with = + - @ (or a tab or carriage
 * return in front of one) as a formula, so those get a leading apostrophe.
 */
function registrationCsvCell(mixed $value): string
{
    $s = (string) ($value ?? '');
    return $s !== '' && preg_match('/^[=+\-@\t\r]/', $s) ? "'" . $s : $s;
}

/** Members as one readable cell: "K. Meena (Spouse (wife / husband), 41); K. Arun (Son)". */
function registrationMembersText(array $members): string
{
    return implode('; ', array_map(static function (array $m): string {
        $bits = [registrationRelationshipLabel($m['relationship'])];
        if ($m['age'] !== null && $m['age'] !== '') $bits[] = (string) (int) $m['age'];
        return $m['name'] . ' (' . implode(', ', $bits) . ')';
    }, $members));
}
