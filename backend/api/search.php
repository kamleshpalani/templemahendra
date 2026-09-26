<?php
/**
 * backend/api/search.php — one search box across everything a visitor can read.
 *
 *   GET /api/search?q=abhishekam[&limit=20]
 *
 * Covers the database (sevas, events, poojas, announcements, gallery captions
 * and alt text, videos, the CMS pages of migration 025) and the handful of
 * static pages, which are indexed here by hand because they are curated
 * content rather than rows. Matching is deliberately plain LIKE: the corpus is
 * a few hundred short bilingual records, so a full-text index would add
 * operational weight for no gain, and MySQL full-text does not tokenise Tamil
 * usefully anyway.
 *
 * Every result carries both languages so the client renders in whichever is
 * active: title_ta / title_en, sub_ta / sub_en (a price, a date, a category),
 * snippet_ta / snippet_en (an excerpt of the matching text, ~160 characters
 * around the term) and `url`, an in-site path. The old single `snippet` key
 * (English, else Tamil) is kept for one release for the pages that still read
 * it. `score` ranks within a group: 100 exact title, 80 title starts with the
 * term, 50 title contains it, 40 only the body or a keyword matched.
 *
 * Where each hit points (the public site's deep links):
 *   sevas          /sevas?seva=<id> when the seva can be booked online, else
 *                  /sevas (Sevas.jsx opens the booking form for ?seva=)
 *   events         /events/<id>
 *   poojas         /panchangam
 *   announcements  /
 *   gallery        /gallery?photo=<id> (Gallery.jsx opens that photo)
 *   videos         /videos[?category=<slug>]
 *   pages          the About anchors for the CMS pages "mission" and "history",
 *                  /about for any other CMS page, and the curated list below
 *
 * The bilingual columns of migrations 020 (announcements, events, sevas), 021
 * (gallery alt text and albums) and the `pages` table of 025 are read only
 * when publicGuardHasColumn() finds them, so a database without those
 * migrations still answers, with the old single-language columns standing in.
 * Announcements honour is_active and the start_date / end_date window exactly
 * as /api/announcements does; photos in a hidden album and hidden CMS pages
 * never match.
 */

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_guard.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    sendError('Method not allowed', 405);
}

$q     = is_string($_GET['q'] ?? null) ? trim((string) $_GET['q']) : '';
$limit = max(1, min(50, (int) ($_GET['limit'] ?? 20)));

if (mb_strlen($q) < 2) {
    sendJson(['query' => $q, 'total' => 0, 'groups' => [], 'message' => 'Type at least two characters.']);
}

$like = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $q) . '%';
$db   = getDB();
$out  = [];

/** Rank: a title that starts with the term beats one that merely contains it. */
function scoreOf(string $q, ?string ...$fields): int
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

/**
 * A short excerpt of $text for the result card: whitespace collapsed, at most
 * $len characters, centred on the first occurrence of the term when the text
 * is longer than that (a CMS page body can run to pages). Null for blank text.
 */
function excerptOf(?string $text, string $q, int $len = 160): ?string
{
    $text = trim((string) preg_replace('/\s+/u', ' ', (string) $text));
    if ($text === '') return null;
    $total = mb_strlen($text);
    if ($total <= $len) return $text;
    $pos   = mb_stripos($text, $q);
    $start = $pos === false ? 0 : max(0, $pos - intdiv($len, 4));
    if ($start > 0) {
        // Back up to a word boundary so the excerpt never opens mid-word.
        $space = mb_strrpos(mb_substr($text, 0, $start), ' ');
        if ($space !== false && $start - $space < 30) $start = $space + 1;
    }
    if ($start + $len > $total) $start = max(0, $total - $len);
    $piece = trim(mb_substr($text, $start, $len));
    return ($start > 0 ? '…' : '') . $piece . ($start + $len < $total ? '…' : '');
}

/** The three snippet keys every result carries (the single `snippet` is English, else Tamil, for one release). */
function snippetsOf(?string $ta, ?string $en, string $q): array
{
    $sta = excerptOf($ta, $q);
    $sen = excerptOf($en, $q);
    return ['snippet_ta' => $sta, 'snippet_en' => $sen, 'snippet' => $sen ?? $sta];
}

/** "(a LIKE :q0 OR b LIKE :q1 …)" with its bound values — PDO needs a distinct placeholder per use. */
function likeAny(array $cols, string $like): array
{
    $parts = $params = [];
    foreach (array_values($cols) as $i => $c) {
        $parts[]           = $c . ' LIKE :q' . $i;
        $params[':q' . $i] = $like;
    }
    return ['(' . implode(' OR ', $parts) . ')', $params];
}

