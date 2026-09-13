<?php
/**
 * backend/admin/includes/notify_audience_form.php — "who receives it", shared by
 * the notification composer (notifications.php) and saved audiences
 * (notification_segments.php).
 *
 * An audience is the JSON described in docs/notifications/SPEC.md §5.11. The
 * committee never sees that JSON: they pick "everyone", a saved audience,
 * devotees matching rules, or devotees chosen by hand, and this file turns the
 * form into rules and the rules back into a form.
 *
 * WORKS WITHOUT JAVASCRIPT. Every control is a real form field, and the buttons
 * that change the shape of the form (add a rule, remove one, find a devotee,
 * count recipients) are submit buttons the page answers by re-rendering the
 * form with what was typed. assets/notify-campaigns.js hides those buttons and
 * does the same work in place, reading the field table this file prints as
 * JSON — so the two renderings of a rule row must stay in step (see
 * adminAudienceValueWidget() and buildValue() in the script).
 *
 * The rules are validated by notifyAudienceNormalize() in the service, never
 * here: this file only carries what was typed, so an error message always comes
 * from the one place that turns rules into SQL.
 */

require_once __DIR__ . '/admin_ui.php';

const ADMIN_AUDIENCE_SOURCES       = ['all', 'segment', 'rules', 'selected'];
const ADMIN_AUDIENCE_MAX_ROWS      = 51;   // one past the service's limit, so its message is the one shown
const ADMIN_AUDIENCE_SHOW_SELECTED = 300;  // chosen devotees listed by name; the rest ride along as hidden fields

/** Comparison wording for the builder. */
function adminAudienceOpLabels(): array
{
    return [
        'in'       => 'is one of',
        'not_in'   => 'is not one of',
        'contains' => 'contains',
        'equals'   => 'is exactly',
        'is'       => 'is',
        'lte'      => 'at most',
        'gte'      => 'at least',
    ];
}

/** The builder's field list, grouped the way the committee thinks about devotees. */
function adminAudienceFieldGroups(): array
{
    return [
        'Place'               => ['country', 'state', 'city'],
        'Account'             => ['lang', 'email_verified', 'phone_verified', 'registered_days', 'last_login_days'],
        'Bookings'            => ['has_booking', 'booked_seva', 'booking_status', 'booking_days'],
        'Donations'           => ['has_donated', 'donated_total', 'donated_days'],
        'Groups and settings' => ['tag', 'channel_enabled', 'category_not_muted'],
    ];
}

/** A blank audience: rules, with one empty row to start from. */
function adminAudienceBlank(): array
{
    return [
        'source'      => 'rules',
        'segment_id'  => null,
        'match'       => 'all',
        'rules'       => [['field' => '', 'op' => '', 'value' => '']],
        'devotee_ids' => [],
        'lookup'      => '',
    ];
}

/**
 * Form state from what is stored: a saved segment id, or audience rules.
 * $rules may be the decoded array or null.
 */
function adminAudienceStateFrom(?int $segmentId, ?array $rules): array
{
    $state = adminAudienceBlank();
    if ($segmentId !== null && $segmentId > 0) {
        $state['source'] = 'segment';
        $state['segment_id'] = $segmentId;
        return $state;
    }
    if (!is_array($rules)) return $state;

    switch ($rules['mode'] ?? null) {
        case 'all_devotees':
            $state['source'] = 'all';
            break;
        case 'selected':
            $state['source'] = 'selected';
            $state['devotee_ids'] = array_values(array_filter(array_map('intval', (array) ($rules['devotee_ids'] ?? [])), static fn(int $i) => $i > 0));
            break;
        case 'rules':
            $state['source'] = 'rules';
            $state['match'] = ($rules['match'] ?? 'all') === 'any' ? 'any' : 'all';
            $rows = [];
            foreach ((array) ($rules['rules'] ?? []) as $r) {
                if (!is_array($r)) continue;
                $rows[] = ['field' => (string) ($r['field'] ?? ''), 'op' => (string) ($r['op'] ?? ''), 'value' => $r['value'] ?? ''];
            }
            $state['rules'] = $rows ?: $state['rules'];
            break;
    }
    return $state;
}

/**
 * Form state from a POST, including the shape-changing buttons: add_rule,
 * remove_rule=<index>, remove_devotee=<id>. Values are carried as typed.
 */
