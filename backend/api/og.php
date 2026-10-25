<?php
/**
 * api/og.php — the page WhatsApp, Facebook, LinkedIn, X, Telegram, Slack and
 * Discord actually read when someone shares a link to this site.
 *
 * WHY
 * The public site is a React app. Its <Seo> component writes the title,
 * description and Open Graph tags after the JavaScript has run, which is fine
 * for browsers and for search engines that execute scripts — and useless for
 * link unfurlers, which fetch the HTML once and never run anything. Left to
 * index.html, every shared link would preview with the same title and no
 * picture, whichever page was sent.
 *
 * So Apache routes those crawlers here (see deploy/htaccess_public_html) and
 * this file renders a small, complete document for the path they asked about:
 * real title, real description, real image, correct canonical URL — and, for
 * the front page, an event and a broadcast, the same schema.org record
 * (JSON-LD, brief §22) the React page writes, so a crawler that never runs
 * JavaScript still reads the temple, the event or the video as structured data.
 *
 * WHERE THE WORDS COME FROM
 *   • a page's own copy       → includes/site_pages.php, kept in step with the
 *                               React pages by tests/og.mjs
 *   • the temple's own facts  → includes/site_settings.php (name, address,
 *                               phone, hours, social links), else the printed
 *                               constants mirrored from data/temple.js
 *   • one seva, one photo, one album, one event, one broadcast
 *                             → the database, the same rows the page renders
 * Nothing is invented here and no address is hard-coded: siteUrl() resolves the
 * origin from SITE_URL, falling back to the requested host.
 *
 * A person who opens this endpoint directly is sent on to the real page.
 *
 *   GET /api/og.php?path=/gallery&photo=7
 *   GET /api/og.php?path=/gallery&album=navaratri
 *   GET /api/og.php?path=/sevas&seva=3
 *   GET /api/og.php?path=/events&lang=en
 */

require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/site_pages.php';
require_once __DIR__ . '/../includes/site_settings.php';
require_once __DIR__ . '/../includes/live.php';
require_once __DIR__ . '/../includes/gallery_images.php';

ini_set('display_errors', '0');
ini_set('log_errors', '1');

/**
 * The temple's identity and printed address, as the shared-link layer states
 * them when the committee has not typed their own. Mirrors data/temple.js
 * (TEMPLE.name, TEMPLE.photoAlt, ADDRESS).
 */
function ogIdentity(): array
{
    return [
        'name_ta'     => 'அருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் திருக்கோவில்',
        'name_en'     => templeIdentity()['name_en'],
        'alt_ta'      => 'மலர் அலங்காரத்தில் மூன்று தெய்வங்கள் — ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள்',
        'alt_en'      => 'The three deities in floral alankaram — Sri Lingammal, Sri Renukadevi, Sri Chinnammal',
        'street_ta'   => 'நடு தெரு',
        'street_en'   => 'Middle Street',
        'locality_ta' => 'புதுப்பட்டி, திருவேங்கடம் தாலுகா, தென்காசி மாவட்டம்',
        'locality_en' => 'Pudupatti, Thiruvengadam Taluk, Tenkasi District',
        'region_ta'   => 'தமிழ்நாடு',
        'region_en'   => 'Tamil Nadu',
        'pin'         => '627719',
    ];
}

/** The temple's name in $lang: the committee's (Admin → System → Settings), else the printed one. */
function ogTempleName(string $lang): string
{
    $typed = siteSetting('temple_name', $lang);
    if (is_string($typed) && trim($typed) !== '') return trim($typed);
    return ogIdentity()[$lang === 'en' ? 'name_en' : 'name_ta'];
}

/**
 * The temple's address as schema.org takes it: the committee's own text when
 * they typed one, else the printed address as a PostalAddress in $lang.
 * The same rule as templeAddress() in frontend/src/components/Seo.jsx.
 */
function ogTempleAddress(string $lang): array|string
{
    $typed = siteSetting('temple_address', $lang);
    if (is_string($typed) && trim($typed) !== '') return preg_replace('/\s*\n+\s*/u', ', ', trim($typed));
    $id = ogIdentity();
    $l  = $lang === 'en' ? 'en' : 'ta';
    return [
        '@type'           => 'PostalAddress',
        'streetAddress'   => $id['street_' . $l],
        'addressLocality' => $id['locality_' . $l],
        'addressRegion'   => $id['region_' . $l],
        'postalCode'      => $id['pin'],
        'addressCountry'  => 'IN',
    ];
}

