<?php
/**
 * backend/api/search.php — one search box across everything a visitor can read.
 *
 *   GET /api/search?q=abhishekam[&limit=20]
 *
 * Covers the database (sevas, events, poojas, announcements, gallery captions)
 * and the handful of static pages, which are indexed here by hand because they
 * are curated content rather than rows. Matching is deliberately plain LIKE:
 * the corpus is a few hundred short bilingual records, so a full-text index
 * would add operational weight for no gain, and MySQL full-text does not
 * tokenise Tamil usefully anyway.
 *
 * Results carry both languages so the client renders in whichever is active.
 */

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    sendError('Method not allowed', 405);
}

$q     = trim((string) ($_GET['q'] ?? ''));
$limit = max(1, min(50, (int) ($_GET['limit'] ?? 20)));

if (mb_strlen($q) < 2) {
    sendJson(['query' => $q, 'total' => 0, 'groups' => [], 'message' => 'Type at least two characters.']);
}

$like = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $q) . '%';
$db   = getDB();
$out  = [];

/** Rank: a title that starts with the term beats one that merely contains it. */
function scoreOf(string $q, string ...$fields): int
{
    $q = mb_strtolower($q);
    $best = 0;
    foreach ($fields as $f) {
        $f = mb_strtolower((string) $f);
        if ($f === '') continue;
        if ($f === $q)                    $best = max($best, 100);
        elseif (str_starts_with($f, $q))  $best = max($best, 80);
        elseif (str_contains($f, $q))     $best = max($best, 50);
    }
    return $best;
}

$add = function (string $type, array $item) use (&$out) {
    $out[$type][] = $item;
};

try {
    // ── Sevas ───────────────────────────────────────────────────────────────
    $stmt = $db->prepare(
        'SELECT id, name_ta, name_en, description, amount FROM sevas
          WHERE is_active = 1 AND (name_ta LIKE :q1 OR name_en LIKE :q2 OR description LIKE :q3)
          ORDER BY sort_order LIMIT 25'
    );
    $stmt->execute([':q1' => $like, ':q2' => $like, ':q3' => $like]);
    foreach ($stmt->fetchAll() as $r) {
        $add('sevas', [
            'title_ta' => $r['name_ta'], 'title_en' => $r['name_en'],
            'sub_ta'   => $r['amount'] !== null ? '₹' . rtrim(rtrim(number_format((float) $r['amount'], 2), '0'), '.') : null,
            'sub_en'   => $r['amount'] !== null ? '₹' . rtrim(rtrim(number_format((float) $r['amount'], 2), '0'), '.') : null,
            'snippet'  => $r['description'],
            'url'      => '/sevas',
            'score'    => scoreOf($q, $r['name_ta'], $r['name_en']),
        ]);
    }

    // ── Events ──────────────────────────────────────────────────────────────
    $stmt = $db->prepare(
        'SELECT id, title_ta, title_en, description, event_date FROM events
          WHERE is_active = 1 AND (title_ta LIKE :q1 OR title_en LIKE :q2 OR description LIKE :q3)
          ORDER BY event_date >= CURDATE() DESC, event_date ASC LIMIT 25'
    );
    $stmt->execute([':q1' => $like, ':q2' => $like, ':q3' => $like]);
    foreach ($stmt->fetchAll() as $r) {
        $add('events', [
            'title_ta' => $r['title_ta'], 'title_en' => $r['title_en'],
            'sub_ta'   => $r['event_date'], 'sub_en' => $r['event_date'],
            'snippet'  => $r['description'],
            'url'      => '/events',
            'date'     => $r['event_date'],
            'score'    => scoreOf($q, $r['title_ta'], $r['title_en']),
        ]);
    }

    // ── Poojas ──────────────────────────────────────────────────────────────
    $stmt = $db->prepare(
        'SELECT id, name_ta, name_en, description_ta, description_en, pooja_date, pooja_time FROM poojas
          WHERE is_active = 1 AND (name_ta LIKE :q1 OR name_en LIKE :q2 OR description_ta LIKE :q3 OR description_en LIKE :q4)
          ORDER BY pooja_date >= CURDATE() DESC, pooja_date ASC LIMIT 25'
    );
    $stmt->execute([':q1' => $like, ':q2' => $like, ':q3' => $like, ':q4' => $like]);
    foreach ($stmt->fetchAll() as $r) {
        $add('poojas', [
            'title_ta' => $r['name_ta'], 'title_en' => $r['name_en'],
            'sub_ta'   => trim($r['pooja_date'] . ' ' . ($r['pooja_time'] ?? '')),
            'sub_en'   => trim($r['pooja_date'] . ' ' . ($r['pooja_time'] ?? '')),
            'snippet'  => $r['description_en'] ?: $r['description_ta'],
            'url'      => '/panchangam',
            'date'     => $r['pooja_date'],
            'score'    => scoreOf($q, $r['name_ta'], $r['name_en']),
        ]);
    }

    // ── Announcements ───────────────────────────────────────────────────────
    $stmt = $db->prepare(
        'SELECT id, title, body, created_at FROM announcements
          WHERE is_active = 1 AND (title LIKE :q1 OR body LIKE :q2)
          ORDER BY created_at DESC LIMIT 20'
    );
    $stmt->execute([':q1' => $like, ':q2' => $like]);
    foreach ($stmt->fetchAll() as $r) {
        $add('announcements', [
            'title_ta' => $r['title'], 'title_en' => $r['title'],
            'sub_ta'   => null, 'sub_en' => null,
            'snippet'  => $r['body'],
            'url'      => '/',
            'date'     => $r['created_at'],
            'score'    => scoreOf($q, $r['title']),
        ]);
    }

    // ── Gallery captions ────────────────────────────────────────────────────
    $stmt = $db->prepare(
        'SELECT id, caption FROM gallery WHERE is_active = 1 AND caption LIKE :q ORDER BY created_at DESC LIMIT 12'
    );
    $stmt->execute([':q' => $like]);
    foreach ($stmt->fetchAll() as $r) {
        $add('gallery', [
            'title_ta' => $r['caption'], 'title_en' => $r['caption'],
            'sub_ta'   => null, 'sub_en' => null, 'snippet' => null,
            'url'      => '/gallery',
            'score'    => scoreOf($q, (string) $r['caption']),
        ]);
    }
} catch (Throwable $e) {
    error_log('[search] ' . $e->getMessage());
}

