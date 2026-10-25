<?php
/**
 * backend/admin/bulk_upload.php — CSV / Excel bulk import
 *
 * Flow: 1 Choose data → 2 Upload (.csv/.txt/.xlsx) → 3 Map columns →
 *       4 Validate & preview → 5 Import (chunked, live progress) → 6 Results.
 *
 * The parsed file, the column map and the validated rows live in
 * $_SESSION['bulk'] between steps. Nothing is written until step 5, where
 * admin.js POSTs action=import_chunk (JSON) in batches of BULK_CHUNK rows —
 * each batch runs inside its own transaction. A <noscript> fallback imports
 * synchronously. A blank CSV template (?template=1) and an error report
 * (?errors=1) are downloadable per entity; the error report stays available
 * until the results page has been shown once.
 *
 * The importers accept every column the admin forms do and apply the same
 * rules (backend/admin/events.php, sevas.php, poojas.php): events take a type,
 * a last day, programme times, a venue and a picture in both languages
 * (migration 020); sevas a bilingual description and timing and is_bookable
 * (020); poojas typed times, a sponsorship price and availability, a banner
 * and the featured / live-stream flags (024). The old single-language
 * `description` column is still accepted for events and sevas and fills both
 * languages when description_ta / description_en are blank, as the migration
 * backfilled. Each set of columns is offered only when publicGuardHasColumn()
 * finds it, so a database without the migration imports the old columns only.
 */
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_guard.php';
require_once __DIR__ . '/../includes/panchangam.php';
require_once __DIR__ . '/includes/admin_layout.php';

const BULK_MAX_ROWS = 2000;
const BULK_MAX_MB   = 5;
const BULK_CHUNK    = 100;           // rows per import_chunk request
const BULK_TTL      = 1800;          // seconds a pending upload survives
const BULK_PREVIEW  = 300;           // rows shown on the preview screen
const BULK_XML_MAX  = 64 * 1024 * 1024; // uncompressed size guard for xlsx parts

/**
 * True when $url can be an event picture — the rule of eventImageUrlOk() in
 * backend/admin/events.php, repeated here because that page cannot be
 * included: an https address, or a path on this site under /uploads/ or
 * /images/. Nothing else, because it ends up in an <img> and a share preview.
 */
function bulkImageUrlOk(string $url): bool
{
    if ($url === '' || strlen($url) > 500 || preg_match('/[\x00-\x20\x7F\\\\]/', $url)) return false;
    if ($url[0] === '/') {
        return preg_match('#^/(uploads|images)/[A-Za-z0-9][A-Za-z0-9._/-]*\.(jpe?g|png|webp|gif|avif)$#i', $url) === 1 && !str_contains($url, '..') && !str_contains($url, '//');
    }
    if (stripos($url, 'https://') !== 0) return false;
    $p = parse_url($url);
    if (!is_array($p) || strtolower((string) ($p['scheme'] ?? '')) !== 'https' || empty($p['host'])) return false;
    if (isset($p['user']) || isset($p['pass'])) return false;
    return preg_match('/^[A-Za-z0-9.-]+$/', (string) $p['host']) === 1;
}

/** Whether this database has the columns each importer can fill (migrations 020 and 024). */
function bulkHasColumns(string $table, array $columns): bool
{
    foreach ($columns as $c) {
        if (!publicGuardHasColumn($table, $c)) return false;
    }
    return true;
}

/**
 * Entity definitions: columns, validation rules, duplicate key, insert SQL.
 *
 *   columns   what a file can supply, in template order
 *   required  must be mapped and non-blank
 *   rules     [column => [fn(string): bool, message]] for a non-blank cell (a
 *             required column is checked even when blank)
 *   check     fn(array $data): string[] — rules across columns (a last day
 *             before the first, an end time before the start), run once every
 *             single cell passed
 *   maxlen    per-column cap; cells are clamped like the admin forms clamp
 *             them (sanitizeText), default 2000
 *   help      column notes shown on the upload screen
 *   map       validated row → bound values for `insert`
 */
