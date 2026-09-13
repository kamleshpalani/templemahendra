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
 * table below, never from the input. Closed accounts are excluded from every
 * audience, whatever the rules say.
 */

require_once __DIR__ . '/prefs.php';

const NOTIFY_AUDIENCE_MAX_SELECTED = 5000;
const NOTIFY_AUDIENCE_MAX_RULES    = 50;
const NOTIFY_BOOKING_STATUSES      = ['pending', 'confirmed', 'completed', 'cancelled'];

/**
 * field => ['label','ops','type','options'] for the rules builder. Options are
 * filled for fields whose values come from a fixed or database list.
 */
function notifyAudienceFields(): array
{
    $langOptions = [];
    foreach (notifyLanguages() as $code => $label) $langOptions[] = ['value' => $code, 'label' => $label];

    $sevas = [];
    $tags  = [];
    $cats  = [];
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
        foreach (notifyCategories(true) as $key => $c) {
            if ($c['mutable']) $cats[] = ['value' => (string) $key, 'label' => (string) $c['label_en']];
        }
    }
    $channelLabels = ['inapp' => 'In-app', 'email' => 'Email', 'whatsapp' => 'WhatsApp', 'sms' => 'SMS', 'push' => 'Push'];
    $channels = [];
    foreach (NOTIFY_CHANNELS as $c) $channels[] = ['value' => $c, 'label' => $channelLabels[$c]];

    return [
        'country'            => ['label' => 'Country',                       'ops' => ['in', 'not_in'], 'type' => 'iso2list', 'options' => null],
        'state'              => ['label' => 'State or region',               'ops' => ['in', 'not_in'], 'type' => 'strlist',  'options' => null],
        'city'               => ['label' => 'City or town',                  'ops' => ['contains', 'equals'], 'type' => 'string', 'options' => null],
        'lang'               => ['label' => 'Preferred language',            'ops' => ['in'],   'type' => 'enum',   'options' => $langOptions],
        'email_verified'     => ['label' => 'Email confirmed',               'ops' => ['is'],   'type' => 'bool',   'options' => null],
        'phone_verified'     => ['label' => 'Mobile number verified',        'ops' => ['is'],   'type' => 'bool',   'options' => null],
        'registered_days'    => ['label' => 'Days since registering',        'ops' => ['lte', 'gte'], 'type' => 'int', 'options' => null],
        'last_login_days'    => ['label' => 'Days since last sign-in',       'ops' => ['lte', 'gte'], 'type' => 'int', 'options' => null],
        'has_booking'        => ['label' => 'Has booked a seva',             'ops' => ['is'],   'type' => 'bool',   'options' => null],
        'booked_seva'        => ['label' => 'Booked one of these sevas',     'ops' => ['in'],   'type' => 'idlist', 'options' => $sevas],
        'booking_status'     => ['label' => 'Has a booking with status',     'ops' => ['in'],   'type' => 'enum',
                                 'options' => array_map(static fn($s) => ['value' => $s, 'label' => ucfirst($s)], NOTIFY_BOOKING_STATUSES)],
        'booking_days'       => ['label' => 'Booked within the last N days', 'ops' => ['lte'],  'type' => 'int',    'options' => null],
        'has_donated'        => ['label' => 'Has donated',                   'ops' => ['is'],   'type' => 'bool',   'options' => null],
        'donated_total'      => ['label' => 'Total donated (Rs.)',           'ops' => ['gte', 'lte'], 'type' => 'number', 'options' => null],
        'donated_days'       => ['label' => 'Donated within the last N days', 'ops' => ['lte'], 'type' => 'int',    'options' => null],
        'tag'                => ['label' => 'Tag',                           'ops' => ['in', 'not_in'], 'type' => 'strlist', 'options' => $tags],
        'channel_enabled'    => ['label' => 'Has this channel switched on',  'ops' => ['in'],   'type' => 'enum',   'options' => $channels],
        'category_not_muted' => ['label' => 'Has not muted the category',    'ops' => ['is'],   'type' => 'enum',   'options' => $cats],
    ];
}

