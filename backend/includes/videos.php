<?php
// backend/includes/videos.php — shared pieces of the Videos module (migration
// 017): table check, YouTube id parsing (borrowed from the live provider so
// both accept the same links) and the public shape of a row.

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/live/providers.php';

/** True once migration 017 has been applied. */
function videoTablesExist(): bool
{
    static $exists = null;
    if ($exists !== null) return $exists;
    try {
        $db = getDB();
        $db->query('SELECT 1 FROM videos LIMIT 0')->closeCursor();
        $db->query('SELECT 1 FROM video_categories LIMIT 0')->closeCursor();
        return $exists = true;
    } catch (Throwable $e) {
        error_log('[videos] tables unavailable (apply database/migrations/017_videos.sql): ' . $e->getMessage());
        return $exists = false;
    }
}

/** True when live_streams exists (migration 011), so a video can name the broadcast it recorded. */
function videoStreamsTableExists(): bool
{
    static $ok = null;
    if ($ok !== null) return $ok;
    try {
        getDB()->query('SELECT 1 FROM live_streams LIMIT 0')->closeCursor();
        return $ok = true;
    } catch (Throwable $e) {
        return $ok = false;
    }
}

/** The 11-character id from a bare id or any YouTube link, or null. */
function videoYoutubeId(mixed $input): ?string
{
    return liveYoutubeId($input);
}

/** Slug for a category from its English name: lowercase words joined by "-", 2–60 chars. */
function videoCategorySlug(string $nameEn): string
{
    $s = strtolower(trim($nameEn));
    $s = preg_replace('/[^a-z0-9]+/', '-', $s) ?? '';
    $s = trim(preg_replace('/-{2,}/', '-', $s) ?? '', '-');
    if (strlen($s) > 60) $s = rtrim(substr($s, 0, 60), '-');
    return strlen($s) >= 2 ? $s : 'videos';
}

/** Public JSON for one video row (joined with its category). Nothing private lives on a video. */
function videoPublicRow(array $r): array
{
    $id = (string) $r['youtube_id'];
    $text = static fn($v): ?string => $v !== null && $v !== '' ? (string) $v : null;
    return [
        'id'             => (int) $r['id'],
        'youtube_id'     => $id,
        'title_ta'       => (string) $r['title_ta'],
        'title_en'       => (string) $r['title_en'],
        'description_ta' => $text($r['description_ta'] ?? null),
        'description_en' => $text($r['description_en'] ?? null),
        'published_on'   => $text($r['published_on'] ?? null),
        'is_featured'    => (bool) $r['is_featured'],
        'category'       => isset($r['category_slug']) && $r['category_slug'] !== null ? [
            'slug'    => (string) $r['category_slug'],
            'name_ta' => (string) $r['category_name_ta'],
            'name_en' => (string) $r['category_name_en'],
        ] : null,
        'live_stream_slug' => $text($r['live_stream_slug'] ?? null),
        'embed_url'      => liveYoutubeEmbedUrl($id),
        'watch_url'      => liveYoutubeWatchUrl($id),
        'thumbnail_url'  => liveYoutubeThumbnailUrl($id),
    ];
}
