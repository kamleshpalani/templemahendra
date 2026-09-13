<?php
/**
 * backend/includes/notify/audience.php — who a campaign reaches.
 *
 * An audience is JSON the admin's rules builder writes and a saved segment
 * stores:
 *
 *   {"mode": "all_devotees" | "selected" | "rules",
 *    "devotee_ids": [12, 40],
 *    "match": "all" | "any",
 *    "rules": [{"field": "country", "op": "in", "value": ["IN", "SG"]}]}
 *
 * It becomes SQL here and nowhere else. Every value travels as a bound
 * parameter; field names, operators and table names come only from the fixed
 * table below, never from the input.
 *
 * Two limits apply whatever the rules say:
 *
 *   • An archived registration (devotees.is_active = 0) is never in an audience.
 *   • A campaign whose category needs consent (informational and critical
 *     kinds, docs/registration/SPEC.md §6) reaches only families who agreed to
 *     temple updates and have not unsubscribed. The channel policy would skip
 *     the others anyway; filtering here as well keeps the committee's estimate,
 *     the approval threshold and "families reached" honest, and saves writing a
 *     skipped notification for every family that never said yes.
 */

require_once __DIR__ . '/consent.php';

const NOTIFY_AUDIENCE_MAX_SELECTED = 5000;
const NOTIFY_AUDIENCE_MAX_RULES    = 50;
const NOTIFY_BOOKING_STATUSES      = ['pending', 'confirmed', 'completed', 'cancelled'];
/** The most family members a registration can hold, plus the registrant; the family_size rule allows some room above it for committee edits. */
const NOTIFY_FAMILY_SIZE_MAX       = 100;
/** The SQL that means "agreed to temple updates and has not unsubscribed". */
const NOTIFY_AUDIENCE_CONSENT_SQL  = 'd.updates_consent_at IS NOT NULL AND d.unsubscribed_at IS NULL';

/**
 * Fields that existed while devotees signed in, with the label the committee
 * knew them by. A saved segment or campaign that still uses one is flagged in
 * the admin and refused with a sentence naming the rule, instead of failing
 * with "a field this site does not know".
 */
const NOTIFY_AUDIENCE_RETIRED_FIELDS = [
    'email_verified'     => 'Email confirmed',
    'phone_verified'     => 'Mobile number verified',
    'last_login_days'    => 'Days since last sign-in',
    'channel_enabled'    => 'Has this channel switched on',
    'category_not_muted' => 'Has not muted the category',
];

/**
 * field => ['label','ops','type','options'] for the rules builder. Options are
 * filled for fields whose values come from a fixed or database list.
 */