/** The fixed part of the field table, without the database-backed option lists. */
function notifyAudienceFieldOps(): array
{
    return [
        'country' => ['in', 'not_in'], 'state' => ['in', 'not_in'], 'city' => ['contains', 'equals'],
        'lang' => ['in'], 'email_verified' => ['is'], 'phone_verified' => ['is'],
        'registered_days' => ['lte', 'gte'], 'last_login_days' => ['lte', 'gte'],
        'has_booking' => ['is'], 'booked_seva' => ['in'], 'booking_status' => ['in'], 'booking_days' => ['lte'],
        'has_donated' => ['is'], 'donated_total' => ['gte', 'lte'], 'donated_days' => ['lte'],
        'tag' => ['in', 'not_in'], 'channel_enabled' => ['in'], 'category_not_muted' => ['is'],
    ];
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
        throw new InvalidArgumentException('Choose who should receive this: all devotees, selected devotees, or devotees matching rules.');
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
        if (!$ids) throw new InvalidArgumentException('Choose at least one devotee.');
        if (count($ids) > NOTIFY_AUDIENCE_MAX_SELECTED) {
            throw new InvalidArgumentException('Choose at most ' . NOTIFY_AUDIENCE_MAX_SELECTED . ' devotees by hand; use rules or a tag for a larger group.');
        }
        sort($ids);
        return ['mode' => 'selected', 'devotee_ids' => array_values($ids)];
    }

    $match = $rules['match'] ?? 'all';
    if (!in_array($match, ['all', 'any'], true)) throw new InvalidArgumentException('Choose whether devotees must match all rules or any rule.');
    $list = $rules['rules'] ?? [];
    if (!is_array($list) || !$list) throw new InvalidArgumentException('Add at least one rule, or choose all devotees.');
    if (count($list) > NOTIFY_AUDIENCE_MAX_RULES) throw new InvalidArgumentException('Use at most ' . NOTIFY_AUDIENCE_MAX_RULES . ' rules.');

    $ops = notifyAudienceFieldOps();
    $labels = [
        'country' => 'Country', 'state' => 'State', 'city' => 'City', 'lang' => 'Language',
        'email_verified' => 'Email confirmed', 'phone_verified' => 'Mobile verified',
        'registered_days' => 'Days since registering', 'last_login_days' => 'Days since last sign-in',
        'has_booking' => 'Has booked', 'booked_seva' => 'Booked seva', 'booking_status' => 'Booking status',
        'booking_days' => 'Booked within', 'has_donated' => 'Has donated', 'donated_total' => 'Total donated',
        'donated_days' => 'Donated within', 'tag' => 'Tag', 'channel_enabled' => 'Channel switched on',
        'category_not_muted' => 'Category not muted',
    ];

    $out = [];
    foreach (array_values($list) as $i => $rule) {
        $n = $i + 1;
        if (!is_array($rule)) throw new InvalidArgumentException("Rule {$n} is incomplete.");
        $field = $rule['field'] ?? null;
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
            $v = array_map('strtolower', $list($value));
            $langs = notifyLanguages();
            foreach ($v as $l) if (!isset($langs[$l])) $fail('choose from the languages offered.');
            return array_values(array_unique($v));

        case 'email_verified':
        case 'phone_verified':
        case 'has_booking':
        case 'has_donated':
            $b = notifyBool($value);
            if ($b === null) $fail('choose yes or no.');
            return $b;

        case 'registered_days':
        case 'last_login_days':
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

        case 'channel_enabled':
            $v = array_map('strtolower', $list($value));
            foreach ($v as $c) if (!in_array($c, NOTIFY_CHANNELS, true)) $fail('choose from in-app, email, WhatsApp, SMS and push.');
            return array_values(array_unique($v));

        case 'category_not_muted':
            $k = is_scalar($value) ? trim((string) $value) : '';
            if ($k === '' || (notifyTablesExist() && notifyCategory($k) === null)) $fail('choose a category.');
            return $k;
    }
    $fail('unknown field.');
}