function bulkEntities(): array
{
    static $entities = null;
    if ($entities !== null) return $entities;

    // A real calendar day, as the admin forms check it (isValidDate: checkdate,
    // so 2027-02-30 is refused here instead of failing at the INSERT).
    $isDate = fn(string $v) => isValidDate($v);
    $isBool = fn(string $v) => in_array(strtolower($v), ['', '0', '1', 'yes', 'no', 'true', 'false'], true);
    $toBool = fn(string $v) => in_array(strtolower($v), ['1', 'yes', 'true'], true) ? 1 : (($v === '') ? 1 : 0);
    $yes    = fn(string $v) => in_array(strtolower($v), ['1', 'yes', 'true'], true) ? 1 : 0; // opt-in flags: blank is no
    $isNum  = fn(string $v) => $v === '' || is_numeric($v);
    // sort_order is an INT: clamped to its range as sevas.php clamps it, so a
    // stray 1e12 in a spreadsheet is saved as the largest order, not refused by MySQL.
    $sortOf = fn(string $v): int => (int) max(-2147483648, min(2147483647, (float) ($v !== '' ? $v : 0)));
    // DECIMAL(10,2): 0 … 99,999,999.99. Blank is left to the "required" check.
    $isMoney = fn(string $v) => $v === '' || (is_numeric($v) && (float) $v >= 0 && (float) $v <= 99999999.99);
    // Programme times, after bulkNormalizeValue() turned "7:00 pm" or an Excel
    // time cell into 24-hour HH:MM — the same shape the admin forms accept.
    $isClock  = fn(string $v) => $v === '' || preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $v) === 1;
    $isImage  = fn(string $v) => $v === '' || bulkImageUrlOk($v);
    // poojas.php's $imageOk: a site path under /uploads, /images or /icons, or any https address.
    $isBanner = fn(string $v) => $v === '' || preg_match('#^(/(uploads|images|icons)/[A-Za-z0-9._/-]+|https://[^\s"<>]+)$#', $v) === 1;
    $clockMsg = 'must be a time as HH:MM (24-hour), e.g. 18:30';

    $eventsV2 = bulkHasColumns('events', ['description_ta', 'description_en', 'event_type', 'end_date', 'start_time', 'end_time', 'venue_ta', 'venue_en', 'image_url', 'is_featured']);
    $sevasV2  = bulkHasColumns('sevas', ['description_ta', 'description_en', 'timing_ta', 'timing_en', 'is_bookable']);
    $poojasV2 = bulkHasColumns('poojas', ['start_time', 'end_time', 'sponsorship_amount', 'sponsorship_available', 'banner_url', 'is_featured', 'live_stream_enabled']);
    $poojaTypes = $poojasV2
        ? ['pournami', 'amavasai', 'ekadasi', 'sashti', 'pradosham', 'chaturthi', 'abhishekam', 'archana', 'festival', 'special', 'monthly', 'daily']
        : ['pournami', 'amavasai', 'ekadasi', 'sashti', 'special', 'monthly', 'daily'];
    $isPoojaType = fn(string $v) => $v === '' || in_array(strtolower($v), $poojaTypes, true);

    // A seva price is money the public site charges, so the import holds it
    // to the column's own range (DECIMAL(10,2), never negative) — a "-251"
    // in a spreadsheet must not become a seva that pays the devotee.
    $sevaRules = ['amount' => [$isMoney, 'must be between 0 and 99,999,999.99'], 'sort_order' => [$isNum, 'must be a number'],
                  'is_featured' => [$isBool, 'must be yes/no'], 'is_active' => [$isBool, 'must be yes/no']];
    $sevas = $sevasV2
        ? [
            'columns'  => ['name_ta', 'name_en', 'description_ta', 'description_en', 'description', 'timing_ta', 'timing_en', 'amount', 'sort_order', 'is_featured', 'is_bookable', 'is_active'],
            'required' => ['name_ta', 'name_en', 'amount'],
            'rules'    => $sevaRules + ['is_bookable' => [$isBool, 'must be yes/no']],
            'maxlen'   => ['name_ta' => 200, 'name_en' => 200, 'description_ta' => 1000, 'description_en' => 1000, 'description' => 1000, 'timing_ta' => 200, 'timing_en' => 200],
            'help'     => [
                'description_ta / description_en' => 'What the seva is, in each language.',
                'description' => 'Old single-language column: fills both languages when description_ta / description_en are blank.',
                'timing_ta / timing_en' => 'When it is performed, e.g. "Daily 7–9 am" (free text).',
                'is_bookable' => 'yes (default) lets devotees book online; no lists the seva without a Book button.',
                'is_featured' => 'yes highlights the seva; blank means no.',
                'is_active'   => 'no hides the seva from the site; blank means yes.',
            ],
            'map' => function (array $r) use ($toBool, $yes, $sortOf) {
                $ta = $r['description_ta'] !== '' ? $r['description_ta'] : $r['description'];
                $en = $r['description_en'] !== '' ? $r['description_en'] : $r['description'];
                return [
                    ':ta' => $r['name_ta'], ':en' => $r['name_en'],
                    ':d'   => $en !== '' ? $en : ($ta !== '' ? $ta : null), // legacy column: English, else Tamil
                    ':dta' => $ta !== '' ? $ta : null, ':den' => $en !== '' ? $en : null,
                    ':tta' => $r['timing_ta'] !== '' ? $r['timing_ta'] : null, ':ten' => $r['timing_en'] !== '' ? $r['timing_en'] : null,
                    ':amt' => (float) $r['amount'], ':so' => $sortOf($r['sort_order']),
                    ':f' => $yes($r['is_featured']), ':bk' => $toBool($r['is_bookable']), ':act' => $toBool($r['is_active']),
                ];
            },
            'insert' => 'INSERT INTO sevas (name_ta,name_en,description,description_ta,description_en,timing_ta,timing_en,amount,sort_order,is_featured,is_bookable,is_active)
                         VALUES (:ta,:en,:d,:dta,:den,:tta,:ten,:amt,:so,:f,:bk,:act)',
            'sample' => ['அபிஷேகம்', 'Abhishekam', 'சுவாமிக்கு புனித நீராட்டு', 'Sacred bathing of the deity', '', 'தினமும் காலை 7–9', 'Daily 7–9 am', '251', '1', 'yes', 'yes', 'yes'],
        ]
        : [
            'columns'  => ['name_ta', 'name_en', 'description', 'amount', 'sort_order', 'is_featured', 'is_active'],
            'required' => ['name_ta', 'name_en', 'amount'],
            'rules'    => $sevaRules,
            'maxlen'   => ['name_ta' => 200, 'name_en' => 200, 'description' => 1000],
            'help'     => ['description' => 'What the seva is (one language until migration 020 is applied).'],
            'map' => fn(array $r) => [
                ':a' => $r['name_ta'], ':b' => $r['name_en'], ':c' => $r['description'] ?: null,
                ':d' => (float) $r['amount'], ':e' => $sortOf($r['sort_order']),
                ':f' => $yes($r['is_featured']), ':g' => $toBool($r['is_active']),
            ],
            'insert' => 'INSERT INTO sevas (name_ta,name_en,description,amount,sort_order,is_featured,is_active) VALUES (:a,:b,:c,:d,:e,:f,:g)',
            'sample' => ['அபிஷேகம்', 'Abhishekam', 'Sacred bathing of the deity', '251', '1', 'yes', 'yes'],
        ];

    $events = $eventsV2
        ? [
            'columns'  => ['title_ta', 'title_en', 'event_type', 'event_date', 'end_date', 'start_time', 'end_time', 'venue_ta', 'venue_en', 'description_ta', 'description_en', 'description', 'image_url', 'is_featured', 'is_active'],
            'required' => ['title_ta', 'title_en', 'event_date'],
            'rules'    => [
                'event_type' => [fn($v) => $v === '' || in_array(strtolower($v), ['festival', 'pooja', 'special', 'other'], true), 'must be festival, pooja, special or other'],
                'event_date' => [$isDate, 'must be YYYY-MM-DD'],
                'end_date'   => [$isDate, 'must be YYYY-MM-DD'],
                'start_time' => [$isClock, $clockMsg],
                'end_time'   => [$isClock, $clockMsg],
                'image_url'  => [$isImage, 'must be an https address or a picture under /uploads/ or /images/ on this site'],
                'is_featured' => [$isBool, 'must be yes/no'], 'is_active' => [$isBool, 'must be yes/no'],
            ],
            // events.php: the last day is on or after the first; on a one-day event the programme cannot end before it starts.
            'check' => function (array $r): array {
                $errors = [];
                if ($r['end_date'] !== '' && $r['end_date'] < $r['event_date']) $errors[] = 'end_date must be on or after event_date';
                if ($r['start_time'] !== '' && $r['end_time'] !== '' && ($r['end_date'] === '' || $r['end_date'] === $r['event_date']) && $r['end_time'] < $r['start_time']) {
                    $errors[] = 'end_time must not be before start_time on a one-day event';
                }
                return $errors;
            },
            'maxlen' => ['title_ta' => 300, 'title_en' => 300, 'venue_ta' => 300, 'venue_en' => 300, 'description_ta' => 5000, 'description_en' => 5000, 'description' => 5000, 'image_url' => 500],
            'help'   => [
                'event_type' => 'festival, pooja, special or other; blank means other.',
                'end_date'   => 'Last day of a multi-day event, on or after event_date; blank for a one-day event.',
                'start_time / end_time' => '24-hour HH:MM (Excel time cells and "6:30 pm" are understood); the end is not before the start on a one-day event.',
                'venue_ta / venue_en' => 'Where it takes place, in each language.',
                'description_ta / description_en' => 'The programme, in each language.',
                'description' => 'Old single-language column: fills both languages when description_ta / description_en are blank.',
                'image_url'  => 'An https address, or a picture under /uploads/ or /images/ on this site.',
                'is_featured' => 'yes highlights the event on the Events page; blank means no.',
                'is_active'   => 'no hides the event from the site; blank means yes.',
            ],
            'map' => function (array $r) use ($toBool, $yes) {
                $ta = $r['description_ta'] !== '' ? $r['description_ta'] : $r['description'];
                $en = $r['description_en'] !== '' ? $r['description_en'] : $r['description'];
                return [
                    ':ta' => $r['title_ta'], ':en' => $r['title_en'], ':ty' => $r['event_type'] !== '' ? strtolower($r['event_type']) : 'other',
                    ':d'   => $en !== '' ? $en : ($ta !== '' ? $ta : null), // legacy column: English, else Tamil
                    ':dta' => $ta !== '' ? $ta : null, ':den' => $en !== '' ? $en : null,
                    ':dt'  => $r['event_date'], ':ed' => $r['end_date'] !== '' ? $r['end_date'] : null,
                    ':st'  => $r['start_time'] !== '' ? $r['start_time'] . ':00' : null, ':et' => $r['end_time'] !== '' ? $r['end_time'] . ':00' : null,
                    ':vta' => $r['venue_ta'] !== '' ? $r['venue_ta'] : null, ':ven' => $r['venue_en'] !== '' ? $r['venue_en'] : null,
                    ':img' => $r['image_url'] !== '' ? $r['image_url'] : null,
                    ':fe'  => $yes($r['is_featured']), ':a' => $toBool($r['is_active']),
                ];
            },
            'insert' => 'INSERT INTO events (title_ta,title_en,event_type,description,description_ta,description_en,event_date,end_date,start_time,end_time,venue_ta,venue_en,image_url,is_featured,is_active)
                         VALUES (:ta,:en,:ty,:d,:dta,:den,:dt,:ed,:st,:et,:vta,:ven,:img,:fe,:a)',
            'sample' => ['தைப்பூசம்', 'Thai Poosam', 'festival', '2027-01-24', '2027-01-25', '06:00', '21:00', 'கோயில் மண்டபம்', 'Temple mandapam', 'காவடி திருவிழா', 'Grand kavadi festival', '', '', 'yes', 'yes'],
        ]
        : [
            'columns'  => ['title_ta', 'title_en', 'event_date', 'description', 'is_active'],
            'required' => ['title_ta', 'title_en', 'event_date'],
            'rules'    => ['event_date' => [$isDate, 'must be YYYY-MM-DD'], 'is_active' => [$isBool, 'must be yes/no']],
            'maxlen'   => ['title_ta' => 300, 'title_en' => 300, 'description' => 5000],
            'help'     => ['description' => 'The programme (one language until migration 020 is applied).'],
            'map' => fn(array $r) => [
                ':a' => $r['title_ta'], ':b' => $r['title_en'], ':c' => $r['description'] ?: null,
                ':d' => $r['event_date'], ':e' => $toBool($r['is_active']),
            ],
            'insert' => 'INSERT INTO events (title_ta,title_en,description,event_date,is_active) VALUES (:a,:b,:c,:d,:e)',
            'sample' => ['தைப்பூசம்', 'Thai Poosam', '2027-01-24', 'Grand kavadi festival', 'yes'],
        ];

    $poojaRules = [
        'pooja_date' => [$isDate, 'must be YYYY-MM-DD'],
        'pooja_type' => [$isPoojaType, 'must be one of ' . implode(', ', $poojaTypes)],
        'is_active'  => [$isBool, 'must be yes/no'],
    ];
    $poojas = $poojasV2
        ? [
            'columns'  => ['name_ta', 'name_en', 'pooja_date', 'pooja_time', 'start_time', 'end_time', 'pooja_type', 'description_ta', 'description_en', 'sponsorship_amount', 'sponsorship_available', 'banner_url', 'is_featured', 'live_stream_enabled', 'is_active'],
            'required' => ['name_ta', 'name_en', 'pooja_date'],
            'rules'    => $poojaRules + [
                'start_time' => [$isClock, $clockMsg],
                'end_time'   => [$isClock, $clockMsg],
                'sponsorship_amount'    => [fn($v) => $v === '' || (is_numeric($v) && (float) $v >= 0 && (float) $v <= 99999999), 'must be the sponsorship amount in rupees, 0 or more'],
                'sponsorship_available' => [$isBool, 'must be yes/no'],
                'banner_url'  => [$isBanner, 'must be a site path such as /uploads/banner.webp or an https:// address'],
                'is_featured' => [$isBool, 'must be yes/no'],
                'live_stream_enabled' => [$isBool, 'must be yes/no'],
            ],
            // poojas.php: the end time must be after the start time.
            'check' => function (array $r): array {
                return ($r['start_time'] !== '' && $r['end_time'] !== '' && $r['end_time'] <= $r['start_time']) ? ['end_time must be after start_time'] : [];
            },
            'maxlen' => ['name_ta' => 200, 'name_en' => 200, 'description_ta' => 2000, 'description_en' => 2000, 'pooja_time' => 20, 'banner_url' => 500],
            'help'   => [
                'pooja_time' => 'Free text shown as the time ("07:00 AM"); left blank it is written from start_time / end_time.',
                'start_time / end_time' => '24-hour HH:MM (Excel time cells and "6:30 pm" are understood); the end is after the start.',
                'pooja_type' => implode(', ', $poojaTypes) . '; blank means special.',
                'sponsorship_amount' => 'Rupees, 0 or more; blank when the pooja is not sponsored.',
                'sponsorship_available' => 'yes (default) offers the sponsorship on the site; no marks it taken.',
                'banner_url'  => 'A picture under /uploads/, /images/ or /icons/ on this site, or an https address.',
                'is_featured' => 'yes highlights the pooja; blank means no.',
                'live_stream_enabled' => 'yes marks the pooja as streamed live; blank means no.',
                'is_active'   => 'no hides the pooja from the site; blank means yes.',
            ],
            'map' => function (array $r) use ($toBool, $yes) {
                $start = $r['start_time'] !== '' ? $r['start_time'] : null;
                $end   = $r['end_time'] !== '' ? $r['end_time'] : null;
                // A typed range gives the display time when none was typed by hand (poojas.php does the same).
                $time = $r['pooja_time'] !== '' ? $r['pooja_time'] : ($start !== null ? panchTimeLabel($start, $end, '') : '');
                return [
                    ':ta' => $r['name_ta'], ':en' => $r['name_en'],
                    ':dta' => $r['description_ta'] !== '' ? $r['description_ta'] : null, ':den' => $r['description_en'] !== '' ? $r['description_en'] : null,
                    ':dt' => $r['pooja_date'], ':tm' => $time !== '' ? $time : null, ':typ' => $r['pooja_type'] !== '' ? strtolower($r['pooja_type']) : 'special',
                    ':a'  => $toBool($r['is_active']),
                    ':st' => $start !== null ? $start . ':00' : null, ':et' => $end !== null ? $end . ':00' : null,
                    ':amt' => $r['sponsorship_amount'] !== '' ? round((float) $r['sponsorship_amount'], 2) : null,
                    ':av' => $toBool($r['sponsorship_available']), ':bn' => $r['banner_url'] !== '' ? $r['banner_url'] : null,
                    ':ft' => $yes($r['is_featured']), ':lv' => $yes($r['live_stream_enabled']),
                ];
            },
            'insert' => 'INSERT INTO poojas (name_ta,name_en,description_ta,description_en,pooja_date,pooja_time,pooja_type,is_active,start_time,end_time,sponsorship_amount,sponsorship_available,banner_url,is_featured,live_stream_enabled)
                         VALUES (:ta,:en,:dta,:den,:dt,:tm,:typ,:a,:st,:et,:amt,:av,:bn,:ft,:lv)',
            'sample' => ['பௌர்ணமி பூஜை', 'Pournami Pooja', '2027-01-03', '', '18:00', '19:30', 'pournami', 'பௌர்ணமி நாளில் சிறப்பு அபிஷேகம்', 'Special abhishekam on the full-moon day', '2500', 'yes', '', 'yes', 'no', 'yes'],
        ]
        : [
            'columns'  => ['name_ta', 'name_en', 'pooja_date', 'pooja_time', 'pooja_type', 'description_ta', 'description_en', 'is_active'],
            'required' => ['name_ta', 'name_en', 'pooja_date'],
            'rules'    => $poojaRules,
            'maxlen'   => ['name_ta' => 200, 'name_en' => 200, 'description_ta' => 2000, 'description_en' => 2000, 'pooja_time' => 20],
            'help'     => ['pooja_time' => 'Free text shown as the time, e.g. "07:00 AM".', 'pooja_type' => implode(', ', $poojaTypes) . '; blank means special.'],
            'map' => fn(array $r) => [
                ':a' => $r['name_ta'], ':b' => $r['name_en'], ':c' => $r['description_ta'] ?: null, ':d' => $r['description_en'] ?: null,
                ':e' => $r['pooja_date'], ':f' => $r['pooja_time'] ?: null, ':g' => $r['pooja_type'] !== '' ? strtolower($r['pooja_type']) : 'special', ':h' => $toBool($r['is_active']),
            ],
            'insert' => 'INSERT INTO poojas (name_ta,name_en,description_ta,description_en,pooja_date,pooja_time,pooja_type,is_active) VALUES (:a,:b,:c,:d,:e,:f,:g,:h)',
            'sample' => ['பௌர்ணமி பூஜை', 'Pournami Pooja', '2027-01-03', '07:00 AM', 'pournami', '', '', 'yes'],
        ];

    return $entities = [
        'sevas' => ['icon' => 'sparkles', 'label' => 'Sevas', 'table' => 'sevas', 'dupKey' => ['name_en'], 'dupSql' => 'SELECT name_en FROM sevas'] + $sevas,
        'events' => ['icon' => 'calendar', 'label' => 'Events', 'table' => 'events', 'dupKey' => ['title_en', 'event_date'], 'dupSql' => 'SELECT title_en, event_date FROM events'] + $events,
        'poojas' => ['icon' => 'flame', 'label' => 'Poojas', 'table' => 'poojas', 'dupKey' => ['name_en', 'pooja_date'], 'dupSql' => 'SELECT name_en, pooja_date FROM poojas'] + $poojas,
        'sponsors' => [
            'icon' => 'heart-hands', 'label' => 'Sponsors', 'table' => 'sponsors',
            // publish_consent is opt-in: blank or anything but yes/1/true imports as "not consented".
            'columns' => ['name', 'family_name', 'phone', 'email', 'amount', 'payment_status', 'payment_ref', 'publish_consent', 'note', 'is_active'],
            'required' => ['name'],
            'rules' => ['phone' => [fn($v) => $v === '' || preg_match('/^[0-9+\-\s]{7,30}$/', $v), 'must be a phone number'],
                        'email' => [fn($v) => $v === '' || filter_var($v, FILTER_VALIDATE_EMAIL) !== false, 'must be an email address'],
                        'amount' => [fn($v) => $v === '' || (is_numeric($v) && (float) $v >= 0 && (float) $v <= 99999999), 'must be a number of rupees, 0 or more'],
                        'payment_status' => [fn($v) => in_array(strtoupper($v), ['', 'PENDING', 'PAID', 'FAILED', 'REFUNDED', 'WAIVED'], true), 'must be PENDING, PAID, FAILED, REFUNDED or WAIVED'],
                        'publish_consent' => [$isBool, 'must be yes/no'],
                        'is_active' => [$isBool, 'must be yes/no']],
            'dupKey' => ['name', 'phone'],
            'dupSql' => 'SELECT name, phone FROM sponsors',
            'map' => fn(array $r) => [
                ':a' => $r['name'], ':b' => $r['family_name'] ?: null, ':c' => $r['phone'] ?: null, ':d' => $r['email'] ?: null,
                ':e' => $r['amount'] !== '' ? number_format((float) $r['amount'], 2, '.', '') : null,
                ':f' => $r['payment_status'] !== '' ? strtoupper($r['payment_status']) : 'PENDING', ':g' => $r['payment_ref'] ?: null,
                ':h' => in_array(strtolower($r['publish_consent']), ['1', 'yes', 'true'], true) ? 1 : 0,
                ':i' => $r['note'] ?: null, ':j' => $toBool($r['is_active']),
            ],
            'insert' => 'INSERT INTO sponsors (name,family_name,phone,email,amount,payment_status,payment_ref,publish_consent,note,is_active) VALUES (:a,:b,:c,:d,:e,:f,:g,:h,:i,:j)',
            'sample' => ['Murugan', 'Murugan & Family', '9876543210', 'murugan@example.com', '5000', 'PAID', 'UPI-2026-0001', 'yes', 'Annadanam sponsor', 'yes'],
        ],
        'donations' => [
            'icon' => 'banknote', 'label' => 'Donations', 'table' => 'donations',
            'columns' => ['name', 'phone', 'amount', 'purpose', 'message', 'created_at'],
            'required' => ['name', 'phone', 'amount'],
            'rules' => [
                'phone'  => [fn($v) => (bool) preg_match('/^[0-9]{7,15}$/', $v), 'must be 7–15 digits'],
                'amount' => [fn($v) => is_numeric($v) && (float) $v > 0, 'must be a positive number'],
                'created_at' => [fn($v) => $v === '' || strtotime($v) !== false, 'must be a valid date/time'],
            ],
            'dupKey' => ['phone', 'amount', 'created_at'],
            'dupSql' => 'SELECT phone, amount, created_at FROM donations',
            'map' => fn(array $r) => [
                ':a' => $r['name'], ':b' => $r['phone'], ':c' => (float) $r['amount'], ':d' => $r['purpose'] ?: null,
                ':e' => $r['message'] ?: null, ':f' => $r['created_at'] !== '' ? date('Y-m-d H:i:s', strtotime($r['created_at'])) : date('Y-m-d H:i:s'),
            ],
            'insert' => 'INSERT INTO donations (name,phone,amount,purpose,message,created_at) VALUES (:a,:b,:c,:d,:e,:f)',
            'sample' => ['Lakshmi', '9876543210', '1001', 'annadanam', 'Receipt to Chennai address', '2026-08-15 10:30:00'],
        ],
    ];
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Flash alert for the top of the page (admin.js turns it into a toast). $html must be pre-escaped. */
function bulkFlash(string $tone, string $html): string
{
    return '<p class="alert alert--' . h($tone) . '" role="' . ($tone === 'error' ? 'alert' : 'status') . '">' . $html . '</p>';
}