function adminAudienceStateFromPost(array $post, bool $allowSegment): array
{
    $state  = adminAudienceBlank();
    $source = is_string($post['audience_source'] ?? null) ? $post['audience_source'] : 'rules';
    if (!in_array($source, ADMIN_AUDIENCE_SOURCES, true) || ($source === 'segment' && !$allowSegment)) $source = 'rules';
    $state['source'] = $source;

    $seg = $post['segment_id'] ?? null;
    $state['segment_id'] = is_scalar($seg) && ctype_digit((string) $seg) && (int) $seg > 0 ? (int) $seg : null;
    $state['match'] = ($post['match'] ?? 'all') === 'any' ? 'any' : 'all';

    $remove = isset($post['remove_rule']) && is_scalar($post['remove_rule']) ? (string) $post['remove_rule'] : null;
    $rows = [];
    foreach ((array) ($post['rules'] ?? []) as $i => $r) {
        if (count($rows) >= ADMIN_AUDIENCE_MAX_ROWS) break;
        if (!is_array($r) || ($remove !== null && (string) $i === $remove)) continue;
        $field = is_string($r['field'] ?? null) ? mb_substr(trim($r['field']), 0, 40) : '';
        $op    = is_string($r['op'] ?? null) ? mb_substr(trim($r['op']), 0, 16) : '';
        $value = $r['value'] ?? '';
        if (is_array($value)) {
            $value = array_values(array_map(static fn($v) => mb_substr(trim((string) $v), 0, 120), array_filter($value, 'is_scalar')));
        } else {
            $value = is_scalar($value) ? mb_substr(trim((string) $value), 0, 2000) : '';
        }
        // A row left completely empty is not a rule anyone meant to write.
        if ($field === '' && ($value === '' || $value === [])) continue;
        $rows[] = ['field' => $field, 'op' => $op, 'value' => $value];
    }
    if (($post['action'] ?? '') === 'add_rule' || (!$rows && $remove === null)) {
        $rows[] = ['field' => '', 'op' => '', 'value' => ''];
    }
    $state['rules'] = $rows;

    $drop = isset($post['remove_devotee']) && is_scalar($post['remove_devotee']) ? (int) $post['remove_devotee'] : 0;
    $ids  = [];
    foreach ((array) ($post['devotee_ids'] ?? []) as $id) {
        if (!is_scalar($id) || !ctype_digit((string) $id)) continue;
        $n = (int) $id;
        if ($n > 0 && $n !== $drop) $ids[$n] = $n;
        if (count($ids) > NOTIFY_AUDIENCE_MAX_SELECTED) break;
    }
    $state['devotee_ids'] = array_values($ids);
    $state['lookup'] = is_string($post['devotee_lookup'] ?? null) ? mb_substr(trim($post['devotee_lookup']), 0, 100) : '';
    return $state;
}

/**
 * What the service takes: ['segment_id' => ?int, 'audience' => ?array].
 * Incomplete input is passed on as it is, so notifyAudienceNormalize() words the problem.
 */
function adminAudienceToInput(array $state): array
{
    switch ($state['source']) {
        case 'segment':
            return ['segment_id' => $state['segment_id'], 'audience' => null];
        case 'all':
            return ['segment_id' => null, 'audience' => ['mode' => 'all_devotees']];
        case 'selected':
            return ['segment_id' => null, 'audience' => ['mode' => 'selected', 'devotee_ids' => $state['devotee_ids']]];
    }
    $rules = [];
    foreach ($state['rules'] as $r) {
        if ($r['field'] === '' && ($r['value'] === '' || $r['value'] === [])) continue;
        $rules[] = ['field' => $r['field'], 'op' => $r['op'], 'value' => $r['value']];
    }
    return ['segment_id' => null, 'audience' => ['mode' => 'rules', 'match' => $state['match'], 'rules' => $rules]];
}

/**
 * Normalised rules for counting. A saved segment is read from the database.
 *
 * @throws InvalidArgumentException with the field it concerns in getCode(): 1 segment, 0 audience
 */