/* ── Static pages ───────────────────────────────────────────────────────────
   Curated content that does not live in a table. Keywords carry the words a
   devotee is likely to type, in both languages, including the ones that never
   appear in the visible heading (a person searching "80G" wants the Trust). */
$PAGES = [
    ['url' => '/about#history',       'ta' => 'கோவில் வரலாறு', 'en' => 'Temple history',
     'sub_ta' => 'பற்றி', 'sub_en' => 'About', 'kw' => 'history varalaru kumbabhishekam 1990 2012 naar petti gopuram origins clan deity kula deivam வரலாறு கோவில் வரலாறு குலதெய்வம் கும்பாபிஷேகம்'],
    ['url' => '/about#deities',       'ta' => 'குலதெய்வங்கள்', 'en' => 'Our clan deities',
     'sub_ta' => 'பற்றி', 'sub_en' => 'About', 'kw' => 'deities lingammal renukadevi chinnammal amman goddess குலதெய்வம் தெய்வம் அம்மன் லிங்கம்மாள் ரேணுகாதேவி சின்னம்மாள்'],
    ['url' => '/about#trust',         'ta' => 'தர்ம அறக்கட்டளை', 'en' => 'Dharma Trust',
     'sub_ta' => 'பற்றி', 'sub_en' => 'About', 'kw' => 'trust registration 80g pan tax exemption bank ifsc account number receipt aRakkattalai அறக்கட்டளை தர்ம அறக்கட்டளை ரசீது வரி விலக்கு வங்கி கணக்கு'],
    ['url' => '/about#committee',     'ta' => 'திருக்கோவில் கமிட்டி', 'en' => 'Temple committee',
     'sub_ta' => 'பற்றி', 'sub_en' => 'About', 'kw' => 'committee president secretary treasurer contact members phone gengaiah kumar கமிட்டி தலைவர் செயலாளர் பொருளாளர் உறுப்பினர்கள்'],
    ['url' => '/about#timings',       'ta' => 'வழிபாட்டு நேரங்கள்', 'en' => 'Pooja timings',
     'sub_ta' => 'பற்றி', 'sub_en' => 'About', 'kw' => 'timings hours open close morning evening thiruvanandal kalasanthi uchikalam sayarakshai arthajama நேரம் கோயில் நேரம் வழிபாட்டு நேரம் காலை மாலை திறப்பு'],
    ['url' => '/about#land-donation', 'ta' => 'அன்னதான கூடம்', 'en' => 'Annadanam hall',
     'sub_ta' => 'பற்றி', 'sub_en' => 'About', 'kw' => 'annadanam hall land donation subbaram construction toilets rest rooms அன்னதானம் அன்னதான கூடம் நிலம் கட்டிடம்'],
    ['url' => '/donations',           'ta' => 'நன்கொடை', 'en' => 'Donate',
     'sub_ta' => 'நன்கொடை', 'sub_en' => 'Donations', 'kw' => 'donate donation nankodai bank transfer cheque 80g receipt kumbabhishekam annadanam நன்கொடை ரசீது வங்கி பரிமாற்றம் காசோலை அன்னதானம்'],
    ['url' => '/sevas',               'ta' => 'சேவை பதிவு', 'en' => 'Book a seva',
     'sub_ta' => 'சேவைகள்', 'sub_en' => 'Sevas', 'kw' => 'book booking seva pooja archana abhishekam annadanam sponsor request சேவை பதிவு பூஜை அர்ச்சனை அபிஷேகம் அன்னதானம்'],
    ['url' => '/panchangam',          'ta' => 'பஞ்சாங்க நாட்காட்டி', 'en' => 'Panchangam calendar',
     'sub_ta' => 'பஞ்சாங்கம்', 'sub_en' => 'Panchangam', 'kw' => 'panchangam calendar pournami amavasai ekadasi sashti pradosham nalla neram rahu kalam yamagandam tithi பஞ்சாங்கம் நாட்காட்டி பௌர்ணமி அமாவாசை ஏகாதசி சஷ்டி பிரதோஷம் நல்ல நேரம் ராகு காலம்'],
    ['url' => '/contact',             'ta' => 'தொடர்பு கொள்ளுங்கள்', 'en' => 'Contact and directions',
     'sub_ta' => 'தொடர்பு', 'sub_en' => 'Contact', 'kw' => 'contact address directions map phone whatsapp email pudupatti thiruvengadam tenkasi reach visit தொடர்பு முகவரி வழிகாட்டி திசை வரைபடம் தொலைபேசி புதுப்பட்டி தென்காசி'],
    ['url' => '/events',              'ta' => 'நிகழ்வுகள் & திருவிழாக்கள்', 'en' => 'Events and festivals',
     'sub_ta' => 'நிகழ்வுகள்', 'sub_en' => 'Events', 'kw' => 'events festivals thiruvizha pournami shivaratri karthigai calendar dates நிகழ்வுகள் திருவிழா பௌர்ணமி சிவராத்திரி கார்த்திகை தேதிகள்'],
];
foreach ($PAGES as $p) {
    $score = scoreOf($q, $p['ta'], $p['en']);
    if ($score === 0 && mb_stripos($p['kw'], $q) !== false) $score = 40;
    if ($score > 0) {
        $add('pages', [
            'title_ta' => $p['ta'], 'title_en' => $p['en'],
            'sub_ta'   => $p['sub_ta'], 'sub_en' => $p['sub_en'],
            'snippet'  => null, 'url' => $p['url'], 'score' => $score,
        ]);
    }
}

/* ── Assemble ───────────────────────────────────────────────────────────── */
$LABELS = [
    'pages'         => ['ta' => 'பக்கங்கள்',   'en' => 'Pages'],
    'sevas'         => ['ta' => 'சேவைகள்',     'en' => 'Sevas'],
    'events'        => ['ta' => 'நிகழ்வுகள்',  'en' => 'Events'],
    'poojas'        => ['ta' => 'பூஜைகள்',     'en' => 'Poojas'],
    'announcements' => ['ta' => 'அறிவிப்புகள்', 'en' => 'Announcements'],
    'gallery'       => ['ta' => 'படங்கள்',     'en' => 'Gallery'],
];

$groups = [];
$total  = 0;
foreach ($LABELS as $type => $label) {
    if (empty($out[$type])) continue;
    usort($out[$type], fn($a, $b) => $b['score'] <=> $a['score']);
    $items = array_slice($out[$type], 0, $limit);
    $total += count($items);
    $groups[] = ['type' => $type, 'label_ta' => $label['ta'], 'label_en' => $label['en'], 'items' => $items];
}

sendJson(['query' => $q, 'total' => $total, 'groups' => $groups]);