$add = function (string $type, array $item) use (&$out) {
    $out[$type][] = $item;
};

// What this database has (migrations 020, 021, 025); each check is cached per request.
$annBilingual = publicGuardHasColumn('announcements', 'title_ta') && publicGuardHasColumn('announcements', 'title_en')
    && publicGuardHasColumn('announcements', 'body_ta') && publicGuardHasColumn('announcements', 'body_en');
$annWindowed  = publicGuardHasColumn('announcements', 'start_date') && publicGuardHasColumn('announcements', 'end_date');
$evBilingual  = publicGuardHasColumn('events', 'description_ta') && publicGuardHasColumn('events', 'description_en')
    && publicGuardHasColumn('events', 'venue_ta') && publicGuardHasColumn('events', 'venue_en') && publicGuardHasColumn('events', 'end_date');
$sevaBilingual = publicGuardHasColumn('sevas', 'description_ta') && publicGuardHasColumn('sevas', 'description_en')
    && publicGuardHasColumn('sevas', 'timing_ta') && publicGuardHasColumn('sevas', 'timing_en') && publicGuardHasColumn('sevas', 'is_bookable');
$galAlt    = publicGuardHasColumn('gallery', 'alt_ta') && publicGuardHasColumn('gallery', 'alt_en');
$galAlbums = publicGuardHasColumn('gallery', 'album_id') && publicGuardHasColumn('gallery_albums', 'is_active');
$cmsPages  = publicGuardHasColumn('pages', 'slug') && publicGuardHasColumn('pages', 'is_active')
    && publicGuardHasColumn('pages', 'body_ta') && publicGuardHasColumn('pages', 'body_en');
$videoTables = publicGuardHasColumn('videos', 'category_id') && publicGuardHasColumn('video_categories', 'slug');

$cmsUrls = []; // CMS hits by URL, so the curated entry for the same anchor is not listed twice

