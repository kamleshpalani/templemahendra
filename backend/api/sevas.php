<?php
// backend/api/sevas.php — GET /api/sevas[?featured=1][&limit=50]
//
// The active sevas in display order, in both languages (migration 020):
//   name_ta, name_en, description_ta, description_en, timing_ta, timing_en,
//   amount, is_featured, is_bookable
// plus the old `description` key, kept for one release so pages that still
// read it keep working. is_bookable = false means the seva is listed with its
// price but cannot be booked from the website. Before migration 020 the old
// column stands in for both languages and every seva is bookable.

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_guard.php';

$limit    = max(1, min(intParam('limit', 50), 100));
$featured = boolParam('featured');

$bilingual = publicGuardHasColumn('sevas', 'description_ta') && publicGuardHasColumn('sevas', 'timing_ta') && publicGuardHasColumn('sevas', 'is_bookable');

$select = $bilingual
    ? 'id, name_ta, name_en, description, COALESCE(description_ta, description) AS description_ta,
       COALESCE(description_en, description) AS description_en, timing_ta, timing_en, amount, is_featured, is_bookable'
    : 'id, name_ta, name_en, description, description AS description_ta, description AS description_en,
       NULL AS timing_ta, NULL AS timing_en, amount, is_featured, 1 AS is_bookable';

$select .= ', service_kind, delivery_fee';
$sql = 'SELECT ' . $select . ' FROM sevas WHERE is_active = 1';
if ($featured) {
    $sql .= ' AND is_featured = 1';
}
$sql .= ' ORDER BY sort_order ASC, id ASC LIMIT :limit';

$db   = getDB();
$stmt = $db->prepare($sql);
$stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
$stmt->execute();

$rows = [];
foreach ($stmt->fetchAll() as $r) {
    $rows[] = [
        'id'             => (int) $r['id'],
        'name_ta'        => (string) $r['name_ta'],
        'name_en'        => (string) $r['name_en'],
        'description_ta' => $r['description_ta'],
        'description_en' => $r['description_en'],
        'description'    => $r['description'],
        'timing_ta'      => $r['timing_ta'],
        'timing_en'      => $r['timing_en'],
        'amount'         => $r['amount'],
        'is_featured'    => (int) $r['is_featured'],
        'is_bookable'    => (bool) $r['is_bookable'],
        'service_kind'   => $r['service_kind'],
        'delivery_fee'   => $r['delivery_fee'],
    ];
}

header('Cache-Control: public, max-age=120');
sendJson($rows);