/** Inline alert (stays in place inside a card). $html must be pre-escaped. */
function bulkAlert(string $tone, string $html): string
{
    $icon = ['success' => 'check-circle', 'error' => 'alert-circle', 'warning' => 'alert', 'info' => 'info'][$tone] ?? 'info';
    return '<div class="alert alert--' . h($tone) . '" role="' . ($tone === 'error' ? 'alert' : 'status') . '" data-keep><span class="alert__icon">' . adminIcon($icon) . '</span><div class="alert__body">' . $html . '</div></div>';
}

function bulkNormalizeHeader(string $h): string
{
    $h = preg_replace('/^\xEF\xBB\xBF/', '', $h); // strip BOM
    return strtolower(trim(preg_replace('/[^a-z0-9_]+/i', '_', trim($h)), '_'));
}

function bulkDupSignature(array $data, array $keys): string
{
    // Numbers normalised so "1001" (CSV) matches "1001.00" (DECIMAL column)
    return implode('|', array_map(function ($k) use ($data) {
        $v = trim((string) ($data[$k] ?? ''));
        return is_numeric($v) ? number_format((float) $v, 2, '.', '') : mb_strtolower($v);
    }, $keys));
}

/** Excel-exported "CSV" is often Windows-1252; make every cell valid UTF-8. */
function bulkUtf8(string $s): string
{
    if ($s === '' || mb_check_encoding($s, 'UTF-8')) return $s;
    return mb_convert_encoding($s, 'UTF-8', 'Windows-1252');
}

/** "B" → 1, "AA" → 26 (0-based column index from a cell reference like "AA12"). */
function bulkColIndex(string $ref): int
{
    $letters = preg_replace('/[^A-Z]/', '', strtoupper($ref));
    $n = 0;
    foreach (str_split($letters ?: 'A') as $ch) $n = $n * 26 + (ord($ch) - 64);
    return max(0, $n - 1);
}

/** 0 → "A", 26 → "AA". */
function bulkColLetter(int $i): string
{
    $s = '';
    $i++;
    while ($i > 0) {
        $m = ($i - 1) % 26;
        $s = chr(65 + $m) . $s;
        $i = intdiv($i - 1, 26);
    }
    return $s;
}

/** Excel writes 9876543210 as 9.87654321E9 for wide cells — render numbers plainly. */
function bulkNumStr(string $v): string
{
    $v = trim($v);
    if ($v === '' || !is_numeric($v) || preg_match('/^-?\d+(\.\d+)?$/', $v)) return $v;
    $s = number_format((float) $v, 10, '.', '');
    return str_contains($s, '.') ? rtrim(rtrim($s, '0'), '.') : $s;
}

/**
 * Read a CSV/TXT file. Delimiter is sniffed from the header line (, ; tab |),
 * the BOM is stripped and every cell is trimmed UTF-8.
 * Returns ['header' => [...], 'rows' => [[...]], 'lines' => [int], 'truncated' => bool].
 */
function bulkReadCsv(string $path): array
{
    $fh = @fopen($path, 'r');
    if (!$fh) throw new RuntimeException('Could not read the uploaded file.');
    $first = fgets($fh);
    if ($first === false || trim($first) === '') {
        fclose($fh);
        throw new RuntimeException('The file appears to be empty.');
    }
    $delim = ',';
    $best  = -1;
    foreach ([',', ';', "\t", '|'] as $d) {
        $n = substr_count($first, $d);
        if ($n > $best) { $best = $n; $delim = $d; }
    }
    rewind($fh);
    $clean  = fn(array $r) => array_map(fn($c) => trim(bulkUtf8((string) $c)), $r);
    $header = fgetcsv($fh, null, $delim, '"', '\\');
    if (!$header) {
        fclose($fh);
        throw new RuntimeException('The file appears to be empty.');
    }
    $header    = $clean($header);
    $header[0] = preg_replace('/^\xEF\xBB\xBF/', '', $header[0]);
    $rows = $lines = [];
    $line = 1;
    $truncated = false;
    while (($raw = fgetcsv($fh, null, $delim, '"', '\\')) !== false) {
        $line++;
        $raw = $clean($raw);
        if (array_filter($raw, fn($c) => $c !== '') === []) continue; // blank line
        if (count($rows) >= BULK_MAX_ROWS) { $truncated = true; break; }
        $rows[]  = $raw;
        $lines[] = $line;
    }
    fclose($fh);
    return ['header' => $header, 'rows' => $rows, 'lines' => $lines, 'truncated' => $truncated];
}

/**
 * Dependency-free .xlsx reader (first worksheet only) built on ZipArchive +
 * SimpleXML/XMLReader. Shared strings (plain and rich-text) are resolved,
 * inline strings, booleans and numbers are normalised to trimmed strings and
 * column gaps are filled with ''. Excel date/time serials are kept numeric
 * here and converted in bulkNormalizeValue() once the column is mapped.
 * Returns the same shape as bulkReadCsv() ('lines' are Excel row numbers).
 */