function adminAudienceRules(PDO $db, array $state): array
{
    if ($state['source'] === 'segment') {
        if (!$state['segment_id']) throw new InvalidArgumentException('Choose a saved audience.', 1);
        $stmt = $db->prepare('SELECT rules FROM notification_segments WHERE id = :id');
        $stmt->execute([':id' => $state['segment_id']]);
        $json = $stmt->fetchColumn();
        if ($json === false) throw new InvalidArgumentException('That saved audience no longer exists.', 1);
        return notifyAudienceNormalize((string) $json);
    }
    return notifyAudienceNormalize(adminAudienceToInput($state)['audience'] ?? []);
}

/** ['count' => ?int, 'error' => ?string, 'field' => 'audience'|'segment_id'] — never throws. */
function adminAudienceEstimate(PDO $db, array $state): array
{
    try {
        return ['count' => notifyAudienceCount(adminAudienceRules($db, $state)), 'error' => null, 'field' => null];
    } catch (InvalidArgumentException $e) {
        return ['count' => null, 'error' => $e->getMessage(), 'field' => $e->getCode() === 1 ? 'segment_id' : 'audience'];
    } catch (Throwable $e) {
        error_log('[notify] audience estimate failed: ' . $e->getMessage());
        return ['count' => null, 'error' => 'The recipients could not be counted just now.', 'field' => 'audience'];
    }
}

/** Saved segments for the select: id => name. */
function adminAudienceSegments(PDO $db): array
{
    $out = [];
    try {
        foreach ($db->query('SELECT id, name FROM notification_segments ORDER BY name') as $r) {
            $out[(int) $r['id']] = (string) $r['name'];
        }
    } catch (Throwable) {
        // Without the table there is nothing to offer; the select says so.
    }
    return $out;
}

/**
 * Active devotees whose name, email, phone or town matches, for the picker. At
 * most $limit rows of id, name, email, city. The search term travels in a GET
 * query only because it is what the admin typed into a search box; nothing
 * about a devotee is put into a URL by this page.
 */
function adminAudienceFindDevotees(PDO $db, string $q, int $limit = 20): array
{
    $q = trim($q);
    if (mb_strlen($q) < 2) return [];
    $like   = '%' . addcslashes(mb_substr($q, 0, 100), '%_\\') . '%';
    $digits = preg_replace('/\D+/', '', $q) ?? '';
    $where  = ['name LIKE :q1', 'email LIKE :q2', 'city LIKE :q3'];
    $params = [':q1' => $like, ':q2' => $like, ':q3' => $like];
    if (strlen($digits) >= 4) {
        $where[] = 'phone LIKE :q4';
        $params[':q4'] = '%' . $digits . '%';
    }
    if (ctype_digit($q)) {
        $where[] = 'id = :id';
        $params[':id'] = (int) $q;
    }
    $stmt = $db->prepare(
        'SELECT id, name, email, city FROM devotees
          WHERE is_active = 1 AND (' . implode(' OR ', $where) . ')
          ORDER BY name, id LIMIT ' . max(1, min(20, $limit))
    );
    $stmt->execute($params);
    return array_map(static fn(array $r): array => [
        'id' => (int) $r['id'], 'name' => (string) $r['name'], 'email' => (string) $r['email'], 'city' => (string) ($r['city'] ?? ''),
    ], $stmt->fetchAll(PDO::FETCH_ASSOC));
}

/** Name, email and town for chosen devotee ids, keyed by id (closed accounts included, flagged). */
function adminAudienceDevoteeRows(PDO $db, array $ids, int $limit = ADMIN_AUDIENCE_SHOW_SELECTED): array
{
    $ids = array_slice(array_values(array_unique(array_map('intval', $ids))), 0, $limit);
    if (!$ids) return [];
    $marks  = [];
    $params = [];
    foreach ($ids as $i => $id) {
        $marks[] = ':d' . $i;
        $params[':d' . $i] = $id;
    }
    $stmt = $db->prepare('SELECT id, name, email, city, is_active FROM devotees WHERE id IN (' . implode(',', $marks) . ')');
    $stmt->execute($params);
    $out = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) $out[(int) $r['id']] = $r;
    return $out;
}

/** A rule value as a list of strings, whatever shape it was typed or stored in. */
function adminAudienceList(mixed $value): array
{
    if (is_array($value)) return array_values(array_filter(array_map(static fn($v) => is_scalar($v) ? trim((string) $v) : '', $value), static fn($v) => $v !== ''));
    if (is_bool($value)) return [$value ? 'yes' : 'no'];
    if (!is_scalar($value)) return [];
    return array_values(array_filter(array_map('trim', explode(',', (string) $value)), static fn($v) => $v !== ''));
}