/**
 * The WHERE clause and parameters for normalised rules. Parameter names are
 * numbered, because native prepared statements cannot bind one name twice.
 */
function notifyAudienceWhere(array $rules): array
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
                $parts[] = "COALESCE(p.lang, 'ta') IN (" . $in($v) . ')';
                break;
            case 'email_verified':
                $parts[] = $v ? 'd.email_verified_at IS NOT NULL' : 'd.email_verified_at IS NULL';
                break;
            case 'phone_verified':
                $parts[] = $v ? 'd.phone_verified_at IS NOT NULL' : 'd.phone_verified_at IS NULL';
                break;
            case 'registered_days':
                $parts[] = $rule['op'] === 'lte' ? 'd.created_at >= ' . $bind($daysAgo($v)) : 'd.created_at <= ' . $bind($daysAgo($v));
                break;
            case 'last_login_days':
                // Never signed in counts as "a long time ago", not as unknown.
                $parts[] = $rule['op'] === 'lte'
                    ? 'd.last_login_at >= ' . $bind($daysAgo($v))
                    : '(d.last_login_at IS NULL OR d.last_login_at <= ' . $bind($daysAgo($v)) . ')';
                break;
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
            case 'channel_enabled':
                // No preferences row means every channel is on. Column names come
                // from NOTIFY_CHANNELS, already checked by normalisation.
                $any = array_map(static fn(string $c): string => "COALESCE(p.{$c}_on, 1) = 1", $v);
                $parts[] = '(' . implode(' OR ', $any) . ')';
                break;
            case 'category_not_muted':
                $cat = notifyCategory($v);
                if ($cat === null || !$cat['mutable']) {
                    // A category that cannot be muted is "not muted" for everyone.
                    $parts[] = '1 = 1';
                    break;
                }
                $notInList = 'FIND_IN_SET(' . $bind($v) . ', p.muted_categories) = 0';
                // Mirrors notifyPrefsFromRow(): with no row, an informational
                // category that is off by default counts as muted.
                $parts[] = ($cat['kind'] === 'informational' && $cat['default_on'] === 0)
                    ? "(p.devotee_id IS NOT NULL AND {$notInList})"
                    : "(p.devotee_id IS NULL OR {$notInList})";
                break;
        }
    }
    $where[] = '(' . implode($r['match'] === 'any' ? ' OR ' : ' AND ', $parts) . ')';
    return ['where' => implode(' AND ', $where), 'params' => $params];
}

/** ['sql' => 'SELECT d.id FROM devotees d … ORDER BY d.id', 'params' => [':a0' => …]] */
function notifyAudienceQuery(array $rules): array
{
    $w = notifyAudienceWhere($rules);
    return [
        'sql'    => 'SELECT d.id FROM devotees d LEFT JOIN devotee_notification_prefs p ON p.devotee_id = d.id WHERE '
                  . $w['where'] . ' ORDER BY d.id',
        'params' => $w['params'],
    ];
}

/** How many devotees the rules reach now. Zero when the tables are missing. */
function notifyAudienceCount(array $rules): int
{
    $w = notifyAudienceWhere($rules);
    if (!notifyTablesExist()) return 0;
    $stmt = getDB()->prepare(
        'SELECT COUNT(*) FROM devotees d LEFT JOIN devotee_notification_prefs p ON p.devotee_id = d.id WHERE ' . $w['where']
    );
    $stmt->execute($w['params']);
    return (int) $stmt->fetchColumn();
}

/** The next batch of devotee ids after $afterId, for campaign expansion. */
function notifyAudienceBatch(array $rules, int $afterId, int $limit): array
{
    $w = notifyAudienceWhere($rules);
    $params = $w['params'] + [':after' => $afterId];
    $stmt = getDB()->prepare(
        'SELECT d.id FROM devotees d LEFT JOIN devotee_notification_prefs p ON p.devotee_id = d.id WHERE '
        . $w['where'] . ' AND d.id > :after ORDER BY d.id LIMIT ' . max(1, min(1000, $limit))
    );
    $stmt->execute($params);
    return array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
}