function bulkReadXlsx(string $path): array
{
    if (!class_exists('ZipArchive') || !function_exists('simplexml_load_string')) {
        $missing = !class_exists('ZipArchive') ? 'zip' : 'xml';
        throw new RuntimeException('This server cannot read Excel files (the PHP ' . $missing . ' extension is missing). In Excel choose File → Save As → CSV UTF-8 and upload that file instead.');
    }
    $zip = new ZipArchive();
    if ($zip->open($path) !== true) {
        throw new RuntimeException('Could not open the Excel file. Make sure it is a real .xlsx workbook (older .xls files are not supported — save as .xlsx or CSV UTF-8).');
    }
    $libxml = libxml_use_internal_errors(true);
    $part = function (string $name) use ($zip): string|false {
        $st = $zip->statName($name);
        if ($st === false) return false;
        if ((int) $st['size'] > BULK_XML_MAX) throw new RuntimeException('The workbook is too large to import. Split it into smaller files.');
        return $zip->getFromName($name);
    };
    // Anything thrown below still releases the archive and the libxml error state
    try {
        // 1. Locate the first worksheet via workbook.xml + its relationships (fallback sheet1.xml)
        $sheetPath = 'xl/worksheets/sheet1.xml';
        $wbXml  = $part('xl/workbook.xml');
        $relXml = $part('xl/_rels/workbook.xml.rels');
        if ($wbXml !== false && $relXml !== false) {
            $wb   = simplexml_load_string($wbXml);
            $rels = simplexml_load_string($relXml);
            if ($wb && $rels && isset($wb->sheets->sheet[0])) {
                $rid = (string) ($wb->sheets->sheet[0]->attributes('http://schemas.openxmlformats.org/officeDocument/2006/relationships')->id ?? '');
                foreach ($rels->Relationship as $rel) {
                    if ((string) $rel['Id'] === $rid) {
                        $target = (string) $rel['Target'];
                        $sheetPath = str_starts_with($target, '/') ? ltrim($target, '/') : 'xl/' . ltrim($target, '/');
                        break;
                    }
                }
            }
        }
        if ($zip->locateName($sheetPath) === false) {
            throw new RuntimeException('No worksheet was found in the workbook.');
        }

        // 2. Shared strings (<si><t> and rich text <si><r><t>…; phonetic runs ignored)
        $shared = [];
        $ssXml  = $part('xl/sharedStrings.xml');
        if ($ssXml !== false) {
            $sst = simplexml_load_string($ssXml);
            if ($sst) {
                foreach ($sst->si as $si) {
                    $parts    = $si->xpath('.//*[local-name()="t" and not(ancestor::*[local-name()="rPh"])]') ?: [];
                    $shared[] = implode('', array_map('strval', $parts));
                }
            }
        }

        // 3. Sheet rows
        $sheetXml = $part($sheetPath);
    } catch (RuntimeException $e) {
        @$zip->close();
        libxml_use_internal_errors($libxml);
        throw $e;
    }
    $zip->close();
    $reader = new XMLReader();
    if ($sheetXml === false || !$reader->XML($sheetXml)) {
        libxml_use_internal_errors($libxml);
        throw new RuntimeException('The worksheet could not be read.');
    }
    $doc = new DOMDocument();
    $header = null;
    $rows = $lines = [];
    $truncated = false;
    $ok = $reader->read();
    while ($ok) {
        if ($reader->nodeType !== XMLReader::ELEMENT || $reader->localName !== 'row') {
            $ok = $reader->read();
            continue;
        }
        $rowNum = (int) $reader->getAttribute('r');
        $node   = $reader->expand();
        $ok     = $reader->next(); // skip the subtree we just expanded
        if (!$node) continue;
        $row   = $doc->importNode($node, true);
        $cells = [];
        $next  = 0;
        foreach ($row->childNodes as $c) {
            if ($c->nodeType !== XML_ELEMENT_NODE || $c->localName !== 'c') continue;
            $ref  = $c->getAttribute('r');
            $type = $c->getAttribute('t');
            $idx  = $ref !== '' ? bulkColIndex($ref) : $next;
            $val  = '';
            foreach ($c->childNodes as $child) {
                if ($child->nodeType !== XML_ELEMENT_NODE) continue;
                if ($child->localName === 'v' || $child->localName === 'is') $val = $child->textContent;
            }
            $val = match ($type) {
                's'         => $shared[(int) $val] ?? '',
                'b'         => $val === '1' ? '1' : '0',
                'e'         => '',
                'inlineStr', 'str' => $val,
                default     => bulkNumStr($val),
            };
            while (count($cells) < $idx) $cells[] = '';
            $cells[$idx] = trim($val);
            $next = $idx + 1;
        }
        if (array_filter($cells, fn($c) => $c !== '') === []) continue; // blank row
        if ($header === null) { $header = $cells; continue; }
        if (count($rows) >= BULK_MAX_ROWS) { $truncated = true; break; }
        $rows[]  = $cells;
        $lines[] = $rowNum ?: count($rows) + 1;
    }
    $reader->close();
    libxml_clear_errors();
    libxml_use_internal_errors($libxml);
    if ($header === null) throw new RuntimeException('The worksheet appears to be empty.');
    return ['header' => $header, 'rows' => $rows, 'lines' => $lines, 'truncated' => $truncated];
}

/** Candidate entity columns for a normalised file header (most specific first). */
function bulkHeaderCandidates(string $n): array
{
    static $table = null;
    if ($table === null) {
        $desc  = ['description', 'description_en', 'note', 'message'];
        $notes = ['note', 'message', 'description'];
        $date  = ['event_date', 'pooja_date', 'created_at'];
        $table = [
            'name' => ['name', 'name_en'], 'full_name' => ['name', 'name_en'], 'english_name' => ['name_en', 'name'], 'name_english' => ['name_en', 'name'],
            'name_in_english' => ['name_en', 'name'], 'sponsor_name' => ['name', 'name_en'], 'donor_name' => ['name'], 'devotee_name' => ['name'],
            'seva_name' => ['name_en'], 'pooja_name' => ['name_en'], 'seva' => ['name_en'], 'pooja' => ['name_en'], 'english' => ['name_en', 'title_en'],
            'tamil_name' => ['name_ta'], 'name_tamil' => ['name_ta'], 'name_in_tamil' => ['name_ta'], 'seva_name_tamil' => ['name_ta'], 'pooja_name_tamil' => ['name_ta'], 'tamil' => ['name_ta', 'title_ta'],
            'title' => ['title_en'], 'title_english' => ['title_en'], 'english_title' => ['title_en'], 'title_in_english' => ['title_en'],
            'event_title' => ['title_en'], 'event_name' => ['title_en'], 'event' => ['title_en'], 'festival' => ['title_en'],
            'title_tamil' => ['title_ta'], 'tamil_title' => ['title_ta'], 'title_in_tamil' => ['title_ta'], 'event_title_tamil' => ['title_ta'],
            'description' => $desc, 'desc' => $desc, 'details' => $desc, 'about' => $desc, 'description_english' => ['description_en', 'description'], 'english_description' => ['description_en', 'description'],
            'description_tamil' => ['description_ta'], 'tamil_description' => ['description_ta'], 'desc_ta' => ['description_ta'],
            'date' => $date, 'on' => $date, 'when' => $date, 'day' => $date, 'event_date' => $date, 'pooja_date' => $date,
            'donation_date' => ['created_at'], 'donated_on' => ['created_at'], 'created' => ['created_at'], 'created_on' => ['created_at'],
            'timestamp' => ['created_at'], 'date_time' => ['created_at'], 'datetime' => ['created_at'], 'paid_on' => ['created_at'], 'received_on' => ['created_at'],
            'mobile' => ['phone'], 'phone_number' => ['phone'], 'mobile_number' => ['phone'], 'mobile_no' => ['phone'], 'phone_no' => ['phone'],
            'contact' => ['phone'], 'contact_number' => ['phone'], 'contact_no' => ['phone'], 'cell' => ['phone'], 'tel' => ['phone'], 'telephone' => ['phone'], 'whatsapp' => ['phone'], 'ph' => ['phone'],
            'amt' => ['amount'], 'amount_rs' => ['amount'], 'amount_inr' => ['amount'], 'rs' => ['amount'], 'inr' => ['amount'], 'price' => ['amount'], 'cost' => ['amount'],
            'fee' => ['amount'], 'fees' => ['amount'], 'rupees' => ['amount'], 'donation' => ['amount'], 'donation_amount' => ['amount'], 'total' => ['amount'], 'value' => ['amount'],
            'time' => ['pooja_time', 'start_time'], 'timing' => ['pooja_time', 'timing_en'], 'timings' => ['timing_en', 'pooja_time'], 'pooja_timing' => ['pooja_time'], 'at' => ['pooja_time'],
            'timing_tamil' => ['timing_ta'], 'tamil_timing' => ['timing_ta'], 'timing_english' => ['timing_en'], 'english_timing' => ['timing_en'],
            'type' => ['pooja_type', 'event_type'], 'kind' => ['pooja_type', 'event_type'], 'category' => ['pooja_type', 'event_type', 'purpose'], 'pooja_category' => ['pooja_type'], 'event_category' => ['event_type'],
            // Migration 020 / 024 columns (events, sevas, poojas)
            'start' => ['start_time'], 'starts' => ['start_time'], 'starts_at' => ['start_time'], 'from_time' => ['start_time'], 'start_at' => ['start_time'],
            'end' => ['end_date', 'end_time'], 'ends' => ['end_time'], 'ends_at' => ['end_time'], 'to_time' => ['end_time'], 'end_at' => ['end_time'],
            'to' => ['end_date'], 'until' => ['end_date'], 'till' => ['end_date'], 'last_day' => ['end_date'], 'ends_on' => ['end_date'], 'to_date' => ['end_date'], 'end_on' => ['end_date'],
            'venue' => ['venue_en'], 'place' => ['venue_en'], 'location' => ['venue_en'], 'where' => ['venue_en'], 'hall' => ['venue_en'],
            'image' => ['image_url', 'banner_url'], 'picture' => ['image_url', 'banner_url'], 'photo' => ['image_url', 'banner_url'], 'poster' => ['image_url', 'banner_url'],
            'banner' => ['banner_url', 'image_url'], 'image_link' => ['image_url', 'banner_url'], 'picture_url' => ['image_url', 'banner_url'],
            'bookable' => ['is_bookable'], 'online_booking' => ['is_bookable'], 'book_online' => ['is_bookable'], 'booking' => ['is_bookable'], 'can_book' => ['is_bookable'],
            'sponsorship' => ['sponsorship_amount'], 'sponsor_amount' => ['sponsorship_amount'], 'sponsorship_rs' => ['sponsorship_amount'], 'sponsorship_fee' => ['sponsorship_amount'],
            'available' => ['sponsorship_available'], 'sponsor_available' => ['sponsorship_available'], 'open_for_sponsorship' => ['sponsorship_available'], 'availability' => ['sponsorship_available'],
            'live' => ['live_stream_enabled'], 'live_stream' => ['live_stream_enabled'], 'livestream' => ['live_stream_enabled'], 'streamed' => ['live_stream_enabled'], 'stream' => ['live_stream_enabled'],
            'active' => ['is_active'], 'status' => ['is_active'], 'enabled' => ['is_active'], 'visible' => ['is_active'], 'show' => ['is_active'], 'is_enabled' => ['is_active'], 'published' => ['is_active'],
            'featured' => ['is_featured'], 'highlight' => ['is_featured'], 'highlighted' => ['is_featured'], 'is_highlighted' => ['is_featured'], 'star' => ['is_featured'], 'popular' => ['is_featured'],
            'order' => ['sort_order'], 'sort' => ['sort_order'], 'position' => ['sort_order'], 'rank' => ['sort_order'], 'sequence' => ['sort_order'], 'seq' => ['sort_order'],
            'display_order' => ['sort_order'], 'sno' => ['sort_order'], 's_no' => ['sort_order'], 'sl_no' => ['sort_order'],
            'notes' => $notes, 'remark' => $notes, 'remarks' => $notes, 'comment' => $notes, 'comments' => $notes, 'note' => $notes, 'msg' => ['message', 'note', 'description'], 'message' => ['message', 'note', 'description'],
            'purpose' => ['purpose'], 'for' => ['purpose'], 'reason' => ['purpose'], 'towards' => ['purpose'], 'fund' => ['purpose'],
            'family' => ['family_name'], 'family_name' => ['family_name'], 'public_name' => ['family_name'], 'display_name' => ['family_name'],
            'email' => ['email'], 'e_mail' => ['email'], 'mail' => ['email'], 'email_address' => ['email'], 'email_id' => ['email'],
            'consent' => ['publish_consent'], 'publish_consent' => ['publish_consent'], 'publish' => ['publish_consent'], 'can_publish' => ['publish_consent'], 'permission' => ['publish_consent'],
            'payment_status' => ['payment_status'], 'paid' => ['payment_status'], 'payment' => ['payment_status'], 'pay_status' => ['payment_status'],
            'payment_ref' => ['payment_ref'], 'payment_reference' => ['payment_ref'], 'reference' => ['payment_ref'], 'ref' => ['payment_ref'], 'ref_no' => ['payment_ref'],
            'transaction' => ['payment_ref'], 'transaction_id' => ['payment_ref'], 'txn' => ['payment_ref'], 'txn_id' => ['payment_ref'], 'utr' => ['payment_ref'], 'receipt' => ['payment_ref'], 'receipt_no' => ['payment_ref'],
        ];
    }
    if (isset($table[$n])) return $table[$n];
    // Pattern fallback: "<anything> name/title/description <tamil|english>" → name_ta / title_en …
    $tokens = explode('_', $n);
    $lang   = (in_array('tamil', $tokens, true) || in_array('ta', $tokens, true)) ? 'ta'
            : ((in_array('english', $tokens, true) || in_array('en', $tokens, true)) ? 'en' : '');
    foreach (['name', 'title', 'description', 'desc', 'venue', 'timing'] as $base) {
        if (in_array($base, $tokens, true)) {
            $base = $base === 'desc' ? 'description' : $base;
            return $lang ? ["{$base}_{$lang}"] : ["{$base}_en", $base];
        }
    }
    return [];
}