/** The temple as a place — the location of every event and broadcast. */
function ogTemplePlace(string $lang): array
{
    return ['@type' => 'HinduTemple', 'name' => ogTempleName($lang), 'address' => ogTempleAddress($lang)];
}

/**
 * The front page's record: the temple as a schema.org HinduTemple, from the
 * committee's settings (name, address, phone, e-mail, hours, social links)
 * else the printed constants. Mirrors templeJsonLd() in Seo.jsx.
 */
function ogTempleSchema(string $lang, string $image, string $description): array
{
    $other = $lang === 'en' ? 'ta' : 'en';
    $name  = ogTempleName($lang);
    $alt   = ogTempleName($other);
    $ld    = ['@context' => 'https://schema.org', '@type' => 'HinduTemple', 'name' => $name];
    if ($alt !== '' && $alt !== $name) $ld['alternateName'] = $alt;
    if ($description !== '') $ld['description'] = $description;
    $ld['url']   = siteUrl('/');
    $ld['image'] = $image;
    $phone = trim((string) siteSetting('phone_primary'));
    if ($phone !== '') $ld['telephone'] = $phone;
    $email = trim((string) siteSetting('email'));
    if ($email !== '') $ld['email'] = $email;
    $ld['address'] = ogTempleAddress($lang);
    $hours = [];
    foreach (siteSettingJson('temple_hours') as $w) {
        $open  = is_array($w) ? (string) ($w['open'] ?? '') : '';
        $close = is_array($w) ? (string) ($w['close'] ?? '') : '';
        if (!preg_match('/^\d{2}:\d{2}$/', $open) || !preg_match('/^\d{2}:\d{2}$/', $close)) continue;
        $hours[] = [
            '@type'     => 'OpeningHoursSpecification',
            'dayOfWeek' => ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
            'opens'     => $open,
            'closes'    => $close,
        ];
    }
    if ($hours) $ld['openingHoursSpecification'] = $hours;
    $sameAs = [];
    foreach (['social_youtube', 'social_facebook', 'social_instagram', 'social_whatsapp'] as $key) {
        $v = trim((string) siteSetting($key));
        if (preg_match('#^https://#i', $v)) $sameAs[] = $v;
    }
    if ($sameAs) $ld['sameAs'] = $sameAs;
    return $ld;
}

/** A site path or an absolute URL, made absolute the way the React app's absoluteUrl() does. */
function ogAbsolute(string $url): string
{
    $u = trim($url);
    if ($u === '' || preg_match('#^[a-z][a-z0-9+.-]*:#i', $u) || str_starts_with($u, '//')) return $u;
    return siteUrl($u);
}

/**
 * The schema.org Event record for one event row (migration 020 columns when
 * present). Dates are the temple's (IST); endDate is the last day with its
 * time, or the same day's end time, and absent when the committee gave
 * neither. Mirrors eventJsonLd() in frontend/src/pages/EventDetail.jsx.
 */
function ogEventSchema(array $event, string $lang, string $name, string $text, string $url): array
{
    $instant = static function (?string $date, ?string $time): ?string {
        $date = trim((string) $date);
        if ($date === '') return null;
        return preg_match('/^(\d{2}:\d{2})/', (string) $time, $m) ? $date . 'T' . $m[1] . ':00+05:30' : $date;
    };
    $endTime = (string) ($event['end_time'] ?? '');
    $endDay  = (string) ($event['end_date'] ?? '') ?: ($endTime !== '' ? (string) $event['event_date'] : '');
    $ld = ['@context' => 'https://schema.org', '@type' => 'Event', 'name' => $name];
    if ($text !== '') $ld['description'] = $text;
    $start = $instant((string) $event['event_date'], $event['start_time'] ?? null);
    if ($start !== null) $ld['startDate'] = $start;
    $end = $instant($endDay, $endTime);
    if ($end !== null) $ld['endDate'] = $end;
    $ld['eventStatus']         = 'https://schema.org/EventScheduled';
    $ld['eventAttendanceMode'] = 'https://schema.org/OfflineEventAttendanceMode';
    $ld['location']            = ogTemplePlace($lang);
    $image = trim((string) ($event['image_url'] ?? ''));
    if ($image !== '') $ld['image'] = ogAbsolute($image);
    $ld['url'] = $url;
    return $ld;
}