function notifyAudienceFields(): array
{
    $langOptions = [['value' => 'ta', 'label' => 'தமிழ் (Tamil)'], ['value' => 'en', 'label' => 'English']];

    $sevas = [];
    $tags  = [];
    if (notifyTablesExist()) {
        try {
            $db = getDB();
            foreach ($db->query('SELECT id, name_en, name_ta, is_active FROM sevas ORDER BY sort_order, id')->fetchAll(PDO::FETCH_ASSOC) as $s) {
                $sevas[] = ['value' => (int) $s['id'], 'label' => trim(($s['name_en'] ?: $s['name_ta']) . ((int) $s['is_active'] === 1 ? '' : ' (inactive)'))];
            }
            foreach ($db->query('SELECT tag, COUNT(*) AS n FROM devotee_tags GROUP BY tag ORDER BY tag')->fetchAll(PDO::FETCH_ASSOC) as $t) {
                $tags[] = ['value' => (string) $t['tag'], 'label' => $t['tag'] . ' (' . (int) $t['n'] . ')'];
            }
        } catch (Throwable $e) {
            error_log('[notify] audience options unavailable: ' . $e->getMessage());
        }
    }

    return [
        'country'         => ['label' => 'Country',                         'ops' => ['in', 'not_in'], 'type' => 'iso2list', 'options' => null],
        'state'           => ['label' => 'State or region',                 'ops' => ['in', 'not_in'], 'type' => 'strlist',  'options' => null],
        'city'            => ['label' => 'City or town',                    'ops' => ['contains', 'equals'], 'type' => 'string', 'options' => null],
        'lang'            => ['label' => 'Language chosen at registration', 'ops' => ['in'],   'type' => 'enum',   'options' => $langOptions],
        'consent'         => ['label' => 'Agreed to receive temple updates', 'ops' => ['is'],  'type' => 'bool',   'options' => null],
        'has_email'       => ['label' => 'Has an email address',            'ops' => ['is'],   'type' => 'bool',   'options' => null],
        'has_phone'       => ['label' => 'Has a phone number',              'ops' => ['is'],   'type' => 'bool',   'options' => null],
        'family_size'     => ['label' => 'Family size (registrant and members)', 'ops' => ['gte', 'lte'], 'type' => 'int', 'options' => null],
        'registered_days' => ['label' => 'Days since registering',          'ops' => ['lte', 'gte'], 'type' => 'int', 'options' => null],
        'has_booking'     => ['label' => 'Has booked a seva',               'ops' => ['is'],   'type' => 'bool',   'options' => null],
        'booked_seva'     => ['label' => 'Booked one of these sevas',       'ops' => ['in'],   'type' => 'idlist', 'options' => $sevas],
        'booking_status'  => ['label' => 'Has a booking with status',       'ops' => ['in'],   'type' => 'enum',
                              'options' => array_map(static fn($s) => ['value' => $s, 'label' => ucfirst($s)], NOTIFY_BOOKING_STATUSES)],
        'booking_days'    => ['label' => 'Booked within the last N days',   'ops' => ['lte'],  'type' => 'int',    'options' => null],
        'has_donated'     => ['label' => 'Has donated',                     'ops' => ['is'],   'type' => 'bool',   'options' => null],
        'donated_total'   => ['label' => 'Total donated (Rs.)',             'ops' => ['gte', 'lte'], 'type' => 'number', 'options' => null],
        'donated_days'    => ['label' => 'Donated within the last N days',  'ops' => ['lte'],  'type' => 'int',    'options' => null],
        'tag'             => ['label' => 'Tag',                             'ops' => ['in', 'not_in'], 'type' => 'strlist', 'options' => $tags],
    ];
}

/** The fixed part of the field table, without the database-backed option lists. */
function notifyAudienceFieldOps(): array
{
    return [
        'country' => ['in', 'not_in'], 'state' => ['in', 'not_in'], 'city' => ['contains', 'equals'],
        'lang' => ['in'], 'consent' => ['is'], 'has_email' => ['is'], 'has_phone' => ['is'],
        'family_size' => ['gte', 'lte'], 'registered_days' => ['lte', 'gte'],
        'has_booking' => ['is'], 'booked_seva' => ['in'], 'booking_status' => ['in'], 'booking_days' => ['lte'],
        'has_donated' => ['is'], 'donated_total' => ['gte', 'lte'], 'donated_days' => ['lte'],
        'tag' => ['in', 'not_in'],
    ];
}

/**
 * The retired fields (NOTIFY_AUDIENCE_RETIRED_FIELDS) an audience still uses,
 * as field => label. Accepts the rules array or its JSON text and never throws,
 * so the admin can flag a stored segment or campaign that no longer validates.
 */
function notifyAudienceRetiredFieldsIn(mixed $rules): array
{
    if (is_string($rules)) $rules = json_decode($rules, true);
    if (!is_array($rules) || ($rules['mode'] ?? null) !== 'rules' || !is_array($rules['rules'] ?? null)) return [];
    $found = [];
    foreach ($rules['rules'] as $rule) {
        $field = is_array($rule) ? ($rule['field'] ?? null) : null;
        if (is_string($field) && isset(NOTIFY_AUDIENCE_RETIRED_FIELDS[$field])) $found[$field] = NOTIFY_AUDIENCE_RETIRED_FIELDS[$field];
    }
    return $found;
}

