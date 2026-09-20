<?php
// backend/includes/calendar_entries.php — committee-managed calendar entries
// (migration 018) merged into the computed Panchangam days: custom entries are
// added to a day's `special` list, "hide" entries remove a computed observance.

require_once __DIR__ . '/db.php';

/** Observance types an "add" entry may carry (how the day is marked). */
const CALENDAR_ADD_TYPES = ['festival', 'pooja', 'pournami', 'amavasai', 'ekadasi', 'sashti', 'pradosham', 'chaturthi', 'holiday', 'custom'];

/** Computed observances a "hide" entry may suppress ('all' = every one on that day). */
const CALENDAR_HIDE_TYPES = ['all', 'pournami', 'amavasai', 'ekadasi', 'sashti', 'pradosham', 'chaturthi', 'pratipada', 'festival'];

/** Labels for the type pickers and admin list. */
const CALENDAR_TYPE_LABELS = [
    'festival'  => ['ta' => 'திருவிழா',   'en' => 'Festival'],
    'pooja'     => ['ta' => 'பூஜை',       'en' => 'Pooja'],
    'pournami'  => ['ta' => 'பௌர்ணமி',    'en' => 'Pournami'],
    'amavasai'  => ['ta' => 'அமாவாசை',    'en' => 'Amavasai'],
    'ekadasi'   => ['ta' => 'ஏகாதசி',     'en' => 'Ekadasi'],
    'sashti'    => ['ta' => 'சஷ்டி',      'en' => 'Sashti'],
    'pradosham' => ['ta' => 'பிரதோஷம்',   'en' => 'Pradosham'],
    'chaturthi' => ['ta' => 'சதுர்த்தி',  'en' => 'Chaturthi'],
    'pratipada' => ['ta' => 'பிரதிபதை',   'en' => 'Pratipada'],
    'holiday'   => ['ta' => 'விடுமுறை',   'en' => 'Temple holiday'],
    'custom'    => ['ta' => 'விசேஷம்',    'en' => 'Special day'],
    'all'       => ['ta' => 'அனைத்தும்',  'en' => 'All computed observances'],
];

/** True once migration 018 has been applied. */
function calendarEntriesTableExists(): bool
{
    static $exists = null;
    if ($exists !== null) return $exists;
    try {
        getDB()->query('SELECT 1 FROM calendar_entries LIMIT 0')->closeCursor();
        return $exists = true;
    } catch (Throwable $e) {
        error_log('[calendar] entries unavailable (apply database/migrations/018_calendar_entries.sql): ' . $e->getMessage());
        return $exists = false;
    }
}

/**
 * Active entries overlapping [$from, $to] (Y-m-d, inclusive), earliest and
 * smallest sort_order first. Empty before migration 018 or on a DB error, so
 * the computed calendar still answers.
 */
function calendarEntriesBetween(string $from, string $to): array
{
    if (!calendarEntriesTableExists()) return [];
    try {
        $stmt = getDB()->prepare(
            'SELECT id, mode, entry_type, entry_date, end_date, title_ta, title_en, description_ta, description_en, pooja_id, event_id, sort_order
               FROM calendar_entries
              WHERE is_active = 1
                AND entry_date <= :to
                AND COALESCE(end_date, entry_date) >= :from
              ORDER BY entry_date ASC, sort_order ASC, id ASC'
        );
        $stmt->execute([':to' => $to, ':from' => $from]);
        return $stmt->fetchAll();
    } catch (Throwable $e) {
        error_log('[calendar] entries query failed: ' . $e->getMessage());
        return [];
    }
}

/** True when $date (Y-m-d) falls inside the entry's date span. */
function calendarEntryCovers(array $entry, string $date): bool
{
    $end = $entry['end_date'] ?? null;
    return $date >= $entry['entry_date'] && $date <= ($end !== null && $end !== '' ? $end : $entry['entry_date']);
}

/**
 * Apply the entries to computed day rows: each row has `date` and `special`
 * (a list of {type, ta, en}). Hide entries strip matching computed items; add
 * entries append {type, ta, en, id, custom: true, description_*, pooja_id, event_id}.
 */
function calendarApplyEntries(array $days, array $entries): array
{
    if (!$entries) return $days;
    foreach ($days as &$day) {
        $date = $day['date'];
        foreach ($entries as $e) {
            if ($e['mode'] !== 'hide' || !calendarEntryCovers($e, $date)) continue;
            $type = (string) $e['entry_type'];
            $day['special'] = array_values(array_filter(
                $day['special'],
                static fn(array $s): bool => !empty($s['custom']) || ($type !== 'all' && $s['type'] !== $type)
            ));
        }
        foreach ($entries as $e) {
            if ($e['mode'] !== 'add' || !calendarEntryCovers($e, $date)) continue;
            $text = static fn($v): ?string => $v !== null && $v !== '' ? (string) $v : null;
            $day['special'][] = [
                'type'           => (string) $e['entry_type'],
                'ta'             => (string) $e['title_ta'],
                'en'             => (string) $e['title_en'],
                'id'             => (int) $e['id'],
                'custom'         => true,
                'description_ta' => $text($e['description_ta']),
                'description_en' => $text($e['description_en']),
                'pooja_id'       => $e['pooja_id'] !== null ? (int) $e['pooja_id'] : null,
                'event_id'       => $e['event_id'] !== null ? (int) $e['event_id'] : null,
                'end_date'       => $text($e['end_date']),
            ];
        }
    }
    unset($day);
    return $days;
}