/**
 * The value control for one rule, by field type. Mirrors buildValue() in
 * assets/notify-campaigns.js.
 */
function adminAudienceValueWidget(string $idx, string $num, ?array $def, string $field, string $op, mixed $value): string
{
    $id   = 'nc-rule-' . $idx . '-value';
    $name = 'rules[' . $idx . '][value]';
    $wrap = static fn(string $control): string => '<label class="nc-rule__part" for="' . $id . '"><span class="nc-rule__label">Value<span class="sr-only"> for rule ' . $num . '</span></span>' . $control . '</label>';

    if ($def === null) {
        $text = is_scalar($value) ? (string) $value : implode(', ', adminAudienceList($value));
        return $wrap('<input id="' . $id . '" type="text" name="' . $name . '" maxlength="2000" value="' . h($text) . '" placeholder="Choose what to check first" />');
    }
    $type    = (string) $def['type'];
    $options = is_array($def['options'] ?? null) ? $def['options'] : [];
    $list    = adminAudienceList($value);

    switch ($type) {
        case 'bool':
            $yes = !in_array(strtolower((string) ($list[0] ?? 'yes')), ['no', '0', 'false', 'off'], true);
            return $wrap('<select id="' . $id . '" name="' . $name . '"><option value="yes"' . ($yes ? ' selected' : '') . '>Yes</option><option value="no"' . ($yes ? '' : ' selected') . '>No</option></select>');
        case 'int':
            return $wrap('<input id="' . $id . '" type="number" inputmode="numeric" min="0" max="36500" step="1" name="' . $name . '" value="' . h((string) ($list[0] ?? '')) . '" placeholder="30" />');
        case 'number':
            return $wrap('<input id="' . $id . '" type="number" inputmode="decimal" min="0" step="0.01" name="' . $name . '" value="' . h((string) ($list[0] ?? '')) . '" placeholder="1000" />');
        case 'string':
            return $wrap('<input id="' . $id . '" type="text" maxlength="120" name="' . $name . '" value="' . h(is_scalar($value) ? (string) $value : implode(', ', $list)) . '" placeholder="Madurai" />');
        case 'iso2list':
            return $wrap('<input id="' . $id . '" type="text" maxlength="1500" autocapitalize="characters" spellcheck="false" name="' . $name . '" value="' . h(implode(', ', $list)) . '" placeholder="IN, SG" />');
        case 'strlist':
            $listAttr = $options ? ' list="nc-dl-' . h($field) . '"' : '';
            return $wrap('<input id="' . $id . '" type="text" maxlength="2000" spellcheck="false" name="' . $name . '" value="' . h(implode(', ', $list)) . '" placeholder="' . ($field === 'tag' ? 'volunteer, member' : 'TN, KL') . '"' . $listAttr . ' />');
    }

    // enum and idlist: one choice for "is", several for "in".
    if (!$options) {
        return $wrap('<input id="' . $id . '" type="text" maxlength="2000" name="' . $name . '" value="' . h(implode(', ', $list)) . '" placeholder="Separate values with commas" />');
    }
    if ($op === 'is' || $def['ops'] === ['is']) {
        $out = '<select id="' . $id . '" name="' . $name . '"><option value="">Choose…</option>';
        foreach ($options as $o) {
            $v = (string) $o['value'];
            $out .= '<option value="' . h($v) . '"' . (in_array($v, $list, true) ? ' selected' : '') . '>' . h((string) $o['label']) . '</option>';
        }
        return $wrap($out . '</select>');
    }
    $out = '<fieldset class="nc-rule__part nc-checks"><legend class="nc-rule__label">Values<span class="sr-only"> for rule ' . $num . '</span></legend><div class="nc-checks__list">';
    foreach ($options as $i => $o) {
        $v = (string) $o['value'];
        $cid = $id . '-' . $i;
        $out .= '<label class="checkbox-label nc-checks__item" for="' . h($cid) . '"><input id="' . h($cid) . '" type="checkbox" name="' . $name . '[]" value="' . h($v) . '"'
            . (in_array($v, $list, true) ? ' checked' : '') . ' /><span>' . h((string) $o['label']) . '</span></label>';
    }
    return $out . '</div></fieldset>';
}