/** Auto-map file columns → entity columns (exact header match, then synonyms; each target used once). */
function bulkAutoMap(array $header, array $def): array
{
    $norm = array_map(fn($x) => bulkNormalizeHeader((string) $x), $header);
    $map  = array_fill(0, count($header), '');
    $used = [];
    foreach ($norm as $i => $n) {
        if ($n !== '' && in_array($n, $def['columns'], true) && !isset($used[$n])) { $map[$i] = $n; $used[$n] = true; }
    }
    foreach ($norm as $i => $n) {
        if ($map[$i] !== '' || $n === '') continue;
        foreach (bulkHeaderCandidates($n) as $cand) {
            if (in_array($cand, $def['columns'], true) && !isset($used[$cand])) { $map[$i] = $cand; $used[$cand] = true; break; }
        }
    }
    return $map;
}

/** Validate a column map: every required column exactly once, no target twice. Returns ['errors' => [], 'bad' => [idx…]]. */
function bulkMapIssues(array $map, array $def): array
{
    $errors = $bad = [];
    $where  = [];
    foreach ($map as $i => $col) if ($col !== '') $where[$col][] = $i;
    foreach ($def['required'] as $col) {
        if (empty($where[$col])) $errors[] = "Required column “{$col}” is not mapped.";
    }
    foreach ($where as $col => $idx) {
        if (count($idx) > 1) {
            $errors[] = "“{$col}” is mapped from " . count($idx) . ' file columns (' . implode(', ', array_map('bulkColLetter', $idx)) . ') — choose one.';
            $bad = array_merge($bad, $idx);
        }
    }
    return ['errors' => $errors, 'bad' => $bad];
}

/**
 * Light per-column normalisation before validation:
 *  - Excel date serials (20000–80000) → YYYY-MM-DD (+ time for created_at when fractional)
 *  - Excel time fractions → "07:00 AM" for pooja_time, "HH:MM" for start_time / end_time
 *  - "7:00", "07:00:00", "6.30 pm", "7 PM" → 24-hour "HH:MM" for start_time / end_time
 *  - DD/MM/YYYY (Indian convention) → YYYY-MM-DD for date columns
 *  - "₹1,001" / "Rs 1,001" → "1001" for amount and sponsorship_amount
 */
function bulkNormalizeValue(string $v, string $col, string $kind): string
{
    $v = trim($v);
    if ($v === '') return $v;
    $isDateCol  = in_array($col, ['event_date', 'end_date', 'pooja_date', 'created_at'], true);
    $isClockCol = in_array($col, ['start_time', 'end_time'], true);
    if ($kind === 'xlsx' && preg_match('/^\d+(\.\d+)?$/', $v)) {
        $n = (float) $v;
        if ($isDateCol && $n >= 20000 && $n <= 80000) {
            $ts = (int) round(($n - 25569) * 86400);
            return ($col === 'created_at' && ($n - floor($n)) > 1e-9) ? gmdate('Y-m-d H:i:s', $ts) : gmdate('Y-m-d', $ts);
        }
        if ($col === 'pooja_time' && $n > 0 && $n < 1) {
            return gmdate('h:i A', (int) round($n * 86400));
        }
        if ($isClockCol && $n >= 0 && $n < 1) {
            return gmdate('H:i', (int) round($n * 86400));
        }
    }
    if ($isDateCol && preg_match('/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})(\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?)?$/', $v, $m)
        && checkdate((int) $m[2], (int) $m[1], (int) $m[3])) {
        $v = sprintf('%04d-%02d-%02d', $m[3], $m[2], $m[1]) . (isset($m[4]) ? ' ' . trim($m[4]) : '');
    }
    if ($isClockCol) {
        // 24-hour "H:MM[:SS]" or 12-hour "H[:MM] am/pm"; anything else is left for the rule to refuse.
        if (preg_match('/^(\d{1,2}):(\d{2})(?::\d{2})?$/', $v, $m) && (int) $m[1] < 24) {
            $v = sprintf('%02d:%s', (int) $m[1], $m[2]);
        } elseif (preg_match('/^(\d{1,2})(?:[:.](\d{2}))?\s*([AaPp])\.?\s*[Mm]?\.?$/', $v, $m) && (int) $m[1] >= 1 && (int) $m[1] <= 12) {
            $h = (int) $m[1] % 12 + (strtolower($m[3]) === 'p' ? 12 : 0);
            // PCRE reports a skipped minutes group as '' (not unset) when a later group matched: "7 PM" is 19:00.
            $v = sprintf('%02d:%s', $h, ($m[2] ?? '') !== '' ? $m[2] : '00');
        }
    }
    if ($col === 'amount' || $col === 'sponsorship_amount') {
        $clean = preg_replace('/^rs\.?\s*|[₹,\s]/iu', '', $v);
        if ($clean !== '' && is_numeric($clean)) $v = $clean;
    }
    return $v;
}

/** Apply the column map to the raw rows and validate → [['line','data','errors','status'], …]. */
function bulkBuildRows(PDO $db, array $def, array $state, array $map): array
{
    $existing = [];
    foreach ($db->query($def['dupSql'])->fetchAll(PDO::FETCH_ASSOC) as $ex) {
        $existing[bulkDupSignature($ex, $def['dupKey'])] = true;
    }
    $kind = (string) ($state['kind'] ?? 'csv');
    $seen = $rows = [];
    foreach ($state['raw'] as $ri => $raw) {
        $line = (int) ($state['lines'][$ri] ?? ($ri + 2));
        $data = array_fill_keys($def['columns'], '');
        foreach ($map as $i => $col) {
            if ($col === '' || !isset($data[$col])) continue;
            // Clamped to the column's width as the admin forms clamp their fields.
            $data[$col] = bulkNormalizeValue(sanitizeText((string) ($raw[$i] ?? ''), (int) ($def['maxlen'][$col] ?? 2000)), $col, $kind);
        }
        $errors = [];
        foreach ($def['required'] as $col) {
            if ($data[$col] === '') $errors[] = "$col is required";
        }
        foreach ($def['rules'] as $col => [$fn, $message]) {
            if ($data[$col] !== '' || in_array($col, $def['required'], true)) {
                if (!$fn($data[$col])) $errors[] = "$col $message";
            }
        }
        // Rules across columns only make sense once every single cell is valid.
        if (!$errors && isset($def['check'])) {
            foreach (($def['check'])($data) as $e) $errors[] = $e;
        }
        $status = $errors ? 'invalid' : 'ok';
        if (!$errors) {
            $sig = bulkDupSignature($data, $def['dupKey']);
            if (isset($existing[$sig])) {
                $status = 'duplicate';
                $errors[] = 'Already exists in database';
            } elseif (isset($seen[$sig])) {
                $status = 'duplicate';
                $errors[] = 'Duplicate of row ' . $seen[$sig];
            } else {
                $seen[$sig] = $line;
            }
        }
        $rows[] = ['line' => $line, 'data' => $data, 'errors' => $errors, 'status' => $status];
    }
    return $rows;
}

/** Insert a batch of validated rows inside one transaction → ['ok','fail','skipped','dup']. */
function bulkImportRows(PDO $db, array $def, array $rows, bool $skipDup): array
{
    $stmt = $db->prepare($def['insert']);
    $ok = $fail = $skipped = $dup = 0;
    $db->beginTransaction();
    try {
        foreach ($rows as $r) {
            if ($r['status'] === 'invalid') { $skipped++; continue; }
            if ($r['status'] === 'duplicate' && $skipDup) { $dup++; continue; }
            try {
                $stmt->execute(($def['map'])($r['data']));
                $ok++;
            } catch (Throwable) {
                $fail++;
            }
        }
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
    return ['ok' => $ok, 'fail' => $fail, 'skipped' => $skipped, 'dup' => $dup];
}

function bulkCounts(array $rows): array
{
    return array_count_values(array_column($rows, 'status')) + ['ok' => 0, 'invalid' => 0, 'duplicate' => 0];
}

// ── Request state ──────────────────────────────────────────────────────────
$entities = bulkEntities();
$entityRaw = $_GET['entity'] ?? $_POST['entity'] ?? '';
$entity    = is_string($entityRaw) ? $entityRaw : '';
if (!isset($entities[$entity])) $entity = '';
$def    = $entity ? $entities[$entity] : null;
$db     = getDB();
$msg    = '';
$step   = $entity ? 2 : 1;   // 1 choose · 2 upload · 3 map · 4 preview · 5 import · 6 results
$state  = $_SESSION['bulk'] ?? null;
if ($state !== null && (!is_array($state) || !isset($entities[$state['entity'] ?? ''], $state['stage']))) {
    unset($_SESSION['bulk']);
    $state = null;
}

// ── Template download ──────────────────────────────────────────────────────
if ($def && isset($_GET['template'])) {
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $entity . '-template.csv"');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF");
    fputcsv($out, $def['columns'], ',', '"', '\\');
    fputcsv($out, $def['sample'], ',', '"', '\\');
    fclose($out);
    exit;
}

// ── Error report download (invalid + duplicate rows) ───────────────────────
if ($def && isset($_GET['errors']) && $state && $state['entity'] === $entity && !empty($state['rows'])) {
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $entity . '-errors.csv"');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF");
    fputcsv($out, array_merge(['row', 'status', 'problems'], $def['columns']), ',', '"', '\\');
    foreach ($state['rows'] as $r) {
        if ($r['status'] === 'ok') continue;
        fputcsv($out, array_merge([$r['line'], $r['status'], implode('; ', $r['errors'])], array_values($r['data'])), ',', '"', '\\');
    }
    fclose($out);
    exit;
}

// A finished import is kept for one request (so the results page can still
// offer the error report) and cleared on the next navigation.
if ($state && !empty($state['finished']) && !isset($_GET['done'])) {
    unset($_SESSION['bulk']);
    $state = null;
}