/**
 * Validate and canonicalise audience rules. Accepts the array or its JSON text.
 *
 * @throws InvalidArgumentException with a sentence the admin can act on
 */
function notifyAudienceNormalize(array|string $rules): array
{
    if (is_string($rules)) {
        $decoded = json_decode($rules, true);
        if (!is_array($decoded)) throw new InvalidArgumentException('The audience could not be read. Build it again.');
        $rules = $decoded;
    }
    $mode = $rules['mode'] ?? null;
    if (!in_array($mode, ['all_devotees', 'selected', 'rules'], true)) {
        throw new InvalidArgumentException('Choose who should receive this: all registered families, selected families, or families matching rules.');
    }

    if ($mode === 'all_devotees') return ['mode' => 'all_devotees'];

    if ($mode === 'selected') {
        $ids = [];
        foreach ((array) ($rules['devotee_ids'] ?? []) as $id) {
            if (is_int($id) || (is_string($id) && ctype_digit($id))) {
                $n = (int) $id;
                if ($n > 0) $ids[$n] = $n;
            }
        }
        if (!$ids) throw new InvalidArgumentException('Choose at least one family.');
        if (count($ids) > NOTIFY_AUDIENCE_MAX_SELECTED) {
            throw new InvalidArgumentException('Choose at most ' . NOTIFY_AUDIENCE_MAX_SELECTED . ' families by hand; use rules or a tag for a larger group.');
        }
        sort($ids);
        return ['mode' => 'selected', 'devotee_ids' => array_values($ids)];
    }

    $match = $rules['match'] ?? 'all';
    if (!in_array($match, ['all', 'any'], true)) throw new InvalidArgumentException('Choose whether families must match all rules or any rule.');
    $list = $rules['rules'] ?? [];
    if (!is_array($list) || !$list) throw new InvalidArgumentException('Add at least one rule, or choose all registered families.');
    if (count($list) > NOTIFY_AUDIENCE_MAX_RULES) throw new InvalidArgumentException('Use at most ' . NOTIFY_AUDIENCE_MAX_RULES . ' rules.');

    $ops = notifyAudienceFieldOps();
    $labels = [
        'country' => 'Country', 'state' => 'State', 'city' => 'City', 'lang' => 'Language',
        'consent' => 'Agreed to updates', 'has_email' => 'Has email', 'has_phone' => 'Has phone',
        'family_size' => 'Family size', 'registered_days' => 'Days since registering',
        'has_booking' => 'Has booked', 'booked_seva' => 'Booked seva', 'booking_status' => 'Booking status',
        'booking_days' => 'Booked within', 'has_donated' => 'Has donated', 'donated_total' => 'Total donated',
        'donated_days' => 'Donated within', 'tag' => 'Tag',
    ];

    $out = [];
    foreach (array_values($list) as $i => $rule) {
        $n = $i + 1;
        if (!is_array($rule)) throw new InvalidArgumentException("Rule {$n} is incomplete.");
        $field = $rule['field'] ?? null;
        if (is_string($field) && isset(NOTIFY_AUDIENCE_RETIRED_FIELDS[$field])) {
            throw new InvalidArgumentException("Rule {$n} uses \"" . NOTIFY_AUDIENCE_RETIRED_FIELDS[$field]
                . '", which no longer exists now that families register instead of signing in. Remove that rule.');
        }
        if (!is_string($field) || !isset($ops[$field])) throw new InvalidArgumentException("Rule {$n} uses a field this site does not know.");
        $label = $labels[$field];
        $op = $rule['op'] ?? null;
        if (!is_string($op) || !in_array($op, $ops[$field], true)) {
            throw new InvalidArgumentException("Rule {$n} ({$label}) cannot use that comparison.");
        }
        $out[] = ['field' => $field, 'op' => $op, 'value' => notifyAudienceValue($field, $rule['value'] ?? null, $n, $label)];
    }
    return ['mode' => 'rules', 'match' => $match, 'rules' => $out];
}

