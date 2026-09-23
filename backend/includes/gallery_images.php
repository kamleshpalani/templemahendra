<?php
// backend/includes/gallery_images.php — shared pieces of the photo gallery
// (migration 021): schema checks, image decoding and the thumbnail / medium
// variants made with GD, safe deletion of a photo's files, album slugs and
// the public JSON shape of a photo and an album.
//
// Sizes (brief §34): the grid asks for `thumb` (GALLERY_THUMB_WIDTH wide) and
// the lightbox for `medium` (GALLERY_MEDIUM_WIDTH wide). A variant is never
// upscaled: a source narrower than the target is re-encoded at its own size.
// WebP is written when this PHP's GD can (every PHP 8 build on Hostinger and
// the portable dev PHP can); otherwise JPEG at quality 82.

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';

const GALLERY_THUMB_WIDTH  = 480;
const GALLERY_MEDIUM_WIDTH = 1280;
const GALLERY_JPEG_QUALITY = 82;
const GALLERY_WEBP_QUALITY = 80;

/** A stored gallery file name: 24 hex characters, an optional variant tag, a known extension. */
const GALLERY_FILE_RE = '/^[a-f0-9]{24}(?:-(?:thumb|medium))?\.(?:jpg|png|webp)$/D';

/** Slug shape for /gallery?album=<slug> (the same alphabet as video categories). */
const GALLERY_SLUG_RE = '/^[a-z0-9][a-z0-9-]{1,59}$/D';

/** True when `gallery` has $column — false on a database without migration 021. */
function galleryHasColumn(string $column): bool
{
    static $cache = [];
    if (isset($cache[$column])) return $cache[$column];
    try {
        $stmt = getDB()->prepare(
            'SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?'
        );
        $stmt->execute(['gallery', $column]);
        return $cache[$column] = (int) $stmt->fetchColumn() > 0;
    } catch (Throwable $e) {
        error_log('[gallery] column check failed: ' . $e->getMessage());
        return $cache[$column] = false;
    }
}

/** True once migration 021 has been applied (the albums table and the album column both exist). */
function galleryAlbumsReady(): bool
{
    static $ready = null;
    if ($ready !== null) return $ready;
    try {
        getDB()->query('SELECT 1 FROM gallery_albums LIMIT 0')->closeCursor();
        return $ready = galleryHasColumn('album_id');
    } catch (Throwable $e) {
        error_log('[gallery] albums unavailable (apply database/migrations/021_gallery_albums.sql): ' . $e->getMessage());
        return $ready = false;
    }
}

/**
 * Decode an uploaded image and say what it is. Type, size and the stored
 * extension come from the bytes, never from the client's file name or MIME.
 *
 * @return array{type:int, ext:string, width:int, height:int}|null  null when not a JPEG, PNG or WebP
 */
function galleryDecodeImage(string $path): ?array
{
    $info = @getimagesize($path);
    if (!$info || empty($info[0]) || empty($info[1])) return null;
    $ext = [IMAGETYPE_JPEG => 'jpg', IMAGETYPE_PNG => 'png', IMAGETYPE_WEBP => 'webp'][$info[2] ?? 0] ?? null;
    if ($ext === null) return null;
    return ['type' => (int) $info[2], 'ext' => $ext, 'width' => (int) $info[0], 'height' => (int) $info[1]];
}

/** True when this PHP's GD can read the given IMAGETYPE_* and write the variants. */
function galleryCanResize(int $type): bool
{
    if (!function_exists('imagecreatetruecolor') || !function_exists('imagescale')) return false;
    return match ($type) {
        IMAGETYPE_JPEG => function_exists('imagecreatefromjpeg'),
        IMAGETYPE_PNG  => function_exists('imagecreatefrompng'),
        IMAGETYPE_WEBP => function_exists('imagecreatefromwebp'),
        default        => false,
    } && (function_exists('imagewebp') || function_exists('imagejpeg'));
}

/**
 * Load an image into GD as truecolor with alpha kept, rotated the way the
 * camera meant it when the JPEG carries an EXIF orientation. Returns null when
 * GD cannot decode it (a truncated file, or one too large for memory).
 */
function galleryLoadImage(string $path, int $type): ?GdImage
{
    $im = match ($type) {
        IMAGETYPE_JPEG => @imagecreatefromjpeg($path),
        IMAGETYPE_PNG  => @imagecreatefrompng($path),
        IMAGETYPE_WEBP => @imagecreatefromwebp($path),
        default        => false,
    };
    if (!$im instanceof GdImage) return null;

    if (!imageistruecolor($im)) imagepalettetotruecolor($im);
    imagealphablending($im, false);
    imagesavealpha($im, true);

    if ($type === IMAGETYPE_JPEG && function_exists('exif_read_data')) {
        $exif = @exif_read_data($path);
        $orientation = (int) ($exif['Orientation'] ?? 1);
        $angle = [3 => 180, 6 => -90, 8 => 90][$orientation] ?? 0;
        if ($angle !== 0) {
            $rotated = imagerotate($im, $angle, 0);
            if ($rotated instanceof GdImage) {
                imagedestroy($im);
                $im = $rotated;
            }
        }
    }
    return $im;
}

