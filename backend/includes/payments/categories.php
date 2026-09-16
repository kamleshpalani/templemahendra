<?php
/**
 * backend/includes/payments/categories.php — donation purposes
 * (donation_categories, SPEC §3.1).
 *
 * A category's slug is what donations.purpose stores, so pledges saved before
 * the table existed still find their label. Inactive categories are hidden
 * from donors but keep labelling old rows.
 */

/** One donation_categories row in the shape every caller uses. */
function payCategoryShape(array $row): array
{
    return [
        'id'               => (int) $row['id'],
        'slug'             => (string) $row['slug'],
        'name'             => ['ta' => (string) $row['name_ta'], 'en' => (string) $row['name_en']],
        'description'      => ['ta' => (string) ($row['description_ta'] ?? ''), 'en' => (string) ($row['description_en'] ?? '')],
        'suggested_amount' => $row['suggested_amount'] !== null ? payAmountFormat((string) $row['suggested_amount'], 'INR') : null,
        'sort_order'       => (int) $row['sort_order'],
        'is_active'        => (int) $row['is_active'] === 1,
    ];
}

/** Every category (or only active ones), in display order. [] when the table is missing. */
function payCategoriesAll(PDO $db, bool $activeOnly = false): array
{
    try {
        $rows = $db->query(
            'SELECT id, slug, name_ta, name_en, description_ta, description_en, suggested_amount, sort_order, is_active
               FROM donation_categories'
            . ($activeOnly ? ' WHERE is_active = 1' : '')
            . ' ORDER BY sort_order, id'
        )->fetchAll(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        error_log('[payments] donation categories unavailable: ' . $e->getMessage());
        return [];
    }
    return array_map('payCategoryShape', $rows);
}

/** The categories donors can choose, in display order. */
function payCategoriesActive(PDO $db): array
{
    return payCategoriesAll($db, true);
}

/** One category by slug (optionally only when active), or null. */
function payCategoryBySlug(PDO $db, string $slug, bool $activeOnly = false): ?array
{
    if (!preg_match('/^[a-z0-9_]{2,40}$/D', $slug)) return null;
    try {
        $stmt = $db->prepare(
            'SELECT id, slug, name_ta, name_en, description_ta, description_en, suggested_amount, sort_order, is_active
               FROM donation_categories WHERE slug = :s' . ($activeOnly ? ' AND is_active = 1' : '')
        );
        $stmt->execute([':s' => $slug]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        error_log('[payments] donation category lookup failed: ' . $e->getMessage());
        return null;
    }
    return $row ? payCategoryShape($row) : null;
}

/** slug => ['ta' => …, 'en' => …] for every category, active or not (cached per request). */
function payCategoryNames(PDO $db, bool $refresh = false): array
{
    static $names = null;
    if ($refresh) $names = null;
    if ($names !== null) return $names;
    $names = [];
    foreach (payCategoriesAll($db) as $c) $names[$c['slug']] = $c['name'];
    return $names;
}

/**
 * The name of a category slug in 'ta' or 'en', or null when the slug is not a
 * category (a free-text pledge purpose, or none).
 */
function payCategoryLabel(PDO $db, ?string $slug, string $lang = 'en'): ?string
{
    $slug = trim((string) $slug);
    if ($slug === '') return null;
    $names = payCategoryNames($db);
    if (!isset($names[$slug])) return null;
    return $names[$slug][$lang === 'ta' ? 'ta' : 'en'];
}

/** A category as GET /api/payments/config shows it. */
function payCategoryPublic(array $category): array
{
    return [
        'slug'            => $category['slug'],
        'name'            => $category['name'],
        'description'     => $category['description'],
        'suggestedAmount' => $category['suggested_amount'] !== null ? payNumberOut($category['suggested_amount']) : null,
    ];
}
