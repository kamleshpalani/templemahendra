<?php
/**
 * backend/includes/notify/categories.php — what a notification is about.
 *
 * Categories are rows the committee can edit (labels, icon, order, whether a
 * category is offered at all). The one thing that is not theirs to change is a
 * category's `kind`, because the kind decides the devotee's rights over it:
 *
 *   transactional, security, critical   cannot be muted (a booking confirmation,
 *                                       a password reset, an emergency closure)
 *   informational, promotional          can be muted; promotional additionally
 *                                       needs the devotee's opt-in
 */

require_once __DIR__ . '/time.php';

const NOTIFY_KINDS         = ['transactional', 'security', 'critical', 'informational', 'promotional'];
const NOTIFY_MUTABLE_KINDS = ['informational', 'promotional'];

/**
 * Every category row keyed by key, cached for the request. $reset forgets the
 * cache (the admin category editor calls notifyCategoriesForget() after a save).
 */
function notifyCategoriesLoad(bool $reset = false): array
{
    static $cache = null;
    if ($reset) {
        $cache = null;
        return [];
    }
    if ($cache !== null) return $cache;
    if (!notifyTablesExist()) return [];

    try {
        $stmt = getDB()->prepare(
            'SELECT `key`, label_ta, label_en, icon, kind, default_on, is_active, sort_order, updated_by, updated_at
               FROM notification_categories
              ORDER BY sort_order, `key`'
        );
        $stmt->execute();
        $rows = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $r['default_on'] = (int) $r['default_on'];
            $r['is_active']  = (int) $r['is_active'];
            $r['sort_order'] = (int) $r['sort_order'];
            $r['mutable']    = in_array($r['kind'], NOTIFY_MUTABLE_KINDS, true);
            $rows[(string) $r['key']] = $r;
        }
        return $cache = $rows;
    } catch (Throwable $e) {
        error_log('[notify] categories unavailable: ' . $e->getMessage());
        return [];
    }
}

function notifyCategoriesForget(): void
{
    notifyCategoriesLoad(true);
}

/** key => row + ['mutable' => bool], in the committee's order. */
function notifyCategories(bool $activeOnly = true): array
{
    $all = notifyCategoriesLoad();
    return $activeOnly ? array_filter($all, static fn(array $c): bool => $c['is_active'] === 1) : $all;
}

/**
 * One category, active or not. An inactive category is still the category of
 * every notification already sent under it, so lookups must keep finding it.
 */
function notifyCategory(string $key): ?array
{
    return notifyCategoriesLoad()[$key] ?? null;
}

/**
 * The kind that governs a category. A key with no row (deleted, or mistyped by
 * a caller) is treated as informational: the kind that asks for the most
 * consent, so a mistake can only ever send less.
 */
function notifyCategoryKind(string $key): string
{
    return notifyCategory($key)['kind'] ?? 'informational';
}

/** A category's label in a language: Tamil for 'ta', English for every other. */
function notifyCategoryLabel(string $key, string $lang): string
{
    $c = notifyCategory($key);
    if ($c === null) return $key;
    return $lang === 'ta' ? (string) $c['label_ta'] : (string) $c['label_en'];
}