/**
 * Write one scaled copy of $src no wider than $maxWidth. Returns
 * ['filename' => …, 'width' => …, 'height' => …] or null when nothing was written.
 * The file is named "<stem>-<tag>.webp" (or .jpg on a GD without WebP).
 */
function galleryWriteVariant(GdImage $src, string $stem, string $tag, int $maxWidth): ?array
{
    $w = imagesx($src);
    $h = imagesy($src);
    if ($w < 1 || $h < 1) return null;

    $targetW = min($maxWidth, $w);
    $targetH = max(1, (int) round($h * $targetW / $w));
    $scaled  = $targetW === $w ? $src : imagescale($src, $targetW, $targetH, IMG_BICUBIC);
    if (!$scaled instanceof GdImage) return null;
    imagealphablending($scaled, false);
    imagesavealpha($scaled, true);

    $webp = function_exists('imagewebp');
    $ext  = $webp ? 'webp' : 'jpg';
    $name = $stem . '-' . $tag . '.' . $ext;
    $path = UPLOAD_DIR . $name;

    if ($webp) {
        $ok = @imagewebp($scaled, $path, GALLERY_WEBP_QUALITY);
    } else {
        // JPEG has no alpha: lay the picture over white so transparent PNGs
        // do not come out black.
        $flat = imagecreatetruecolor($targetW, $targetH);
        imagefill($flat, 0, 0, imagecolorallocate($flat, 255, 255, 255));
        imagecopy($flat, $scaled, 0, 0, 0, 0, $targetW, $targetH);
        $ok = @imagejpeg($flat, $path, GALLERY_JPEG_QUALITY);
        imagedestroy($flat);
    }
    if ($scaled !== $src) imagedestroy($scaled);

    if (!$ok || !is_file($path)) {
        @unlink($path);
        return null;
    }
    return ['filename' => $name, 'width' => $targetW, 'height' => $targetH];
}

/**
 * Make the thumb and medium variants of an original already stored in
 * UPLOAD_DIR under $filename (a name from galleryDecodeImage's extension and
 * random bytes, so $stem is 24 hex characters). Never throws: a photo whose
 * variants cannot be made is still a photo, and the API falls back to the
 * original. Returns ['thumb' => ?array, 'medium' => ?array].
 */
function galleryMakeVariants(string $filename, int $type): array
{
    $out  = ['thumb' => null, 'medium' => null];
    $stem = pathinfo($filename, PATHINFO_FILENAME);
    if (!preg_match('/^[a-f0-9]{24}$/D', $stem) || !galleryCanResize($type)) return $out;

    // A 5 MB JPEG can be 24 megapixels, which GD holds uncompressed; give the
    // resize the room it needs rather than dying with a white page.
    $limit = ini_get('memory_limit');
    if ($limit !== false && $limit !== '-1' && (int) $limit < 512 && (int) $limit > 0) {
        @ini_set('memory_limit', '512M');
    }

    try {
        $src = galleryLoadImage(UPLOAD_DIR . $filename, $type);
        if ($src === null) return $out;
        $out['medium'] = galleryWriteVariant($src, $stem, 'medium', GALLERY_MEDIUM_WIDTH);
        $out['thumb']  = galleryWriteVariant($src, $stem, 'thumb', GALLERY_THUMB_WIDTH);
        imagedestroy($src);
    } catch (Throwable $e) {
        error_log('[gallery] variants for ' . $filename . ' failed: ' . $e->getMessage());
    }
    return $out;
}

/** Remove the original and both variants of a gallery row from UPLOAD_DIR. Only names in our own shape are touched. */
function galleryDeleteFiles(array $row): void
{
    foreach (['filename', 'thumb_filename', 'medium_filename'] as $key) {
        $name = (string) ($row[$key] ?? '');
        if ($name === '' || $name !== basename($name) || str_contains($name, '..')) continue;
        $path = UPLOAD_DIR . $name;
        if (is_file($path)) @unlink($path);
    }
}

/** Slug for an album from its English title: lowercase words joined by "-", 2–60 chars. */
function galleryAlbumSlug(string $titleEn): string
{
    $s = strtolower(trim($titleEn));
    $s = preg_replace('/[^a-z0-9]+/', '-', $s) ?? '';
    $s = trim(preg_replace('/-{2,}/', '-', $s) ?? '', '-');
    if (strlen($s) > 60) $s = rtrim(substr($s, 0, 60), '-');
    return strlen($s) >= 2 ? $s : 'album';
}