/**
 * A live or scheduled broadcast as a VideoObject whose publication is a
 * BroadcastEvent (the livestream markup Google reads): isLiveBroadcast, the
 * start (the actual one once live), the end when scheduled, the embed and
 * the thumbnail. Null for a recording or any other status. Mirrors
 * liveJsonLd() in frontend/src/pages/LiveDarshan.jsx.
 */
function ogLiveSchema(array $stream, string $lang, string $name, string $text, string $url): ?array
{
    if (!in_array((string) $stream['status'], ['LIVE', 'STARTING', 'SCHEDULED'], true)) return null;
    $start = !empty($stream['is_live']) && !empty($stream['actual_start_at']) ? $stream['actual_start_at'] : ($stream['scheduled_start_at'] ?? null);
    $end   = $stream['scheduled_end_at'] ?? null;
    $broadcast = ['@type' => 'BroadcastEvent', 'name' => $name, 'isLiveBroadcast' => true];
    if ($start) $broadcast['startDate'] = (string) $start;
    if ($end) $broadcast['endDate'] = (string) $end;
    $broadcast['location'] = ogTemplePlace($lang);
    $video = ['@context' => 'https://schema.org', '@type' => 'VideoObject', 'name' => $name];
    if ($text !== '') $video['description'] = $text;
    $video['url'] = $url;
    $thumb = (string) ($stream['thumbnail_url'] ?? '');
    if ($thumb !== '') $video['thumbnailUrl'] = ogAbsolute($thumb);
    $playback = $stream['playback'] ?? [];
    if (($playback['kind'] ?? '') === 'iframe' && !empty($playback['embedUrl'])) $video['embedUrl'] = (string) $playback['embedUrl'];
    $video['publication'] = $broadcast;
    return $video;
}

/**
 * JSON for the inside of <script type="application/ld+json">. The HTML parser
 * reads it before any JSON parser does and ends the script at the first
 * "</script" whatever quotes surround it, so "<", ">" and "&" are written as
 * JSON escapes (< …), which every JSON reader turns back into the same
 * characters. A stored title can therefore never close the block.
 */
function ogJsonLd(array $ld): string
{
    $json = json_encode($ld, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    return is_string($json) ? $json : '{}';
}

/**
 * The site path being asked about, reduced to something safe to echo into a
 * canonical URL: no host, no scheme, no fragment, no backslashes. Anything that
 * is not a plain local path is treated as the front page rather than trusted,
 * because this value ends up in a link the visitor's browser will follow.
 */
function ogPath(): string
{
    $raw = (string) ($_GET['path'] ?? '');
    if ($raw === '') {
        $raw = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
        // Reached directly with no path: there is nothing to describe but the site.
        if (str_contains($raw, 'og.php')) $raw = '/';
    }

    // Accept a whole "/gallery?photo=7" in one parameter as well as separate
    // query arguments — whichever way the caller found easier.
    $parts = explode('?', $raw, 2);
    $raw   = $parts[0];
    if (isset($parts[1])) {
        parse_str($parts[1], $extra);
        $_GET += is_array($extra) ? $extra : [];
    }

    $raw = explode('#', $raw)[0];
    $raw = '/' . ltrim($raw, '/');
    if (strlen($raw) > 512) return '/';
    if (preg_match('#[\\\\\s]|^/{2,}#', $raw)) return '/';
    return rtrim($raw, '/') ?: '/';
}

/** 'en' only when asked for; the site itself opens in Tamil. */
function ogLang(): string
{
    $q = strtolower(trim((string) ($_GET['lang'] ?? '')));
    if ($q === 'en' || $q === 'ta') return $q;
    // Crawlers usually forward the sharer's own Accept-Language.
    $accept = strtolower((string) ($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''));
    if ($accept !== '' && !str_contains($accept, 'ta') && str_contains($accept, 'en')) return 'en';
    return 'ta';
}

/**
 * An event's date, or span of dates, the way the Events page prints it:
 * "24 Jan 2026", "24–26 Jan 2026", "30 Jan – 2 Feb 2026". Month names are
 * spelled out in the reader's language.
 */
function ogEventDate(string $from, ?string $until, string $lang): string
{
    $months = $lang === 'en'
        ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        : ['ஜன', 'பிப்', 'மார்', 'ஏப்', 'மே', 'ஜூன்', 'ஜூலை', 'ஆக', 'செப்', 'அக்', 'நவ', 'டிச'];
    $one = static function (string $d) use ($months): ?array {
        if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $d, $m)) return null;
        return ['d' => (int) $m[3], 'm' => $months[(int) $m[2] - 1] ?? $m[2], 'y' => (int) $m[1], 'ym' => $m[1] . $m[2]];
    };
    $a = $one($from);
    if ($a === null) return $from;
    $b = $until !== null && $until !== $from ? $one($until) : null;
    if ($b === null) return "{$a['d']} {$a['m']} {$a['y']}";
    if ($a['ym'] === $b['ym']) return "{$a['d']}–{$b['d']} {$a['m']} {$a['y']}";
    if ($a['y'] === $b['y']) return "{$a['d']} {$a['m']} – {$b['d']} {$b['m']} {$a['y']}";
    return "{$a['d']} {$a['m']} {$a['y']} – {$b['d']} {$b['m']} {$b['y']}";
}