// ── POST actions ───────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $msg    = adminCsrfGuard();
    $action = (string) ($_POST['action'] ?? '');

    // A multipart body above post_max_size arrives with $_POST and $_FILES empty
    if ($msg !== '' && empty($_POST) && empty($_FILES) && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
        $msg = bulkFlash('error', 'The upload was too large for the server (limit ' . h((string) ini_get('post_max_size')) . '). Split the file into smaller parts and try again.');
    }

    // Step 5 — one batch of the chunked import (JSON for admin.js; answered before any HTML)
    if ($action === 'import_chunk') {
        if ($msg !== '') {
            sendJson(['error' => 'Your session expired. Reload the page and start the import again.']);
        }
        if (!$def || !$state || $state['entity'] !== $entity || empty($state['rows']) || !in_array($state['stage'], ['importing', 'done'], true)) {
            sendJson(['error' => 'No import is pending for this data type. Reload the page.']);
        }
        $total   = count($state['rows']);
        $offset  = max(0, (int) ($_POST['offset'] ?? 0));
        $limit   = min(500, max(1, (int) ($_POST['limit'] ?? BULK_CHUNK)));
        $skipDup = isset($_POST['skip_duplicates']) ? (string) $_POST['skip_duplicates'] === '1' : !empty($state['skip_duplicates']);
        $result  = $state['result'] ?? ['ok' => 0, 'fail' => 0, 'skipped' => 0, 'dup' => 0, 'processed' => 0, 'total' => $total, 'file' => $state['file']];
        $start   = max($offset, (int) $result['processed']); // a repeated request never re-inserts rows
        $slice   = array_slice($state['rows'], $start, $limit);
        try {
            $c = bulkImportRows($db, $def, $slice, $skipDup);
        } catch (Throwable $e) {
            sendJson(['error' => 'Database error — this batch was rolled back: ' . $e->getMessage()]);
        }
        $end = $start + count($slice);
        foreach (['ok', 'fail', 'skipped', 'dup'] as $k) $result[$k] += $c[$k];
        $result['processed'] = $end;
        $_SESSION['bulk']['result'] = $result;
        $_SESSION['bulk']['at']     = time();
        if ($end >= $total) {
            $_SESSION['bulk']['stage'] = 'done';
            adminAudit('bulk_import', 'bulk:' . $entity, sprintf('%s · %d inserted, %d failed, %d duplicates skipped, %d invalid skipped', (string) ($state['file'] ?? ''), $result['ok'], $result['fail'], $result['dup'], $result['skipped']));
        }
        sendJson(['processed' => $end - $offset, 'ok' => $c['ok'], 'fail' => $c['fail'], 'dup' => $c['dup'], 'skipped' => $c['skipped'], 'total' => $total]);
    }

    if ($msg === '' && $def) {
        // Step 2 → 3: upload + parse
        if ($action === 'upload') {
            $file = $_FILES['file'] ?? $_FILES['csv'] ?? null;
            $err  = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);
            if (!$file || $err === UPLOAD_ERR_NO_FILE) {
                $msg = bulkFlash('error', 'Please choose a CSV or Excel (.xlsx) file to upload.');
            } elseif ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) {
                $msg = bulkFlash('error', 'The file is larger than the server upload limit (' . h((string) ini_get('upload_max_filesize')) . ').');
            } elseif ($err !== UPLOAD_ERR_OK) {
                $msg = bulkFlash('error', 'The upload failed (code ' . $err . '). Please try again.');
            } elseif ((int) $file['size'] > BULK_MAX_MB * 1024 * 1024) {
                $msg = bulkFlash('error', 'File is larger than ' . BULK_MAX_MB . ' MB.');
            } elseif (!preg_match('/\.(csv|txt|xlsx)$/i', (string) $file['name'])) {
                $msg = bulkFlash('error', 'Only .csv, .txt or .xlsx files are supported. Older .xls workbooks: open in Excel and <em>Save As → Excel Workbook (.xlsx)</em> or <em>CSV UTF-8</em>.');
            } else {
                $isXlsx = (bool) preg_match('/\.xlsx$/i', (string) $file['name']);
                try {
                    $parsed = $isXlsx ? bulkReadXlsx($file['tmp_name']) : bulkReadCsv($file['tmp_name']);
                    if (!$parsed['rows']) {
                        $msg = bulkFlash('error', 'No data rows found under the header row.');
                    } else {
                        $_SESSION['bulk'] = $state = [
                            'entity' => $entity, 'file' => basename((string) $file['name']), 'kind' => $isXlsx ? 'xlsx' : 'csv',
                            'header' => $parsed['header'], 'raw' => $parsed['rows'], 'lines' => $parsed['lines'],
                            'truncated' => $parsed['truncated'], 'map' => bulkAutoMap($parsed['header'], $def),
                            'stage' => 'uploaded', 'at' => time(),
                        ];
                        $step = 3;
                        $msg  = bulkFlash('success', 'Read ' . number_format(count($parsed['rows'])) . ' row(s) and ' . count($parsed['header']) . ' column(s) from <strong>' . h($state['file']) . '</strong>. Check the column mapping below.');
                        if ($parsed['truncated']) {
                            $msg .= bulkFlash('warning', 'Only the first ' . number_format(BULK_MAX_ROWS) . ' rows were read. Split larger files.');
                        }
                    }
                } catch (RuntimeException $e) {
                    $msg = bulkFlash('error', h($e->getMessage()));
                }
            }
        }

        // Step 3 → 4: apply the column map, validate
        elseif ($action === 'map' && $state && $state['entity'] === $entity && isset($state['header']) && $state['stage'] === 'uploaded') {
            $posted = is_array($_POST['map'] ?? null) ? $_POST['map'] : [];
            $map    = [];
            foreach (array_keys($state['header']) as $i) {
                $c = (string) ($posted[$i] ?? '');
                $map[$i] = in_array($c, $def['columns'], true) ? $c : '';
            }
            $issues = bulkMapIssues($map, $def);
            $_SESSION['bulk']['map'] = $state['map'] = $map;
            if ($issues['errors']) {
                $msg  = bulkFlash('error', 'Please fix the column mapping: ' . h(implode(' ', $issues['errors'])));
                $step = 3;
            } else {
                $ignored = [];
                foreach ($map as $i => $col) {
                    if ($col === '') $ignored[] = (string) ($state['header'][$i] ?? '') !== '' ? (string) $state['header'][$i] : 'column ' . bulkColLetter($i);
                }
                $_SESSION['bulk']['rows']    = bulkBuildRows($db, $def, $state, $map);
                $_SESSION['bulk']['unknown'] = $ignored;
                $_SESSION['bulk']['stage']   = 'mapped';
                $_SESSION['bulk']['at']      = time();
                unset($_SESSION['bulk']['result']);
                $state = $_SESSION['bulk'];
                $step  = 4;
            }
        }

        // Step 4 → 3: go back and change the mapping
        elseif ($action === 'remap' && $state && $state['entity'] === $entity && $state['stage'] === 'mapped') {
            unset($_SESSION['bulk']['rows'], $_SESSION['bulk']['unknown'], $_SESSION['bulk']['result']);
            $_SESSION['bulk']['stage'] = 'uploaded';
            $_SESSION['bulk']['at']    = time();
            $state = $_SESSION['bulk'];
            $step  = 3;
        }

        // Step 4 → 5: start the chunked import (the page renders the progress runner)
        elseif ($action === 'confirm' && $state && $state['entity'] === $entity) {
            if (in_array($state['stage'], ['importing', 'done'], true)) {
                header('Location: /admin/bulk_upload.php?entity=' . $entity . '&done=1');
                exit;
            }
            $counts = bulkCounts($state['rows'] ?? []);
            if ($state['stage'] !== 'mapped' || empty($state['rows'])) {
                $msg = bulkFlash('error', 'Please map the columns before importing.');
            } elseif ($counts['ok'] + $counts['duplicate'] === 0) {
                $msg  = bulkFlash('error', 'There are no importable rows in this file. Fix the problems listed in the error report and upload again.');
                $step = 4;
            } else {
                $_SESSION['bulk']['skip_duplicates'] = isset($_POST['skip_duplicates']);
                $_SESSION['bulk']['stage']  = 'importing';
                $_SESSION['bulk']['result'] = ['ok' => 0, 'fail' => 0, 'skipped' => 0, 'dup' => 0, 'processed' => 0, 'total' => count($state['rows']), 'file' => $state['file']];
                $_SESSION['bulk']['at']     = time();
                $state = $_SESSION['bulk'];
                $step  = 5;
            }
        }

        // <noscript> fallback: synchronous import in one transaction
        elseif ($action === 'confirm_sync' && $state && $state['entity'] === $entity && !empty($state['rows'])
                && in_array($state['stage'], ['mapped', 'importing'], true) && (int) ($state['result']['processed'] ?? 0) === 0) {
            $skipDup = isset($_POST['skip_duplicates']) && (string) $_POST['skip_duplicates'] !== '0';
            try {
                $c = bulkImportRows($db, $def, $state['rows'], $skipDup);
                adminAudit('bulk_import', 'bulk:' . $entity, sprintf('%s · %d inserted, %d failed, %d duplicates skipped, %d invalid skipped', (string) ($state['file'] ?? ''), $c['ok'], $c['fail'], $c['dup'], $c['skipped']));
                $_SESSION['bulk']['result'] = $c + ['processed' => count($state['rows']), 'total' => count($state['rows']), 'file' => $state['file']];
                $_SESSION['bulk']['stage']  = 'done';
                $state = $_SESSION['bulk'];
                $step  = 6;
            } catch (Throwable $e) {
                $msg  = bulkFlash('error', 'Import failed and was rolled back: ' . h($e->getMessage()));
                $step = 4;
            }
        }

        elseif ($action === 'cancel') {
            unset($_SESSION['bulk']);
            $state = null;
            $step  = 2;
            $msg   = bulkFlash('info', 'Upload discarded. Nothing was saved.');
        }
    }
}

// ── Resume a pending upload for this entity ────────────────────────────────
if ($step === 2 && $def && $state && $state['entity'] === $entity && ($_SERVER['REQUEST_METHOD'] !== 'POST' || $msg === '')) {
    $stale = (time() - (int) $state['at']) > BULK_TTL && !in_array($state['stage'], ['importing', 'done'], true);
    if ($stale) {
        unset($_SESSION['bulk']);
        $state = null;
        $msg  .= bulkFlash('info', 'Your previous upload expired after 30 minutes of inactivity. Please upload the file again.');
    } else {
        $step = match ($state['stage']) {
            'uploaded'  => 3,
            'mapped'    => 4,
            // An import still in flight goes back to the runner, which resumes
            // from result.processed instead of being declared interrupted.
            'importing' => !empty($state['rows']) ? 5 : 2,
            'done'      => !empty($state['result']) ? 6 : 2,
            default     => 2,
        };
    }
}
if ($def && isset($_GET['done']) && $step !== 6 && $step !== 5) {
    $msg .= bulkFlash('info', 'The import has finished, but its summary is no longer available.');
}
if ($step === 6 && (!$state || empty($state['result']))) {
    $step = 2;
}

$counts  = ($state && !empty($state['rows'])) ? bulkCounts($state['rows']) : null;
$result  = $step === 6 ? $state['result'] : null;
$mapNow  = ($def && $state && isset($state['header'])) ? ($state['map'] ?? bulkAutoMap($state['header'], $def)) : [];
$issues  = ($step === 3 && $def) ? bulkMapIssues($mapNow, $def) : ['errors' => [], 'bad' => []];
$mapPosted = $_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'map';
$mapBad  = $mapPosted ? array_flip($issues['bad']) : [];
if ($step === 6 && $state && ($state['stage'] ?? '') === 'done') {
    $_SESSION['bulk']['finished'] = true; // cleared on the next navigation
}