/** An album slug nobody else uses; "-2", "-3"… on a clash. */
function galleryAlbumSlugFree(PDO $db, string $titleEn, ?int $exceptId = null): string
{
    $base = substr(galleryAlbumSlug($titleEn), 0, 56);
    $stmt = $db->prepare('SELECT id FROM gallery_albums WHERE slug = :s' . ($exceptId ? ' AND id <> :e' : ''));
    for ($n = 1; $n < 100; $n++) {
        $slug   = $n === 1 ? $base : $base . '-' . $n;
        $params = [':s' => $slug];
        if ($exceptId) $params[':e'] = $exceptId;
        $stmt->execute($params);
        if (!$stmt->fetch()) return $slug;
    }
    return $base . '-' . bin2hex(random_bytes(2));
}

/** '/uploads/<name>' for a stored file name, or null. */
function galleryFileUrl(?string $name): ?string
{
    return $name !== null && $name !== '' ? '/uploads/' . $name : null;
}

/**
 * Public JSON for one gallery row. The keys the first release sent (id,
 * filename, caption, created_at) are kept for old clients; everything else
 * is null on a database without migration 021 or a row uploaded before it,
 * and the thumb / medium URLs then fall back to the original file.
 */
function galleryPublicRow(array $r): array
{
    $text = static fn($v): ?string => $v !== null && $v !== '' ? (string) $v : null;
    $int  = static fn($v): ?int => $v !== null && $v !== '' ? (int) $v : null;
    $url  = galleryFileUrl((string) $r['filename']);
    $w    = $int($r['width'] ?? null);
    $h    = $int($r['height'] ?? null);
    $thumb  = galleryFileUrl($text($r['thumb_filename'] ?? null));
    $medium = galleryFileUrl($text($r['medium_filename'] ?? null));
    // Variant widths follow the "never upscaled" rule, so they can be stated
    // from the original's width without another column.
    $thumbW  = $thumb !== null && $w !== null ? min(GALLERY_THUMB_WIDTH, $w) : $w;
    $mediumW = $medium !== null && $w !== null ? min(GALLERY_MEDIUM_WIDTH, $w) : $w;
    return [
        'id'           => (int) $r['id'],
        'filename'     => (string) $r['filename'],
        'caption'      => $r['caption'] ?? null,
        'created_at'   => $r['created_at'] ?? null,
        'album_id'     => $int($r['album_id'] ?? null),
        'album_slug'   => $text($r['album_slug'] ?? null),
        'alt_ta'       => $text($r['alt_ta'] ?? null),
        'alt_en'       => $text($r['alt_en'] ?? null),
        'url'          => $url,
        'thumb_url'    => $thumb ?? $url,
        'medium_url'   => $medium ?? $url,
        'width'        => $w,
        'height'       => $h,
        'thumb_width'  => $thumbW,
        'medium_width' => $mediumW,
    ];
}

/**
 * Public JSON for one album row joined with its photo count and cover photo
 * (columns n, cover_filename, cover_thumb, cover_alt_ta, cover_alt_en,
 * cover_caption, cover_width, cover_height from the API's query).
 */
function galleryAlbumPublicRow(array $a): array
{
    $text  = static fn($v): ?string => $v !== null && $v !== '' ? (string) $v : null;
    $cover = null;
    if (!empty($a['cover_filename'])) {
        $orig = galleryFileUrl((string) $a['cover_filename']);
        $cover = [
            'id'        => (int) $a['cover_id'],
            'thumb_url' => galleryFileUrl($text($a['cover_thumb'] ?? null)) ?? $orig,
            'alt_ta'    => $text($a['cover_alt_ta'] ?? null),
            'alt_en'    => $text($a['cover_alt_en'] ?? null),
            'caption'   => $text($a['cover_caption'] ?? null),
            'width'     => isset($a['cover_width']) && $a['cover_width'] !== null ? (int) $a['cover_width'] : null,
            'height'    => isset($a['cover_height']) && $a['cover_height'] !== null ? (int) $a['cover_height'] : null,
        ];
    }
    return [
        'id'             => (int) $a['id'],
        'slug'           => (string) $a['slug'],
        'title_ta'       => (string) $a['title_ta'],
        'title_en'       => (string) $a['title_en'],
        'description_ta' => $text($a['description_ta'] ?? null),
        'description_en' => $text($a['description_en'] ?? null),
        'event_id'       => isset($a['event_id']) && $a['event_id'] !== null ? (int) $a['event_id'] : null,
        'count'          => (int) ($a['n'] ?? 0),
        'cover'          => $cover,
    ];
}