/** One line, short enough for a preview card, cut on a word where possible. */
function ogTrim(?string $value, int $max = 200): string
{
    $s = trim(preg_replace('/\s+/u', ' ', strip_tags((string) $value)));
    if ($s === '' || mb_strlen($s) <= $max) return $s;
    $cut = mb_substr($s, 0, $max - 1);
    $sp  = mb_strrpos($cut, ' ');
    if ($sp !== false && $sp > $max * 0.6) $cut = mb_substr($cut, 0, $sp);
    return $cut . '…';
}

/**
 * Where a public file actually sits on disk. On Hostinger the built site and the
 * API share one document root; locally the API runs from backend/ and the public
 * files are still in the frontend's folder. Both are tried so the preview only
 * ever advertises an image that exists — a broken og:image is worse than a
 * plainer one, because the platform caches the failure.
 */
function ogPublicFile(string $path): ?string
{
    $roots = array_filter([
        $_SERVER['DOCUMENT_ROOT'] ?? null,
        __DIR__ . '/../..',                 // public_html/, when api/ sits inside it
        __DIR__ . '/../../frontend/public', // local checkout
    ]);
    foreach ($roots as $root) {
        $base = realpath((string) $root);
        $candidate = realpath(rtrim((string) $root, '/\\') . '/' . ltrim($path, '/'));
        if ($base && $candidate && str_starts_with($candidate, $base . DIRECTORY_SEPARATOR) && is_file($candidate)) return $candidate;
    }
    return null;
}

/** The preview image for a path: the caller's own, else the sanctum photo, else the app icon. */
function ogImage(?string $preferred): array
{
    $safe = liveSafeUrl($preferred);
    if ($safe !== null && str_starts_with(strtolower($safe), 'https://')) {
        return ['url' => $safe, 'width' => null, 'height' => null];
    }
    $candidates = array_filter([$safe, '/images/deities-alankaram.jpg', '/icons/icon-512x512.png']);
    foreach ($candidates as $path) {
        $file = ogPublicFile($path);
        if ($file === null) continue;
        $size = @getimagesize($file);
        return [
            'url'    => siteUrl($path),
            'width'  => $size[0] ?? null,
            'height' => $size[1] ?? null,
        ];
    }
    // Nothing on disk. Still name the icon: it ships with every build, and the
    // file may simply be unreadable from this process.
    return ['url' => siteUrl('/icons/icon-512x512.png'), 'width' => null, 'height' => null];
}

/* ── Resolve what this path is about ─────────────────────────────────────── */

$path = ogPath();
$lang = ogLang();
$id   = ogIdentity();
// The site's name as the React app states it: the committee's temple_name
// (migration 025) when set, else the printed one.
$site = ogTempleName($lang);