/** One rule's value, checked and canonicalised for its field. */
function notifyAudienceValue(string $field, mixed $value, int $n, string $label): mixed
{
    $fail = static fn(string $why): never => throw new InvalidArgumentException("Rule {$n} ({$label}): {$why}");
    $list = static function (mixed $v) use ($fail): array {
        if (is_string($v)) $v = array_map('trim', explode(',', $v));
        if (!is_array($v)) $fail('choose at least one value.');
        $v = array_values(array_unique(array_filter(array_map(static fn($x) => is_scalar($x) ? trim((string) $x) : '', $v), static fn($x) => $x !== '')));
        if (!$v) $fail('choose at least one value.');
        if (count($v) > 500) $fail('use at most 500 values.');
        return $v;
    };

    switch ($field) {
        case 'country':
            $v = array_map('strtoupper', $list($value));
            foreach ($v as $c) if (!preg_match('/^[A-Z]{2}$/', $c)) $fail('use two-letter country codes such as IN or GB.');
            return array_values(array_unique($v));

        case 'state':
            $v = $list($value);
            foreach ($v as $s) if (mb_strlen($s) > 120) $fail('a state name is too long.');
            return $v;

        case 'city':
            $s = is_scalar($value) ? trim((string) $value) : '';
            if ($s === '') $fail('type a city or town.');
            if (mb_strlen($s) > 120) $fail('that city name is too long.');
            return $s;

        case 'lang':
            // A registration records Tamil or English, nothing else.
            $v = array_map('strtolower', $list($value));
            foreach ($v as $l) if (!in_array($l, ['ta', 'en'], true)) $fail('choose Tamil or English.');
            return array_values(array_unique($v));

        case 'consent':
        case 'has_email':
        case 'has_phone':
        case 'has_booking':
        case 'has_donated':
            $b = notifyBool($value);
            if ($b === null) $fail('choose yes or no.');
            return $b;

        case 'family_size':
            if (!(is_int($value) || (is_string($value) && preg_match('/^\d{1,3}$/', trim($value))))) $fail('enter a whole number of people.');
            $size = (int) $value;
            if ($size < 1 || $size > NOTIFY_FAMILY_SIZE_MAX) $fail('enter between 1 and ' . NOTIFY_FAMILY_SIZE_MAX . ' people.');
            return $size;

        case 'registered_days':
        case 'booking_days':
        case 'donated_days':
            if (!(is_int($value) || (is_string($value) && preg_match('/^\d{1,5}$/', trim($value))))) $fail('enter a whole number of days.');
            $d = (int) $value;
            if ($d < 0 || $d > 36500) $fail('enter between 0 and 36500 days.');
            return $d;

        case 'donated_total':
            if (!is_numeric($value)) $fail('enter an amount.');
            $a = round((float) $value, 2);
            if ($a < 0 || $a > 10000000000) $fail('enter an amount of zero or more.');
            return $a;

        case 'booked_seva':
            $ids = [];
            foreach ($list($value) as $id) {
                if (!ctype_digit($id) || (int) $id < 1) $fail('choose sevas from the list.');
                $ids[] = (int) $id;
            }
            return array_values(array_unique($ids));

        case 'booking_status':
            $v = array_map('strtolower', $list($value));
            foreach ($v as $s) if (!in_array($s, NOTIFY_BOOKING_STATUSES, true)) $fail('choose pending, confirmed, completed or cancelled.');
            return array_values(array_unique($v));

        case 'tag':
            $v = array_map('mb_strtolower', $list($value));
            foreach ($v as $t) if (!preg_match('/^[a-z0-9:_-]{1,40}$/', $t)) $fail('tags use lowercase letters, digits, colon, dash and underscore.');
            return array_values(array_unique($v));
    }
    $fail('unknown field.');
}

/**
 * True when an audience for this category is limited to consenting families.
 * No category (a saved segment on its own) means no limit: the segment page
 * shows both numbers instead.
 */
function notifyAudienceNeedsConsent(?string $category): bool
{
    return $category !== null && $category !== '' && notifyCategoryNeedsConsent($category);
}