try {
    // ── Sevas ───────────────────────────────────────────────────────────────
    $select = $sevaBilingual
        ? 'id, name_ta, name_en, COALESCE(description_ta, description) AS description_ta,
           COALESCE(description_en, description) AS description_en, timing_ta, timing_en, amount, is_bookable'
        : 'id, name_ta, name_en, description AS description_ta, description AS description_en,
           NULL AS timing_ta, NULL AS timing_en, amount, 1 AS is_bookable';
    [$where, $params] = likeAny(
        array_merge(['name_ta', 'name_en', 'description'], $sevaBilingual ? ['description_ta', 'description_en', 'timing_ta', 'timing_en'] : []),
        $like
    );
    $stmt = $db->prepare('SELECT ' . $select . ' FROM sevas WHERE is_active = 1 AND ' . $where . ' ORDER BY sort_order ASC, id ASC LIMIT 25');
    $stmt->execute($params);
    foreach ($stmt->fetchAll() as $r) {
        $price = $r['amount'] !== null ? '₹' . rtrim(rtrim(number_format((float) $r['amount'], 2), '0'), '.') : null;
        $add('sevas', [
            'title_ta' => $r['name_ta'], 'title_en' => $r['name_en'],
            'sub_ta'   => $price, 'sub_en' => $price,
            // The description, else the timing ("Daily 7–9 am") when that is all the seva says.
            ...snippetsOf($r['description_ta'] ?: $r['timing_ta'], $r['description_en'] ?: $r['timing_en'], $q),
            'url'      => (int) $r['is_bookable'] === 1 ? '/sevas?seva=' . (int) $r['id'] : '/sevas',
            'score'    => scoreOf($q, $r['name_ta'], $r['name_en']) ?: 40, // matched in the description or timing only
        ]);
    }

    // ── Events ──────────────────────────────────────────────────────────────
    $select = $evBilingual
        ? 'id, title_ta, title_en, COALESCE(description_ta, description) AS description_ta,
           COALESCE(description_en, description) AS description_en, event_date, end_date, venue_ta, venue_en'
        : 'id, title_ta, title_en, description AS description_ta, description AS description_en,
           event_date, NULL AS end_date, NULL AS venue_ta, NULL AS venue_en';
    [$where, $params] = likeAny(
        array_merge(['title_ta', 'title_en', 'description'], $evBilingual ? ['description_ta', 'description_en', 'venue_ta', 'venue_en'] : []),
        $like
    );
    $stmt = $db->prepare(
        'SELECT ' . $select . ' FROM events WHERE is_active = 1 AND ' . $where
        . ' ORDER BY ' . ($evBilingual ? 'COALESCE(end_date, event_date)' : 'event_date') . ' >= CURDATE() DESC, event_date ASC LIMIT 25'
    );
    $stmt->execute($params);
    foreach ($stmt->fetchAll() as $r) {
        $when = (string) $r['event_date'] . ($r['end_date'] !== null && $r['end_date'] !== $r['event_date'] ? ' – ' . $r['end_date'] : '');
        $add('events', [
            'title_ta' => $r['title_ta'], 'title_en' => $r['title_en'],
            'sub_ta'   => $when . ($r['venue_ta'] !== null && $r['venue_ta'] !== '' ? ' · ' . $r['venue_ta'] : ''),
            'sub_en'   => $when . ($r['venue_en'] !== null && $r['venue_en'] !== '' ? ' · ' . $r['venue_en'] : ''),
            ...snippetsOf($r['description_ta'], $r['description_en'], $q),
            'url'      => '/events/' . (int) $r['id'],
            'date'     => $r['event_date'],
            'score'    => scoreOf($q, $r['title_ta'], $r['title_en']) ?: 40, // matched in the description or venue only
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
            ...snippetsOf($r['description_ta'], $r['description_en'], $q),
            'url'      => '/panchangam',
            'date'     => $r['pooja_date'],
            'score'    => scoreOf($q, $r['name_ta'], $r['name_en']) ?: 40, // matched in the description only
        ]);
    }

    // ── Announcements (migration 020: both languages, publish window) ───────
    // The old column stands in when the new one was never filled, as
    // /api/announcements does, so no notice is served with an empty title.
    $select = $annBilingual
        ? 'id, COALESCE(NULLIF(title_ta, \'\'), title) AS title_ta, COALESCE(NULLIF(title_en, \'\'), title) AS title_en,
           COALESCE(body_ta, body) AS body_ta, COALESCE(body_en, body) AS body_en, created_at'
        : 'id, title AS title_ta, title AS title_en, body AS body_ta, body AS body_en, created_at';
    [$where, $params] = likeAny(
        array_merge(['title', 'body'], $annBilingual ? ['title_ta', 'title_en', 'body_ta', 'body_en'] : []),
        $like
    );
    $sql = 'SELECT ' . $select . ' FROM announcements WHERE is_active = 1 AND ' . $where;
    if ($annWindowed) {
        // Temple time, the same clock the homepage cards and /api/announcements use.
        $today = (new DateTime('now', new DateTimeZone('Asia/Kolkata')))->format('Y-m-d');
        $sql .= ' AND (start_date IS NULL OR start_date <= :from) AND (end_date IS NULL OR end_date >= :until)';
        $params[':from']  = $today;
        $params[':until'] = $today;
    }
    $stmt = $db->prepare($sql . ' ORDER BY created_at DESC, id DESC LIMIT 20');
    $stmt->execute($params);
    foreach ($stmt->fetchAll() as $r) {
        $add('announcements', [
            'title_ta' => (string) $r['title_ta'], 'title_en' => (string) $r['title_en'],
            'sub_ta'   => null, 'sub_en' => null,
            ...snippetsOf($r['body_ta'], $r['body_en'], $q),
            'url'      => '/',
            'date'     => $r['created_at'],
            'score'    => scoreOf($q, $r['title_ta'], $r['title_en']) ?: 40, // matched in the body only
        ]);
    }

    // ── Gallery: captions and alt text (migration 021); a hidden album hides its photos ──
    $select = 'g.id, g.caption' . ($galAlt ? ', g.alt_ta, g.alt_en' : ', NULL AS alt_ta, NULL AS alt_en');
    $from   = 'gallery g' . ($galAlbums ? ' LEFT JOIN gallery_albums a ON a.id = g.album_id' : '');
    [$where, $params] = likeAny(array_merge(['g.caption'], $galAlt ? ['g.alt_ta', 'g.alt_en'] : []), $like);
    $stmt = $db->prepare(
        'SELECT ' . $select . ' FROM ' . $from . ' WHERE g.is_active = 1'
        . ($galAlbums ? ' AND (g.album_id IS NULL OR a.is_active = 1)' : '')
        . ' AND ' . $where . ' ORDER BY g.created_at DESC, g.id DESC LIMIT 12'
    );
    $stmt->execute($params);
    foreach ($stmt->fetchAll() as $r) {
        // The caption is the visible label in both languages; the alt text is the
        // fallback title and, when it says something the caption does not, the snippet.
        $caption  = trim((string) $r['caption']);
        $title_ta = $caption !== '' ? $caption : (trim((string) $r['alt_ta']) ?: trim((string) $r['alt_en']));
        $title_en = $caption !== '' ? $caption : (trim((string) $r['alt_en']) ?: trim((string) $r['alt_ta']));
        $alt_ta   = trim((string) $r['alt_ta']) !== $title_ta ? $r['alt_ta'] : null;
        $alt_en   = trim((string) $r['alt_en']) !== $title_en ? $r['alt_en'] : null;
        $add('gallery', [
            'title_ta' => $title_ta, 'title_en' => $title_en,
            'sub_ta'   => null, 'sub_en' => null,
            ...snippetsOf($alt_ta, $alt_en, $q),
            'url'      => '/gallery?photo=' . (int) $r['id'],
            'score'    => scoreOf($q, $caption, $r['alt_ta'], $r['alt_en']),
        ]);
    }

    // ── CMS pages (migration 025): what the committee wrote in Content → Pages ──
    // Only shown pages with a body: the About page renders nothing for a page
    // without one, so a hit would lead nowhere. "mission" and "history" are
    // the About page's own sections; any other page lands on /about.
    if ($cmsPages) {
        [$where, $params] = likeAny(['title_ta', 'title_en', 'body_ta', 'body_en'], $like);
        $stmt = $db->prepare(
            'SELECT id, slug, title_ta, title_en, body_ta, body_en FROM pages
              WHERE is_active = 1 AND (COALESCE(body_ta, \'\') <> \'\' OR COALESCE(body_en, \'\') <> \'\') AND ' . $where
            . ' ORDER BY sort_order ASC, id ASC LIMIT 20'
        );
        $stmt->execute($params);
        foreach ($stmt->fetchAll() as $r) {
            $url   = match ((string) $r['slug']) { 'mission' => '/about#mission', 'history' => '/about#history', default => '/about' };
            $score = scoreOf($q, $r['title_ta'], $r['title_en']) ?: 40;
            $cmsUrls[$url] = true;
            $add('pages', [
                'title_ta' => (string) $r['title_ta'], 'title_en' => (string) $r['title_en'],
                'sub_ta'   => 'பற்றி', 'sub_en' => 'About',
                ...snippetsOf($r['body_ta'], $r['body_en'], $q),
                'url'      => $url,
                'score'    => $score,
            ]);
        }
    }

    // ── Videos (migration 017; hidden videos and hidden categories never match) ──
    // Asked only when the tables exist, so a site without 017 answers without
    // an error line in its log for every search.
    if ($videoTables) {
        try {
            $stmt = $db->prepare(
                'SELECT v.id, v.title_ta, v.title_en, v.published_on, c.slug AS category_slug, c.name_ta AS category_ta, c.name_en AS category_en
                   FROM videos v LEFT JOIN video_categories c ON c.id = v.category_id
                  WHERE v.is_active = 1 AND (v.category_id IS NULL OR c.is_active = 1)
                    AND (v.title_ta LIKE :q1 OR v.title_en LIKE :q2)
                  ORDER BY v.sort_order ASC, v.published_on DESC LIMIT 12'
            );
            $stmt->execute([':q1' => $like, ':q2' => $like]);
            foreach ($stmt->fetchAll() as $r) {
                $add('videos', [
                    'title_ta' => $r['title_ta'], 'title_en' => $r['title_en'],
                    'sub_ta'   => $r['category_ta'], 'sub_en' => $r['category_en'],
                    'snippet_ta' => null, 'snippet_en' => null, 'snippet' => null,
                    'url'      => '/videos' . ($r['category_slug'] !== null ? '?category=' . rawurlencode((string) $r['category_slug']) : ''),
                    'date'     => $r['published_on'],
                    'score'    => scoreOf($q, $r['title_ta'], $r['title_en']),
                ]);
            }
        } catch (Throwable $e) {
            // A videos table of another shape must not cost the other groups.
            error_log('[search] videos skipped: ' . $e->getMessage());
        }
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
    // People looking for the old sign-up or sign-in type those words too; the
    // family registration form is what replaced both.
    ['url' => '/register',            'ta' => 'குடும்பப் பதிவு', 'en' => 'Family registration',
     'sub_ta' => 'பதிவு', 'sub_en' => 'Register', 'kw' => 'register registration family members member household enrol enroll sign up signup join temple updates whatsapp பதிவு குடும்பம் குடும்பப் பதிவு உறுப்பினர் உறுப்பினர்கள்'],
    // Online giving and the four policy pages (docs/payments/SPEC.md §7.8).
    // Titles are the pages' own SEO titles, as in site_pages.php.
    ['url' => '/donate',              'ta' => 'இணையவழி நன்கொடை', 'en' => 'Donate online',
     'sub_ta' => 'நன்கொடை', 'sub_en' => 'Donations', 'kw' => 'donate online donation pay payment upi card credit card debit card net banking netbanking wallet ccavenue payment gateway receipt e-receipt 80g give இணையவழி ஆன்லைன் நன்கொடை பணம் செலுத்த யுபிஐ கார்டு நெட் பேங்கிங் ரசீது'],
    ['url' => '/privacy-policy',      'ta' => 'தனியுரிமைக் கொள்கை', 'en' => 'Privacy Policy',
     'sub_ta' => 'கொள்கைகள்', 'sub_en' => 'Policies', 'kw' => 'privacy policy personal data information details cookies security data protection தனியுரிமை தனிப்பட்ட தகவல் விவரங்கள் குக்கீ பாதுகாப்பு'],
    ['url' => '/terms-and-conditions', 'ta' => 'விதிமுறைகள் & நிபந்தனைகள்', 'en' => 'Terms & Conditions',
     'sub_ta' => 'கொள்கைகள்', 'sub_en' => 'Policies', 'kw' => 'terms conditions terms of use rules governing law jurisdiction court tenkasi விதிமுறைகள் நிபந்தனைகள் சட்டம் நீதிமன்றம்'],
    ['url' => '/refund-cancellation-policy', 'ta' => 'பணம் திருப்பி அளித்தல் & ரத்துக் கொள்கை', 'en' => 'Refund & Cancellation Policy',
     'sub_ta' => 'கொள்கைகள்', 'sub_en' => 'Policies', 'kw' => 'refund refunds cancel cancellation money back return duplicate payment failed payment seva cancellation 48 hours பணம் திருப்பி ரத்து திரும்பப் பெறுதல்'],
    ['url' => '/shipping-delivery-policy', 'ta' => 'அனுப்புதல் & விநியோகக் கொள்கை', 'en' => 'Shipping & Delivery Policy',
     'sub_ta' => 'கொள்கைகள்', 'sub_en' => 'Policies', 'kw' => 'shipping delivery courier post dispatch prasadam receipt delivery அனுப்புதல் விநியோகம் கூரியர் அஞ்சல் பிரசாதம்'],
    ['url' => '/videos',              'ta' => 'காணொளிகள்', 'en' => 'Videos',
     'sub_ta' => 'காணொளிகள்', 'sub_en' => 'Videos', 'kw' => 'videos video youtube recordings watch pooja festival discourse darshan recording காணொளி காணொளிகள் வீடியோ யூடியூப் பதிவுகள் சொற்பொழிவு'],
    // Live darshan (docs/live/SPEC-PHASE1.md §4.6). Title = the page's SEO title.
    ['url' => '/live-darshan',        'ta' => 'நேரடி தரிசனம்', 'en' => 'Live Darshan',
     'sub_ta' => 'நேரடி தரிசனம்', 'sub_en' => 'Live Darshan', 'kw' => 'live darshan stream streaming watch online video youtube pooja நேரடி தரிசனம் நேரடி ஒளிபரப்பு யூடியூப் நேரலை'],
    // The schedule page (docs/live/SPEC-PHASE2.md §1.3).
    ['url' => '/live-darshan/schedule', 'ta' => 'நேரடி தரிசன அட்டவணை', 'en' => 'Live Darshan schedule',
     'sub_ta' => 'நேரடி தரிசனம்', 'sub_en' => 'Live Darshan', 'kw' => 'schedule timetable programme today tomorrow this week festivals countdown அட்டவணை கால அட்டவணை live darshan நேரடி தரிசனம் இன்று நாளை இந்த வாரம் திருவிழா'],
];
foreach ($PAGES as $p) {
    if (isset($cmsUrls[$p['url']])) continue; // the committee's own page for this anchor already matched
    $score = scoreOf($q, $p['ta'], $p['en']);
    if ($score === 0 && mb_stripos($p['kw'], $q) !== false) $score = 40;
    if ($score > 0) {
        $add('pages', [
            'title_ta' => $p['ta'], 'title_en' => $p['en'],
            'sub_ta'   => $p['sub_ta'], 'sub_en' => $p['sub_en'],
            'snippet_ta' => null, 'snippet_en' => null, 'snippet' => null,
            'url' => $p['url'], 'score' => $score,
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
    'videos'        => ['ta' => 'காணொளிகள்',   'en' => 'Videos'],
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