$title       = '';
$description = '';
$image       = null;
$imageAlt    = $lang === 'en' ? $id['alt_en'] : $id['alt_ta'];
$type        = 'website';
$robots      = '';
$status      = 200;
$streamPath  = false;
$query       = '';    // what the canonical keeps of the query string: the photo, the album, the search
$jsonLd      = null;  // the page's schema.org record, when it has one

try {
    $pages = sitePages();
    $streamPath = str_starts_with($path, '/live-darshan/') && !isset($pages[$path]);

    if ($path === '/gallery' && ($_GET['photo'] ?? '') !== '') {
        // One photograph (brief §6, §22; migration 021): titled with its
        // caption, described by its alternative text in the reader's
        // language, previewed as the original file. A hidden photo, and a
        // photo in a hidden album, preview as the gallery itself.
        [, , $descTa, $descEn] = $pages['/gallery'];
        $other  = $lang === 'en' ? 'ta' : 'en';
        $alt    = galleryHasColumn('alt_ta') && galleryHasColumn('alt_en');
        $albums = galleryAlbumsReady();
        $stmt = getDB()->prepare(
            'SELECT g.id, g.caption, g.filename' . ($alt ? ', g.alt_ta, g.alt_en' : '') . ($albums ? ', a.description_ta AS album_ta, a.description_en AS album_en' : '')
            . ' FROM gallery g' . ($albums ? ' LEFT JOIN gallery_albums a ON a.id = g.album_id' : '')
            . ' WHERE g.id = :id AND g.is_active = 1' . ($albums ? ' AND (g.album_id IS NULL OR a.is_active = 1)' : '')
        );
        $stmt->execute([':id' => (int) $_GET['photo']]);
        $photo = $stmt->fetch();
        $lead  = $lang === 'en' ? $descEn : $descTa;
        if ($photo) {
            $caption  = trim((string) $photo['caption']);
            $altText  = $alt ? (trim((string) $photo['alt_' . $lang]) ?: trim((string) $photo['alt_' . $other])) : '';
            $albumTxt = $albums ? (trim((string) $photo['album_' . $lang]) ?: trim((string) $photo['album_' . $other])) : '';
            $title       = $caption !== '' ? $caption : ($altText !== '' ? $altText : ($lang === 'en' ? 'Gallery' : 'தொகுப்பு'));
            $description = $altText !== '' && $altText !== $title ? $altText : ($albumTxt !== '' ? $albumTxt : $lead);
            $image       = '/uploads/' . $photo['filename'];
            $imageAlt    = $altText !== '' ? $altText : ($caption !== '' ? $caption : $title);
            $query       = '?photo=' . (int) $photo['id'];
        } else {
            $title       = $lang === 'en' ? 'Gallery' : 'தொகுப்பு';
            $description = $lead;
        }
        $type = 'article';
    } elseif ($path === '/gallery' && ($_GET['album'] ?? '') !== '') {
        // One album (migration 021): its title and description in the
        // reader's language, its cover — the committee's pick when that is a
        // shown photo of the album, else the newest shown photo — as the
        // original file. An unknown or hidden album previews as the gallery.
        [, , $descTa, $descEn] = $pages['/gallery'];
        $other = $lang === 'en' ? 'ta' : 'en';
        $key   = is_string($_GET['album']) ? $_GET['album'] : '';
        $album = null;
        if (galleryAlbumsReady() && (preg_match(GALLERY_SLUG_RE, $key) || preg_match('/^[0-9]{1,10}$/D', $key))) {
            $stmt = getDB()->prepare(
                'SELECT id, slug, title_ta, title_en, description_ta, description_en, cover_image_id FROM gallery_albums
                  WHERE ' . (ctype_digit($key) ? 'id = :k' : 'slug = :k') . ' AND is_active = 1'
            );
            $stmt->execute([':k' => $key]);
            $album = $stmt->fetch() ?: null;
        }
        if ($album) {
            $title       = trim((string) $album['title_' . $lang]) ?: trim((string) $album['title_' . $other]);
            $description = trim((string) $album['description_' . $lang]) ?: trim((string) $album['description_' . $other]);
            $description = $description ?: ($lang === 'en' ? $descEn : $descTa);
            $stmt = getDB()->prepare(
                'SELECT filename, caption' . (galleryHasColumn('alt_ta') ? ', alt_ta, alt_en' : '') . ' FROM gallery
                  WHERE album_id = :a AND is_active = 1
                  ORDER BY (id = :c) DESC, created_at DESC, id DESC LIMIT 1'
            );
            $stmt->execute([':a' => (int) $album['id'], ':c' => (int) ($album['cover_image_id'] ?? 0)]);
            $cover = $stmt->fetch();
            if ($cover) {
                $image    = '/uploads/' . $cover['filename'];
                $coverAlt = trim((string) ($cover['alt_' . $lang] ?? '')) ?: trim((string) ($cover['alt_' . $other] ?? ''));
                $imageAlt = $coverAlt ?: (trim((string) $cover['caption']) ?: $title);
            }
            $query = '?album=' . rawurlencode((string) $album['slug']);
        } else {
            $title       = $lang === 'en' ? 'Gallery' : 'தொகுப்பு';
            $description = $lang === 'en' ? $descEn : $descTa;
        }
    } elseif ($path === '/sevas' && ($_GET['seva'] ?? '') !== '') {
        $stmt = getDB()->prepare('SELECT name_ta, name_en, description, amount FROM sevas WHERE id = :id AND is_active = 1');
        $stmt->execute([':id' => (int) $_GET['seva']]);
        $seva = $stmt->fetch();
        [, , $descTa, $descEn] = $pages['/sevas'];
        if ($seva) {
            $title    = $lang === 'en' ? ($seva['name_en'] ?: $seva['name_ta']) : ($seva['name_ta'] ?: $seva['name_en']);
            $offering = $lang === 'en' ? 'Offering' : 'சமர்ப்பணம்';
            // Whole rupees read as whole rupees; paise only when there are any.
            $amount   = (float) $seva['amount'];
            $money    = '₹' . number_format($amount, $amount === floor($amount) ? 0 : 2);
            $description = ogTrim($seva['description']) ?: ($lang === 'en' ? $descEn : $descTa);
            $description = $description . ' · ' . $offering . ' ' . $money;
        } else {
            $title       = $lang === 'en' ? 'Sevas' : 'சேவைகள்';
            $description = $lang === 'en' ? $descEn : $descTa;
        }
        $type = 'article';
    } elseif (preg_match('#^/events/([0-9]{1,10})$#', $path, $m)) {
        // One event's own page (brief §6, migration 020): its title and
        // programme in the reader's language, its date, and its picture when
        // the committee gave it one. A hidden or deleted event is a 404 that
        // says so, never a preview of the events list under a wrong address.
        require_once __DIR__ . '/../includes/public_guard.php';
        $bi   = publicGuardHasColumn('events', 'description_ta') && publicGuardHasColumn('events', 'end_date')
            && publicGuardHasColumn('events', 'image_url') && publicGuardHasColumn('events', 'start_time');
        $stmt = getDB()->prepare('SELECT id, title_ta, title_en, description, event_date'
            . ($bi ? ', description_ta, description_en, end_date, start_time, end_time, image_url' : '')
            . ' FROM events WHERE id = :id AND is_active = 1');
        $stmt->execute([':id' => (int) $m[1]]);
        $event = $stmt->fetch();
        [, , $descTa, $descEn] = $pages['/events'];
        if ($event) {
            $other = $lang === 'en' ? 'ta' : 'en';
            $title = trim((string) $event['title_' . $lang]) ?: trim((string) $event['title_' . $other]);
            $text  = $bi ? (trim((string) $event['description_' . $lang]) ?: trim((string) $event['description_' . $other])) : '';
            $text  = $text ?: trim((string) $event['description']);
            $short = ogTrim($text, 160) ?: ($lang === 'en' ? $descEn : $descTa);
            $description = ogEventDate((string) $event['event_date'], $bi ? $event['end_date'] : null, $lang) . ' · ' . $short;
            if ($bi && !empty($event['image_url'])) {
                $image    = (string) $event['image_url'];
                $imageAlt = $title;
            }
            $type   = 'article';
            $jsonLd = ogEventSchema($event, $lang, $title, $text, siteUrl('/events/' . (int) $event['id']));
        } else {
            $title  = $lang === 'en' ? 'Event not found' : 'நிகழ்வு கிடைக்கவில்லை';
            $robots = 'noindex, nofollow';
            $status = 404;
        }
    } elseif ($streamPath) {
        $key = substr($path, strlen('/live-darshan/'));
        $db = getDB();
        $row = liveTablesExist()
            ? (preg_match('/^[0-9]{1,10}$/', $key) ? liveLoad($db, (int) $key) : liveLoadBySlug($db, $key))
            : null;
        if ($row !== null && in_array($row['status'], LIVE_PUBLIC_STATUSES, true)) {
            $stream = liveShapePublic($row);
            $other = $lang === 'en' ? 'ta' : 'en';
            [, , $descTa, $descEn] = $pages['/live-darshan'];
            $title = trim((string) $stream['title_' . $lang]) ?: trim((string) $stream['title_' . $other]);
            $own   = trim((string) $stream['description_' . $lang]) ?: trim((string) $stream['description_' . $other]);
            $description = $own ?: ($lang === 'en' ? $descEn : $descTa);
            $image = $stream['thumbnail_url'];
            $imageAlt = $title;
            $type = 'video.other';
            $path = '/live-darshan/' . $stream['slug'];
            $jsonLd = ogLiveSchema($stream, $lang, $title, $own, siteUrl($path));
        } else {
            $title = $lang === 'en' ? 'Broadcast not found' : 'ஒளிபரப்பு கிடைக்கவில்லை';
            $description = '';
            $robots = 'noindex, nofollow';
            $status = 404;
        }
    } elseif (isset($pages[$path])) {
        [$titleTa, $titleEn, $descTa, $descEn] = $pages[$path];
        $title       = $lang === 'en' ? $titleEn : $titleTa;
        $description = $lang === 'en' ? $descEn : $descTa;
        if ($path === '/') {
            // The front page describes itself with the committee's hero lead
            // (Admin → System → Settings, migration 025) when they wrote one,
            // exactly as pages/Home.jsx passes it to <Seo>.
            $lead = siteSetting('hero_lead', $lang);
            if (is_string($lead) && trim($lead) !== '') $description = trim($lead);
        }
        // A results list is not a destination, but its links are worth following.
        if ($path === '/search') {
            $robots = 'noindex, follow';
            $q      = ogTrim($_GET['q'] ?? '', 80);
            if ($q !== '') $title = $title . ': ' . $q;
            if (($_GET['q'] ?? '') !== '') $query = '?q=' . urlencode((string) $_GET['q']);
        }
    } else {
        // An address that is not part of the site. React answers it with its own
        // not-found page, and this says the same thing rather than pretending.
        $title  = $lang === 'en' ? 'Page Not Found' : 'பக்கம் கிடைக்கவில்லை';
        $robots = 'noindex, nofollow';
        $status = 404;
    }
} catch (Throwable $e) {
    // A database that is down must not cost the temple its preview.
    error_log('[og] ' . get_class($e) . ': ' . liveRedact($e->getMessage()));
    $jsonLd = null;
    if ($streamPath) {
        $title = $lang === 'en' ? 'Live Darshan' : 'நேரடி தரிசனம்';
        $robots = 'noindex, nofollow';
        $status = 503;
    }
    if ($title === '' && isset($pages[$path])) {
        [$titleTa, $titleEn] = $pages[$path];
        $title = $lang === 'en' ? $titleEn : $titleTa;
    }
}