// ── Page chrome ────────────────────────────────────────────────────────────
$templateBtn = $def ? '<a href="?entity=' . h($entity) . '&amp;template=1" class="btn btn--sm">' . adminIcon('download') . 'Download template</a>' : '';
$changeBtn   = '<a href="/admin/bulk_upload.php" class="btn btn-ghost btn--sm">' . adminIcon('arrow-left') . 'Choose different data</a>';
$reportBtn   = ($def && $counts && ($counts['invalid'] > 0 || $counts['duplicate'] > 0)) ? '<a href="?entity=' . h($entity) . '&amp;errors=1" class="btn btn--sm">' . adminIcon('download') . 'Error report</a>' : '';
$viewBtn     = $def ? '<a href="/admin/' . h($def['table']) . '.php" class="btn btn-ghost btn--sm">' . adminIcon($def['icon']) . 'View ' . h($def['label']) . '</a>' : '';

$intro = match ($step) {
    1 => ['Import many records at once from a CSV or Excel file: pick the data type, upload, map the columns, review the validation and import with live progress.', ''],
    2 => ['Upload a CSV or Excel (.xlsx) file of ' . strtolower($def['label']) . '; nothing is saved until you have reviewed the preview.', $templateBtn . $changeBtn],
    3 => ['Match each column in ' . ($state['file'] ?? 'the file') . ' to a ' . strtolower(rtrim($def['label'], 's')) . ' field — required fields are marked with an asterisk.', $templateBtn . $changeBtn],
    4 => ['Review how every row validated before anything is written: invalid rows are skipped and duplicates can be excluded.', $reportBtn . $templateBtn . $changeBtn],
    5 => ['Rows are being written in batches of ' . BULK_CHUNK . '; keep this tab open until the import completes.', ''],
    default => ['Summary of the import into ' . $def['label'] . '.', $reportBtn . $changeBtn],
};

adminHeader('Bulk Upload', 'Devotees', ['actions' => $viewBtn, 'wide' => $step === 4]);
echo $msg;
echo adminPageIntro($intro[0], $intro[1]);
?>

<nav class="stepper" aria-label="Import progress">
  <?php foreach ([1 => 'Choose data', 2 => 'Upload', 3 => 'Map columns', 4 => 'Validate & preview', 5 => 'Import', 6 => 'Results'] as $n => $label): ?>
    <span class="step<?= $n < $step ? ' step--done' : ($n === $step ? ' step--active' : '') ?>"<?= $n === $step ? ' aria-current="step"' : '' ?>>
      <span class="step__num"><?= $n < $step ? adminIcon('check', 'ico--xs') : $n ?></span><?= h($label) ?>
    </span>
  <?php endforeach; ?>
</nav>

<?php if ($step === 1): ?>
<section class="card card--static" aria-labelledby="choose-title">
  <div class="card__head"><h2 id="choose-title"><?= adminIcon('spreadsheet', 'ico--sm') ?> What would you like to import?</h2></div>
  <div class="card__body">
    <p class="muted mb-4">Choose a data type. You will get a template, upload your file, confirm how its columns map, and review every row before anything is saved.</p>
    <div class="template-grid">
      <?php foreach ($entities as $key => $e): ?>
        <a class="entity-card" href="?entity=<?= h($key) ?>">
          <span class="entity-card__icon" aria-hidden="true"><?= adminIcon($e['icon']) ?></span>
          <strong><?= h($e['label']) ?></strong>
          <small><?= count($e['columns']) ?> columns · <?= count($e['required']) ?> required</small>
        </a>
      <?php endforeach; ?>
    </div>
  </div>
</section>

<?php elseif ($step === 2): ?>
<div class="admin-two-col admin-two-col--wide-form">
  <section class="card card--static" aria-labelledby="upload-title">
    <div class="card__head">
      <h2 id="upload-title"><?= adminIcon($def['icon'], 'ico--sm') ?> Upload <?= h($def['label']) ?></h2>
      <?= adminBadge('Step 2 of 6', 'muted') ?>
    </div>
    <div class="card__body">
      <form method="POST" enctype="multipart/form-data" class="stack">
        <?= csrfField() ?>
        <input type="hidden" name="entity" value="<?= h($entity) ?>" />
        <input type="hidden" name="action" value="upload" />
        <input type="hidden" name="MAX_FILE_SIZE" value="<?= BULK_MAX_MB * 1024 * 1024 ?>" />
        <div class="dropzone" tabindex="0">
          <span class="dropzone__icon" aria-hidden="true"><?= adminIcon('upload') ?></span>
          <span class="dropzone__title">Drag &amp; drop your file here, or click to browse</span>
          <span class="field__hint">CSV or Excel (.xlsx) · up to <?= BULK_MAX_MB ?> MB · max <?= number_format(BULK_MAX_ROWS) ?> rows</span>
          <span class="dropzone__file" aria-live="polite"></span>
          <input type="file" id="bulk-file" name="file" accept=".csv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required aria-required="true" aria-label="Choose a CSV or Excel file" />
        </div>
        <div class="callout">
          <?= adminIcon('info') ?>
          <p>Excel dates may be real date cells or text such as <code>2027-01-24</code> — both are understood. Times may be Excel time cells or text like <code>07:00 AM</code>. Only the first worksheet is read.</p>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary"><?= adminIcon('upload') ?> Upload &amp; continue</button>
          <a href="?entity=<?= h($entity) ?>&amp;template=1" class="btn"><?= adminIcon('download') ?> Download template</a>
          <a href="/admin/bulk_upload.php" class="btn btn-ghost">Change type</a>
        </div>
      </form>
    </div>
  </section>

  <section class="card card--static" aria-labelledby="cols-title">
    <div class="card__head"><h2 id="cols-title"><?= adminIcon('table', 'ico--sm') ?> Expected columns</h2></div>
    <div class="card__body">
      <code class="cols"><?= h(implode(', ', $def['columns'])) ?></code>
      <dl class="dl-grid mt-4">
        <dt>Required</dt><dd><?= h(implode(', ', $def['required'])) ?></dd>
        <dt>Duplicates</dt><dd>Detected on <?= h(implode(' + ', $def['dupKey'])) ?></dd>
        <dt>Dates</dt><dd><code>YYYY-MM-DD</code> (or <code>DD/MM/YYYY</code>, or real Excel dates)</dd>
        <dt>Yes / no</dt><dd>Accept yes, no, 1, 0, true, false</dd>
        <dt>Headers</dt><dd>Any order and any wording — you will confirm the column mapping in the next step.</dd>
      </dl>
      <?php if (!empty($def['help'])): ?>
      <h3 class="subhead mt-4">Column notes</h3>
      <dl class="dl-grid" data-column-help>
        <?php foreach ($def['help'] as $col => $note): ?>
          <dt><code><?= h($col) ?></code></dt><dd><?= h($note) ?></dd>
        <?php endforeach; ?>
      </dl>
      <?php endif; ?>
      <p class="field__hint mt-4">Nothing is saved until you confirm on the preview screen.</p>
    </div>
  </section>
</div>

<?php elseif ($step === 3 && $state): ?>
<?php
  $reqMapped = count(array_intersect($def['required'], array_filter($mapNow, fn($c) => $c !== '')));
  $reqTotal  = count($def['required']);
  $samples   = function (int $i) use ($state): string {
      $vals = [];
      foreach ($state['raw'] as $r) {
          $v = trim((string) ($r[$i] ?? ''));
          if ($v === '') continue;
          $vals[] = mb_strimwidth($v, 0, 28, '…');
          if (count($vals) === 3) break;
      }
      return $vals ? implode(' · ', $vals) : '—';
  };
?>
<section class="card card--static" aria-labelledby="map-title">
  <div class="card__head">
    <h2 id="map-title"><?= adminIcon('list-checks', 'ico--sm') ?> Map columns · <?= h($state['file']) ?></h2>
    <?= adminBadge(number_format(count($state['raw'])) . ' rows · ' . count($state['header']) . ' columns', 'info') ?>
  </div>
  <form method="POST" id="map-form">
    <?= csrfField() ?>
    <input type="hidden" name="entity" value="<?= h($entity) ?>" />
    <input type="hidden" name="action" value="map" />
    <div class="table-wrap table-wrap--flush">
      <table class="table map-table" data-no-search>
        <thead>
          <tr>
            <th scope="col">File column</th>
            <th scope="col">Sample values</th>
            <th scope="col">Maps to</th>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($state['header'] as $i => $name): $sel = $mapNow[$i] ?? ''; $hid = 'map-' . $i; ?>
          <tr>
            <td>
              <span class="cell-title"><?= $name !== '' ? h($name) : '(unnamed)' ?></span>
              <span class="cell-sub">Column <?= bulkColLetter((int) $i) ?></span>
            </td>
            <td><div class="map-sample" title="<?= h($samples((int) $i)) ?>"><?= h($samples((int) $i)) ?></div></td>
            <td>
              <label class="sr-only" for="<?= $hid ?>">Map file column <?= h($name !== '' ? $name : bulkColLetter((int) $i)) ?> to</label>
              <select id="<?= $hid ?>" name="map[<?= (int) $i ?>]"<?= isset($mapBad[$i]) ? ' aria-invalid="true"' : '' ?>>
                <option value=""<?= $sel === '' ? ' selected' : '' ?>>— Ignore —</option>
                <optgroup label="Required">
                  <?php foreach ($def['required'] as $col): ?>
                    <option value="<?= h($col) ?>"<?= $sel === $col ? ' selected' : '' ?>><?= h($col) ?> *</option>
                  <?php endforeach; ?>
                </optgroup>
                <optgroup label="Optional">
                  <?php foreach (array_diff($def['columns'], $def['required']) as $col): ?>
                    <option value="<?= h($col) ?>"<?= $sel === $col ? ' selected' : '' ?>><?= h($col) ?></option>
                  <?php endforeach; ?>
                </optgroup>
              </select>
            </td>
          </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>
    <div class="card__body">
      <?php if ($issues['errors'] && $mapPosted): ?>
        <?= bulkAlert('error', '<strong>Mapping incomplete — ' . $reqMapped . ' of ' . $reqTotal . ' required columns mapped.</strong> ' . h(implode(' ', $issues['errors']))) ?>
      <?php elseif ($issues['errors']): ?>
        <?= bulkAlert('warning', '<strong>' . $reqMapped . ' of ' . $reqTotal . ' required columns mapped.</strong> ' . h(implode(' ', $issues['errors']))) ?>
      <?php else: ?>
        <?= bulkAlert('success', '<strong>' . $reqMapped . ' of ' . $reqTotal . ' required columns mapped.</strong> Continue to validate the rows.') ?>
      <?php endif; ?>
      <?php $ignoredNow = array_keys(array_filter($mapNow, fn($c) => $c === '')); if ($ignoredNow): ?>
        <p class="field__hint">Ignored file columns: <?= h(implode(', ', array_map(fn($i) => ($state['header'][$i] ?? '') !== '' ? $state['header'][$i] : 'column ' . bulkColLetter((int) $i), $ignoredNow))) ?>.</p>
      <?php endif; ?>
      <div class="form-actions mt-4">
        <button type="submit" class="btn btn-primary"><?= adminIcon('arrow-right') ?> Continue to preview</button>
        <button type="submit" class="btn btn-ghost" name="action" value="cancel" formnovalidate data-confirm="Discard this upload? Nothing has been saved yet." data-confirm-label="Discard">Cancel</button>
      </div>
    </div>
  </form>