/**
 * The WHERE clause and parameters for normalised rules. Parameter names are
 * numbered, because native prepared statements cannot bind one name twice.
 *
 * $category is the campaign's: when it needs consent the clause also requires
 * it (see the top of this file).
 */
function notifyAudienceWhere(array|string $rules, ?string $category = null): array
{
    $r = notifyAudienceNormalize($rules);
    $params = [];
    $bind = static function (mixed $value) use (&$params): string {
        $name = ':a' . count($params);
        $params[$name] = $value;
        return $name;
    };
    $in = static function (array $values) use ($bind): string {
        return implode(', ', array_map($bind, $values));
    };
    // Cut-offs are computed in PHP from the service clock, so a test clock and
    // the MySQL server's own zone setting cannot disagree about "N days ago".
    $daysAgo = static fn(int $days): string => notifyNowPlus(-$days * 86400);

    $where = ['d.is_active = 1'];
    if (notifyAudienceNeedsConsent($category)) $where[] = NOTIFY_AUDIENCE_CONSENT_SQL;

    if ($r['mode'] === 'selected') {
        $where[] = 'd.id IN (' . $in($r['devotee_ids']) . ')';
        return ['where' => implode(' AND ', $where), 'params' => $params];
    }
    if ($r['mode'] === 'all_devotees') {
        return ['where' => implode(' AND ', $where), 'params' => $params];
    }

    $parts = [];
    foreach ($r['rules'] as $rule) {
        $v = $rule['value'];
        switch ($rule['field']) {
            case 'country':
            case 'state':
                $col = 'd.' . $rule['field'];
                $parts[] = $rule['op'] === 'in'
                    ? "{$col} IN (" . $in($v) . ')'
                    : "({$col} IS NULL OR {$col} NOT IN (" . $in($v) . '))';
                break;
            case 'city':
                // utf8mb4_unicode_ci compares without regard to case already.
                $parts[] = $rule['op'] === 'equals'
                    ? 'TRIM(d.city) = ' . $bind($v)
                    : 'd.city LIKE ' . $bind('%' . addcslashes($v, '%_\\') . '%');
                break;
            case 'lang':
                $parts[] = 'd.lang IN (' . $in($v) . ')';
                break;
            case 'consent':
                $parts[] = $v ? '(' . NOTIFY_AUDIENCE_CONSENT_SQL . ')' : 'NOT (' . NOTIFY_AUDIENCE_CONSENT_SQL . ')';
                break;
            case 'has_email':
                $parts[] = $v ? "(d.email IS NOT NULL AND d.email <> '')" : "(d.email IS NULL OR d.email = '')";
                break;
            case 'has_phone':
                $parts[] = $v ? "(d.phone IS NOT NULL AND d.phone <> '')" : "(d.phone IS NULL OR d.phone = '')";
                break;
            case 'family_size':
                // The registrant is not a member row, so a family with no members has size 1.
                $parts[] = '(1 + (SELECT COUNT(*) FROM devotee_family_members fm WHERE fm.devotee_id = d.id)) '
                    . ($rule['op'] === 'gte' ? '>= ' : '<= ') . $bind($v);
                break;
            case 'registered_days':
                $parts[] = $rule['op'] === 'lte' ? 'd.created_at >= ' . $bind($daysAgo($v)) : 'd.created_at <= ' . $bind($daysAgo($v));
                break;
            // Bookings and donations are linked to a registration only when they
            // were made while devotees could sign in (seva_bookings.devotee_id and
            // donations.devotee_id are no longer written). These rules read those
            // links as they stand.
            case 'has_booking':
                $parts[] = ($v ? '' : 'NOT ') . 'EXISTS (SELECT 1 FROM seva_bookings b WHERE b.devotee_id = d.id)';
                break;
            case 'booked_seva':
                $parts[] = 'EXISTS (SELECT 1 FROM seva_bookings b WHERE b.devotee_id = d.id AND b.seva_id IN (' . $in($v) . '))';
                break;
            case 'booking_status':
                $parts[] = 'EXISTS (SELECT 1 FROM seva_bookings b WHERE b.devotee_id = d.id AND b.status IN (' . $in($v) . '))';
                break;
            case 'booking_days':
                $parts[] = 'EXISTS (SELECT 1 FROM seva_bookings b WHERE b.devotee_id = d.id AND b.created_at >= ' . $bind($daysAgo($v)) . ')';
                break;
            case 'has_donated':
                $parts[] = ($v ? '' : 'NOT ') . 'EXISTS (SELECT 1 FROM donations x WHERE x.devotee_id = d.id)';
                break;
            case 'donated_total':
                $parts[] = '(SELECT COALESCE(SUM(x.amount), 0) FROM donations x WHERE x.devotee_id = d.id) '
                    . ($rule['op'] === 'gte' ? '>= ' : '<= ') . $bind($v);
                break;
            case 'donated_days':
                $parts[] = 'EXISTS (SELECT 1 FROM donations x WHERE x.devotee_id = d.id AND x.created_at >= ' . $bind($daysAgo($v)) . ')';
                break;
            case 'tag':
                $parts[] = ($rule['op'] === 'in' ? '' : 'NOT ')
                    . 'EXISTS (SELECT 1 FROM devotee_tags t WHERE t.devotee_id = d.id AND t.tag IN (' . $in($v) . '))';
                break;
        }
    }
    $where[] = '(' . implode($r['match'] === 'any' ? ' OR ' : ' AND ', $parts) . ')';
    return ['where' => implode(' AND ', $where), 'params' => $params];
}