/** One row of the rules builder. $idx may be the placeholder "__I__" for the script's template. */
function adminAudienceRuleRow(string $idx, array $row, array $fields): string
{
    $num    = ctype_digit($idx) ? (string) ((int) $idx + 1) : '__N__';
    $field  = (string) ($row['field'] ?? '');
    $def    = $fields[$field] ?? null;
    $opList = $def['ops'] ?? array_keys(adminAudienceOpLabels());
    $op     = in_array($row['op'] ?? '', $opList, true) ? (string) $row['op'] : (string) $opList[0];
    $labels = adminAudienceOpLabels();

    $fieldSel = '<select id="nc-rule-' . $idx . '-field" name="rules[' . $idx . '][field]" data-nc-rule-field><option value="">Choose…</option>';
    $grouped = [];
    foreach (adminAudienceFieldGroups() as $group => $keys) {
        $opts = '';
        foreach ($keys as $k) {
            if (!isset($fields[$k])) continue;
            $grouped[$k] = true;
            $opts .= '<option value="' . h($k) . '"' . ($k === $field ? ' selected' : '') . '>' . h((string) $fields[$k]['label']) . '</option>';
        }
        if ($opts !== '') $fieldSel .= '<optgroup label="' . h($group) . '">' . $opts . '</optgroup>';
    }
    $other = '';
    foreach ($fields as $k => $f) {
        if (!isset($grouped[$k])) $other .= '<option value="' . h($k) . '"' . ($k === $field ? ' selected' : '') . '>' . h((string) $f['label']) . '</option>';
    }
    if ($other !== '') $fieldSel .= '<optgroup label="Other">' . $other . '</optgroup>';
    $fieldSel .= '</select>';

    $opSel = '<select id="nc-rule-' . $idx . '-op" name="rules[' . $idx . '][op]" data-nc-rule-op>';
    foreach ($opList as $o) {
        $opSel .= '<option value="' . h($o) . '"' . ($o === $op ? ' selected' : '') . '>' . h($labels[$o] ?? $o) . '</option>';
    }
    $opSel .= '</select>';

    return '<li class="nc-rule" data-nc-rule data-nc-rule-index="' . h($idx) . '">'
        . '<span class="nc-rule__num" aria-hidden="true">' . h($num) . '</span>'
        . '<label class="nc-rule__part" for="nc-rule-' . $idx . '-field"><span class="nc-rule__label">Check<span class="sr-only"> for rule ' . $num . '</span></span>' . $fieldSel . '</label>'
        . '<label class="nc-rule__part" for="nc-rule-' . $idx . '-op"><span class="nc-rule__label">Comparison<span class="sr-only"> for rule ' . $num . '</span></span>' . $opSel . '</label>'
        . '<div class="nc-rule__value" data-nc-rule-value>' . adminAudienceValueWidget($idx, $num, $def, $field, $op, $row['value'] ?? '') . '</div>'
        . '<button type="submit" name="remove_rule" value="' . h($idx) . '" class="btn btn-ghost btn--icon btn--sm nc-rule__remove" aria-label="Remove rule ' . $num . '" data-nc-remove-rule>' . adminIcon('trash') . '</button>'
        . '</li>';
}

/**
 * The whole audience fieldset.
 *
 * opts: segments (id => name, or null when saved audiences are not offered),
 *       errors ([field => message]; audience, segment_id), fields
 *       (notifyAudienceFields()), estimate (?int, a count the server already
 *       made), estimateError, found (lookup results or null), legend,
 *       segmentsHref.
 */