</section>

<?php elseif ($step === 4 && $state && $counts): ?>
<?php $importable = $counts['ok'] + $counts['duplicate']; ?>
<section class="card card--static" aria-labelledby="preview-title">
  <div class="card__head">
    <h2 id="preview-title"><?= adminIcon('eye', 'ico--sm') ?> Validate &amp; preview · <?= h($state['file']) ?></h2>
    <?= adminBadge(number_format(count($state['rows'])) . ' rows', 'info') ?>
  </div>
  <div class="card__body">
    <div class="import-summary">
      <div class="import-summary__item import-summary__item--ok"><div class="import-summary__val"><?= $counts['ok'] ?></div><div class="import-summary__label">Ready</div></div>
      <div class="import-summary__item import-summary__item--warn"><div class="import-summary__val"><?= $counts['duplicate'] ?></div><div class="import-summary__label">Duplicates</div></div>
      <div class="import-summary__item import-summary__item--bad"><div class="import-summary__val"><?= $counts['invalid'] ?></div><div class="import-summary__label">Invalid</div></div>
    </div>
    <?php if (!empty($state['truncated'])): ?>
      <?= bulkAlert('warning', 'Only the first ' . number_format(BULK_MAX_ROWS) . ' rows of the file were read.') ?>
    <?php endif; ?>
    <?php if (!empty($state['unknown'])): ?>
      <?= bulkAlert('info', 'Ignored file column(s): <strong>' . h(implode(', ', $state['unknown'])) . '</strong>.') ?>
    <?php endif; ?>
    <?php if ($counts['invalid'] > 0): ?>
      <?= bulkAlert('error', $counts['invalid'] . ' row(s) have problems and will be <strong>skipped</strong>. <a href="?entity=' . h($entity) . '&amp;errors=1">Download the error report</a>, fix those rows and upload them again.') ?>
    <?php endif; ?>
    <?php if ($counts['duplicate'] > 0): ?>
      <?= bulkAlert('warning', $counts['duplicate'] . ' row(s) already exist (matched on ' . h(implode(' + ', $def['dupKey'])) . ') or repeat within the file.') ?>
    <?php endif; ?>

    <form method="POST" class="stack">
      <?= csrfField() ?>
      <input type="hidden" name="entity" value="<?= h($entity) ?>" />
      <input type="hidden" name="action" value="confirm" />
      <?php if ($counts['duplicate'] > 0): ?>
        <label class="switch">
          <input type="checkbox" name="skip_duplicates" value="1" checked />
          <span class="switch__track"></span>
          <span class="switch__label">Skip duplicate rows <span class="switch__desc">Recommended — untick to import them anyway.</span></span>
        </label>
      <?php endif; ?>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary"<?= $importable === 0 ? ' disabled aria-disabled="true"' : '' ?>><?= adminIcon('upload') ?> Import <?= $counts['ok'] ?> row<?= $counts['ok'] === 1 ? '' : 's' ?></button>
        <button type="submit" class="btn" name="action" value="remap" formnovalidate><?= adminIcon('arrow-left') ?> Change mapping</button>
        <?php if ($counts['invalid'] > 0 || $counts['duplicate'] > 0): ?>
          <a href="?entity=<?= h($entity) ?>&amp;errors=1" class="btn"><?= adminIcon('download') ?> Error report</a>
        <?php endif; ?>
        <button type="submit" class="btn btn-ghost" name="action" value="cancel" formnovalidate data-confirm="Discard this upload? Nothing has been saved yet." data-confirm-label="Discard">Cancel</button>
      </div>
    </form>
  </div>
</section>

<h2 class="subhead">Row preview</h2>
<div class="table-wrap">
  <table class="table table--compact">
    <thead>
      <tr>
        <th scope="col">Row</th>
        <th scope="col">Status</th>
        <?php foreach ($def['columns'] as $c): ?><th scope="col"><?= h($c) ?></th><?php endforeach; ?>
        <th scope="col">Problems</th>
      </tr>
    </thead>
    <tbody>
      <?php foreach (array_slice($state['rows'], 0, BULK_PREVIEW) as $r): ?>
      <tr class="<?= $r['status'] === 'invalid' ? 'row--invalid' : ($r['status'] === 'duplicate' ? 'row--duplicate' : '') ?>">
        <td class="num"><?= (int) $r['line'] ?></td>
        <td><?= adminBadge(ucfirst($r['status']), ['ok' => 'success', 'duplicate' => 'warning', 'invalid' => 'danger'][$r['status']] ?? 'muted') ?></td>
        <?php foreach ($def['columns'] as $c): $v = (string) $r['data'][$c]; ?>
          <td<?= mb_strlen($v) > 40 ? ' title="' . h($v) . '"' : '' ?>><?= $v === '' ? '<span class="cell-muted">—</span>' : h(mb_strimwidth($v, 0, 40, '…')) ?></td>
        <?php endforeach; ?>
        <td><?php if ($r['errors']): ?><div class="row-errors"><?php foreach ($r['errors'] as $e): ?><span><?= h($e) ?></span><?php endforeach; ?></div><?php else: ?><span class="cell-muted">—</span><?php endif; ?></td>
      </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
</div>
<div class="pagination">
  <span><?= count($state['rows']) > BULK_PREVIEW ? 'Showing the first ' . BULK_PREVIEW . ' of ' . number_format(count($state['rows'])) . ' rows — all rows will be processed.' : number_format(count($state['rows'])) . ' record' . (count($state['rows']) === 1 ? '' : 's') ?></span>
</div>

<?php elseif ($step === 5 && $state && !empty($state['result'])): ?>
<?php $total = (int) $state['result']['total']; $doneRows = min($total, max(0, (int) ($state['result']['processed'] ?? 0))); ?>
<section class="card card--static" aria-labelledby="import-title">
  <div class="card__head">
    <h2 id="import-title"><?= adminIcon('upload', 'ico--sm') ?> Importing <?= number_format($total) ?> row<?= $total === 1 ? '' : 's' ?>…</h2>
    <?= adminBadge('In progress', 'gold', true) ?>
  </div>
  <div class="import-progress">
    <div class="progress progress--sm" role="progressbar" aria-label="Import progress" aria-valuemin="0" aria-valuemax="<?= $total ?>" aria-valuenow="<?= $doneRows ?>"
         data-import-runner data-total="<?= $total ?>" data-chunk="<?= BULK_CHUNK ?>" data-entity="<?= h($entity) ?>"
         data-offset="<?= $doneRows ?>"
         data-csrf="<?= h(csrfToken()) ?>" data-skip-duplicates="<?= !empty($state['skip_duplicates']) ? '1' : '0' ?>">
      <div class="progress__bar"></div>
    </div>
    <div class="import-progress__count" data-import-count aria-live="polite"><?= $doneRows ?> / <?= $total ?></div>
    <div class="import-progress__live" data-import-live aria-live="polite"></div>
    <p class="field__hint">Writing <?= h($state['file']) ?> into <?= h($def['label']) ?> in batches of <?= BULK_CHUNK ?>. Keep this tab open — you will be taken to the summary when it finishes.</p>
    <noscript>
      <form method="POST" class="stack">
        <?= csrfField() ?>
        <input type="hidden" name="entity" value="<?= h($entity) ?>" />
        <input type="hidden" name="action" value="confirm_sync" />
        <input type="hidden" name="skip_duplicates" value="<?= !empty($state['skip_duplicates']) ? '1' : '0' ?>" />
        <?= bulkAlert('warning', 'JavaScript is disabled, so live progress is unavailable. Press the button to import all rows in one step.') ?>
        <div class="form-actions"><button type="submit" class="btn btn-primary"><?= adminIcon('upload') ?> Import <?= number_format($total) ?> rows now</button></div>
      </form>
    </noscript>
  </div>
</section>

<?php elseif ($step === 6 && $result): ?>
<?php $interrupted = $state['stage'] === 'importing' && (int) $result['processed'] < (int) $result['total']; ?>
<section class="card card--static" aria-labelledby="result-title">
  <div class="card__head">
    <h2 id="result-title"><?= adminIcon('check-circle', 'ico--sm') ?> Import <?= $interrupted ? 'interrupted' : 'complete' ?> · <?= h($result['file']) ?></h2>
    <?= adminBadge(number_format((int) $result['processed']) . ' of ' . number_format((int) $result['total']) . ' rows processed', $interrupted ? 'warning' : 'success') ?>
  </div>
  <div class="card__body">
    <div class="import-summary">
      <div class="import-summary__item import-summary__item--ok"><div class="import-summary__val"><?= (int) $result['ok'] ?></div><div class="import-summary__label">Imported</div></div>
      <div class="import-summary__item import-summary__item--warn"><div class="import-summary__val"><?= (int) $result['dup'] ?></div><div class="import-summary__label">Duplicates skipped</div></div>
      <div class="import-summary__item import-summary__item--bad"><div class="import-summary__val"><?= (int) $result['skipped'] ?></div><div class="import-summary__label">Invalid skipped</div></div>
      <div class="import-summary__item import-summary__item--bad"><div class="import-summary__val"><?= (int) $result['fail'] ?></div><div class="import-summary__label">Failed</div></div>
      <div class="import-summary__item"><div class="import-summary__val"><?= (int) $result['total'] ?></div><div class="import-summary__label">Total rows</div></div>
    </div>
    <?php if ($interrupted): ?>
      <?= bulkAlert('warning', 'The import stopped after ' . number_format((int) $result['processed']) . ' of ' . number_format((int) $result['total']) . ' rows. Rows already saved were kept — upload the file again to import the rest (rows that were saved will show as duplicates).') ?>
    <?php elseif ((int) $result['ok'] > 0): ?>
      <?= bulkAlert('success', '<strong>' . (int) $result['ok'] . ' ' . h($def['label']) . ' record' . ((int) $result['ok'] === 1 ? '' : 's') . '</strong> ' . ((int) $result['ok'] === 1 ? 'was' : 'were') . ' added successfully.') ?>
    <?php else: ?>
      <?= bulkAlert('warning', 'No rows were imported.') ?>
    <?php endif; ?>
    <?php if ((int) $result['fail'] > 0 || (int) $result['skipped'] > 0 || (int) $result['dup'] > 0): ?>
      <?= bulkAlert('info', 'Rows that were skipped or failed are listed in the <a href="?entity=' . h($entity) . '&amp;errors=1">error report</a> (available until you leave this page). Fix them and upload that file again.') ?>
    <?php endif; ?>
    <div class="form-actions">
      <a href="/admin/<?= h($def['table']) ?>.php" class="btn btn-primary"><?= adminIcon($def['icon']) ?> View <?= h($def['label']) ?></a>
      <a href="?entity=<?= h($entity) ?>" class="btn"><?= adminIcon('upload') ?> Import another file</a>
      <a href="/admin/bulk_upload.php" class="btn btn-ghost"><?= adminIcon('arrow-left') ?> Choose different data</a>
    </div>
  </div>
</section>

<?php else: ?>
<?= adminEmpty('upload', 'Nothing to show', 'Start by choosing the kind of data you want to import.', '<a href="/admin/bulk_upload.php" class="btn btn-primary btn--sm">' . adminIcon('arrow-left') . 'Choose data</a>') ?>
<?php endif; ?>

<?php adminFooter(); ?>