/** ['sql' => 'SELECT d.id FROM devotees d … ORDER BY d.id', 'params' => [':a0' => …]] */
function notifyAudienceQuery(array|string $rules, ?string $category = null): array
{
    $w = notifyAudienceWhere($rules, $category);
    return [
        'sql'    => 'SELECT d.id FROM devotees d WHERE ' . $w['where'] . ' ORDER BY d.id',
        'params' => $w['params'],
    ];
}

/** How many registrations the rules reach now (limited to consenting ones for a category that needs it). Zero when the tables are missing. */
function notifyAudienceCount(array|string $rules, ?string $category = null): int
{
    $w = notifyAudienceWhere($rules, $category);
    if (!notifyTablesExist()) return 0;
    $stmt = getDB()->prepare('SELECT COUNT(*) FROM devotees d WHERE ' . $w['where']);
    $stmt->execute($w['params']);
    return (int) $stmt->fetchColumn();
}

/**
 * ['all' => active registrations the rules match, 'consenting' => those of them
 * who agreed to temple updates and have not unsubscribed]. The segment page and
 * the composer show both, so the committee sees who an update would reach.
 */
function notifyAudienceBreakdown(array|string $rules): array
{
    $w = notifyAudienceWhere($rules);
    if (!notifyTablesExist()) return ['all' => 0, 'consenting' => 0];
    $stmt = getDB()->prepare(
        'SELECT COUNT(*) AS all_n, COALESCE(SUM(' . NOTIFY_AUDIENCE_CONSENT_SQL . '), 0) AS consenting_n FROM devotees d WHERE ' . $w['where']
    );
    $stmt->execute($w['params']);
    $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
    return ['all' => (int) ($row['all_n'] ?? 0), 'consenting' => (int) ($row['consenting_n'] ?? 0)];
}

/** The next batch of registration ids after $afterId, for campaign expansion. */
function notifyAudienceBatch(array|string $rules, int $afterId, int $limit, ?string $category = null): array
{
    $w = notifyAudienceWhere($rules, $category);
    $params = $w['params'] + [':after' => $afterId];
    $stmt = getDB()->prepare(
        'SELECT d.id FROM devotees d WHERE ' . $w['where'] . ' AND d.id > :after ORDER BY d.id LIMIT ' . max(1, min(1000, $limit))
    );
    $stmt->execute($params);
    return array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
}