function adminAudienceForm(PDO $db, array $state, array $opts = []): string
{
    $fields   = $opts['fields'] ?? notifyAudienceFields();
    $segments = $opts['segments'] ?? null;
    $errors   = $opts['errors'] ?? [];
    $found    = $opts['found'] ?? null;
    $legend   = $opts['legend'] ?? 'Who receives it';
    $source   = $state['source'];
    if ($segments === null && $source === 'segment') $source = 'rules';

    $err = static function (string $key, string $id) use ($errors): string {
        return isset($errors[$key]) ? '<p class="field__error nc-group-error" id="' . $id . '">' . adminIcon('alert-circle') . h((string) $errors[$key]) . '</p>' : '';
    };
    $audErr = isset($errors['audience']);
    $segErr = isset($errors['segment_id']);

    $choices = [
        'all'      => ['users',      'All devotees',          'Every active devotee account.'],
        'segment'  => ['layers',     'A saved audience',      'A group the committee saved on the Audiences page.'],
        'rules'    => ['filter',     'Devotees matching rules', 'By place, language, bookings, donations or tags.'],
        'selected' => ['user-check', 'Chosen devotees',       'Pick people by name.'],
    ];
    if ($segments === null) unset($choices['segment']);

    ob_start();
    ?>
<fieldset class="card card--solid card--static nc-fieldset nc-audience" id="nc-audience" data-nc-audience<?= $audErr ? ' aria-describedby="nc-audience-err"' : '' ?>>
  <legend class="nc-legend"><?= adminIcon('users') ?><span><?= h($legend) ?></span></legend>
  <?= $err('audience', 'nc-audience-err') ?>

  <fieldset class="nc-subfieldset">
    <legend class="nc-sublegend">Choose the group</legend>
    <div class="nc-source-grid">
      <?php foreach ($choices as $key => [$icon, $label, $desc]): ?>
        <label class="nc-option" for="nc-src-<?= $key ?>">
          <input type="radio" id="nc-src-<?= $key ?>" name="audience_source" value="<?= $key ?>"<?= $source === $key ? ' checked' : '' ?> data-nc-source />
          <span class="nc-option__icon"><?= adminIcon($icon) ?></span>
          <span class="nc-option__text"><strong><?= h($label) ?></strong><small><?= h($desc) ?></small></span>
        </label>
      <?php endforeach; ?>
    </div>
  </fieldset>

  <?php if ($segments !== null): ?>
  <div class="nc-source-panel" data-nc-source-panel="segment">
    <h3 class="nc-source-panel__title">A saved audience</h3>
    <label for="nc-segment">
      <span class="field__label">Saved audience</span>
      <select id="nc-segment" name="segment_id"<?= $segErr ? ' aria-invalid="true" aria-describedby="nc-segment-err"' : '' ?>>
        <option value="">Choose…</option>
        <?php foreach ($segments as $sid => $sname): ?>
          <option value="<?= (int) $sid ?>"<?= (int) $state['segment_id'] === (int) $sid ? ' selected' : '' ?>><?= h($sname) ?></option>
        <?php endforeach; ?>
      </select>
      <?= $segErr ? '<span class="field__error" id="nc-segment-err">' . adminIcon('alert-circle') . h((string) $errors['segment_id']) . '</span>' : '' ?>
      <span class="field__hint"><?= $segments ? 'The group is worked out again when it is sent, so devotees who joined since are included.' : 'No saved audiences yet.' ?>
        <a href="<?= h($opts['segmentsHref'] ?? '/admin/notification_segments.php') ?>">Manage saved audiences</a></span>
    </label>
  </div>
  <?php endif; ?>

  <div class="nc-source-panel" data-nc-source-panel="rules">
    <h3 class="nc-source-panel__title">Devotees matching rules</h3>
    <label for="nc-match" class="nc-match">
      <span class="field__label">Include devotees who match</span>
      <select id="nc-match" name="match">
        <option value="all"<?= $state['match'] === 'all' ? ' selected' : '' ?>>all of these rules</option>
        <option value="any"<?= $state['match'] === 'any' ? ' selected' : '' ?>>any one of these rules</option>
      </select>
    </label>
    <ol class="nc-rules" data-nc-rules aria-label="Rules">
      <?php foreach (array_values($state['rules']) as $i => $row): ?>
        <?= adminAudienceRuleRow((string) $i, $row, $fields) ?>
      <?php endforeach; ?>
    </ol>
    <p class="field__hint nc-rules__empty" data-nc-rules-empty<?= $state['rules'] ? ' hidden' : '' ?>>No rules yet. Add one, or choose all devotees.</p>
    <div class="cluster">
      <button type="submit" name="action" value="add_rule" class="btn btn--sm" data-nc-add-rule><?= adminIcon('plus') ?> Add rule</button>
      <span class="field__hint">Closed accounts are never included.</span>
    </div>
    <template data-nc-rule-template><?= adminAudienceRuleRow('__I__', ['field' => '', 'op' => '', 'value' => ''], $fields) ?></template>
    <?php foreach ($fields as $key => $def): ?>
      <?php if (($def['type'] ?? '') === 'strlist' && !empty($def['options'])): ?>
        <datalist id="nc-dl-<?= h($key) ?>">
          <?php foreach ($def['options'] as $o): ?><option value="<?= h((string) $o['value']) ?>"><?= h((string) $o['label']) ?></option><?php endforeach; ?>
        </datalist>
      <?php endif; ?>
    <?php endforeach; ?>
  </div>

  <div class="nc-source-panel" data-nc-source-panel="selected">
    <h3 class="nc-source-panel__title">Chosen devotees</h3>
    <div class="nc-picker" data-nc-picker>
      <label for="nc-devotee-lookup">
        <span class="field__label">Find a devotee</span>
        <span class="nc-picker__row">
          <input id="nc-devotee-lookup" type="search" name="devotee_lookup" value="<?= h($state['lookup']) ?>" maxlength="100"
                 autocomplete="off" spellcheck="false" placeholder="Name, email, phone or town" aria-describedby="nc-picker-hint" data-nc-picker-input />
          <button type="submit" name="action" value="find_devotees" class="btn btn--sm" data-nc-nojs><?= adminIcon('search') ?> Find</button>
        </span>
        <span class="field__hint" id="nc-picker-hint">Type at least two letters. Up to 20 matches are shown.</span>
      </label>
      <ul class="nc-picker__results" id="nc-devotee-results" role="listbox" aria-label="Matching devotees" hidden data-nc-picker-results></ul>
      <p class="field__hint nc-picker__status" role="status" aria-live="polite" data-nc-picker-status></p>
      <?php if (is_array($found)): ?>
        <?php $fresh = array_filter($found, static fn($d) => !in_array($d['id'], $state['devotee_ids'], true)); ?>
        <?php if ($fresh): ?>
          <fieldset class="nc-subfieldset nc-found">
            <legend class="nc-sublegend">Matches for “<?= h($state['lookup']) ?>” — tick to add</legend>
            <?php foreach ($fresh as $d): ?>
              <label class="checkbox-label" for="nc-found-<?= (int) $d['id'] ?>">
                <input type="checkbox" id="nc-found-<?= (int) $d['id'] ?>" name="devotee_ids[]" value="<?= (int) $d['id'] ?>" />
                <span><?= h($d['name']) ?> <small class="nc-muted"><?= h($d['email']) ?><?= $d['city'] !== '' ? ' · ' . h($d['city']) : '' ?></small></span>
              </label>
            <?php endforeach; ?>
          </fieldset>
        <?php else: ?>
          <p class="field__hint">No other devotee matches “<?= h($state['lookup']) ?>”.</p>
        <?php endif; ?>
      <?php endif; ?>
    </div>

    <?php
      $ids   = $state['devotee_ids'];
      $shown = adminAudienceDevoteeRows($db, $ids);
    ?>
    <p class="nc-selected__count" data-nc-selected-count><?= count($ids) ?> chosen</p>
    <ul class="nc-selected" data-nc-selected aria-label="Chosen devotees">
      <?php foreach ($ids as $n => $id): ?>
        <?php if ($n >= ADMIN_AUDIENCE_SHOW_SELECTED): ?>
          <li hidden><input type="hidden" name="devotee_ids[]" value="<?= (int) $id ?>" /></li>
          <?php continue; ?>
        <?php endif; ?>
        <?php $d = $shown[$id] ?? null; ?>
        <li class="nc-selected__item" data-nc-selected-id="<?= (int) $id ?>">
          <input type="hidden" name="devotee_ids[]" value="<?= (int) $id ?>" />
          <span class="nc-selected__text">
            <strong><?= $d ? h($d['name']) : 'Devotee #' . (int) $id ?></strong>
            <small><?= $d ? h($d['email']) . ((string) $d['city'] !== '' ? ' · ' . h($d['city']) : '') . ((int) $d['is_active'] === 1 ? '' : ' · closed account, will be skipped') : 'No longer exists' ?></small>
          </span>
          <button type="submit" name="remove_devotee" value="<?= (int) $id ?>" class="btn btn-ghost btn--icon btn--sm" aria-label="Remove <?= h($d['name'] ?? 'devotee #' . $id) ?>" data-nc-remove-devotee><?= adminIcon('x') ?></button>
        </li>
      <?php endforeach; ?>
    </ul>
    <?php if (count($ids) > ADMIN_AUDIENCE_SHOW_SELECTED): ?>
      <p class="field__hint">The first <?= ADMIN_AUDIENCE_SHOW_SELECTED ?> are listed; all <?= count($ids) ?> are kept.</p>
    <?php endif; ?>
  </div>

  <div class="nc-estimate" data-nc-estimate>
    <p class="nc-estimate__line" role="status" aria-live="polite" data-nc-estimate-out>
      <?php if (isset($opts['estimate']) && $opts['estimate'] !== null): ?>
        <span class="nc-estimate__count" data-nc-estimate-count><?= number_format((int) $opts['estimate']) ?></span>
        <span data-nc-estimate-text><?= (int) $opts['estimate'] === 1 ? 'devotee matches right now' : 'devotees match right now' ?></span>
      <?php elseif (!empty($opts['estimateError'])): ?>
        <span class="nc-estimate__count" data-nc-estimate-count>—</span>
        <span data-nc-estimate-text><?= h((string) $opts['estimateError']) ?></span>
      <?php else: ?>
        <span class="nc-estimate__count" data-nc-estimate-count>—</span>
        <span data-nc-estimate-text>Count the recipients to see how many devotees this reaches.</span>
      <?php endif; ?>
    </p>
    <p class="field__hint" data-nc-approval-hint><?= h((string) ($opts['approvalHint'] ?? '')) ?></p>
    <button type="submit" name="action" value="estimate_form" class="btn btn--sm" data-nc-nojs><?= adminIcon('refresh') ?> Count recipients</button>
  </div>
</fieldset>
<script type="application/json" id="nc-audience-fields"><?= json_encode([
    'fields'   => $fields,
    'groups'   => adminAudienceFieldGroups(),
    'opLabels' => adminAudienceOpLabels(),
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?></script>
    <?php
    return (string) ob_get_clean();
}

/**
 * The audience in words, for the campaign page and the segments list.
 * Returns ['summary' => string, 'items' => string[], 'ok' => bool].
 */
function adminAudienceDescribe(?array $rules, array $fields): array
{
    if ($rules === null) return ['summary' => 'No audience chosen yet', 'items' => [], 'ok' => false];
    try {
        $r = notifyAudienceNormalize($rules);
    } catch (InvalidArgumentException $e) {
        return ['summary' => 'The audience needs attention: ' . $e->getMessage(), 'items' => [], 'ok' => false];
    }
    if ($r['mode'] === 'all_devotees') return ['summary' => 'All devotees with an active account', 'items' => [], 'ok' => true];
    if ($r['mode'] === 'selected') {
        $n = count($r['devotee_ids']);
        return ['summary' => $n . ' chosen devotee' . ($n === 1 ? '' : 's'), 'items' => [], 'ok' => true];
    }

    $ops   = adminAudienceOpLabels();
    $items = [];
    foreach ($r['rules'] as $rule) {
        $def   = $fields[$rule['field']] ?? ['label' => $rule['field'], 'type' => 'string', 'options' => null];
        $names = [];
        foreach ((array) ($def['options'] ?? []) as $o) $names[(string) $o['value']] = (string) $o['label'];
        $value = $rule['value'];
        if (is_bool($value)) {
            $text = $value ? 'yes' : 'no';
        } elseif (is_array($value)) {
            $text = implode(', ', array_map(static fn($v) => $names[(string) $v] ?? (string) $v, $value));
        } else {
            $text = $names[(string) $value] ?? (string) $value;
        }
        $items[] = $def['label'] . ' ' . ($ops[$rule['op']] ?? $rule['op']) . ' ' . $text;
    }
    $count = count($items);
    return [
        'summary' => $count === 1 ? 'Devotees matching one rule' : 'Devotees matching ' . ($r['match'] === 'any' ? 'any' : 'all') . ' of ' . $count . ' rules',
        'items'   => $items,
        'ok'      => true,
    ];
}