// Committee overrides (Admin → System → SEO, migration 025) for this exact
// address: each of title, description and image replaces the built-in value
// only when given, and "keep out of search engines" adds the robots directive.
if ($status === 200) {
    try {
        $seo = siteSeoOverrides()[$path] ?? null;
        if ($seo !== null) {
            $other = $lang === 'en' ? 'ta' : 'en';
            $ovTitle = trim((string) ($seo['title_' . $lang] ?? '')) ?: trim((string) ($seo['title_' . $other] ?? ''));
            $ovDesc  = trim((string) ($seo['description_' . $lang] ?? '')) ?: trim((string) ($seo['description_' . $other] ?? ''));
            if ($ovTitle !== '') $title = $ovTitle;
            if ($ovDesc !== '') $description = $ovDesc;
            if (!empty($seo['og_image'])) { $image = (string) $seo['og_image']; $imageAlt = $title; }
            if (!empty($seo['noindex'])) $robots = 'noindex, nofollow';
        }
    } catch (Throwable) {
        // an override is never worth failing the preview for
    }
}

$canonical   = siteUrl($path) . $query;
$preview     = ogImage($image);
$docTitle    = $title === '' ? $site : $title . ' — ' . $site;
$description = $streamPath ? mb_substr(preg_replace('/\s+/u', ' ', trim($description)), 0, 200) : ogTrim($description);
$h           = static fn(?string $v): string => htmlspecialchars((string) $v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');

// The front page's record is built last: it carries the description and the
// picture the preview settled on, overrides included.
if ($path === '/' && $status === 200) {
    try {
        $jsonLd = ogTempleSchema($lang, $preview['url'], $description);
    } catch (Throwable $e) {
        error_log('[og] temple record: ' . get_class($e) . ': ' . liveRedact($e->getMessage()));
        $jsonLd = null;
    }
}

http_response_code($status);
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: ' . ($streamPath ? ($status === 200 ? 'public, max-age=60' : 'no-store, private') : 'public, max-age=300'));
header('Vary: Accept-Language, User-Agent');
if ($status === 503) header('Retry-After: 60');
?>
<!doctype html>
<html lang="<?= $lang === 'en' ? 'en' : 'ta' ?>">
<head>
<meta charset="utf-8">
<title><?= $h($docTitle) ?></title>
<?php if ($description !== ''): ?>
<meta name="description" content="<?= $h($description) ?>">
<?php endif; ?>
<?php if ($robots !== ''): ?>
<meta name="robots" content="<?= $h($robots) ?>">
<?php endif; ?>
<link rel="canonical" href="<?= $h($canonical) ?>">

<meta property="og:type" content="<?= $h($type) ?>">
<meta property="og:site_name" content="<?= $h($site) ?>">
<meta property="og:locale" content="<?= $lang === 'en' ? 'en_IN' : 'ta_IN' ?>">
<meta property="og:title" content="<?= $h($title === '' ? $site : $title) ?>">
<?php if ($description !== ''): ?>
<meta property="og:description" content="<?= $h($description) ?>">
<?php endif; ?>
<meta property="og:url" content="<?= $h($canonical) ?>">
<meta property="og:image" content="<?= $h($preview['url']) ?>">
<?php if ($preview['width'] && $preview['height']): ?>
<meta property="og:image:width" content="<?= (int) $preview['width'] ?>">
<meta property="og:image:height" content="<?= (int) $preview['height'] ?>">
<?php endif; ?>
<meta property="og:image:alt" content="<?= $h($imageAlt) ?>">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="<?= $h($title === '' ? $site : $title) ?>">
<?php if ($description !== ''): ?>
<meta name="twitter:description" content="<?= $h($description) ?>">
<?php endif; ?>
<meta name="twitter:image" content="<?= $h($preview['url']) ?>">
<meta name="twitter:image:alt" content="<?= $h($imageAlt) ?>">
<?php if ($jsonLd !== null && $status === 200): ?>
<script type="application/ld+json"><?= ogJsonLd($jsonLd) ?></script>
<?php endif; ?>
</head>
<body>
<h1><?= $h($title === '' ? $site : $title) ?></h1>
<?php if ($description !== ''): ?>
<p><?= $h($description) ?></p>
<?php endif; ?>
<p><a href="<?= $h($canonical) ?>"><?= $h($lang === 'en' ? 'Continue to the temple website' : 'கோயில் இணையதளத்திற்குச் செல்ல') ?></a></p>
<script>
/* A person who opened this endpoint directly should end up on the real page.
   Guarded on the address bar: when Apache routed a crawler here internally the
   browser is already at the real path, and redirecting would only fetch it
   again. */
(function () {
  if (location.pathname.indexOf("/api/og.php") === 0 || location.pathname.indexOf("/og.php") === 0) {
    location.replace(<?= json_encode($canonical, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>);
  }
})();
</script>
</body>
</html>
