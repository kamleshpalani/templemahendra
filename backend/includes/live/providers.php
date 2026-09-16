<?php
/**
 * backend/includes/live/providers.php — the seam between a stream row and the
 * service that carries the video (docs/live/SPEC-PHASE1.md §4.1, PHASE0 §5.2).
 *
 * The public API never exposes provider specifics: a provider turns a row into
 * a playback descriptor
 *   ['kind' => 'iframe' | 'link' | 'none', 'embedUrl' => ?string, 'watchUrl' => ?string]
 * and the React player only knows those three kinds.
 *
 * Phase 1 makes no network call. YouTubeProvider builds the embed, watch and
 * thumbnail addresses from the validated 11-character video id; fetchStatus()
 * answers "not configured" until Phase 3 adds the Data API client. Vimeo, AWS
 * IVS and the custom URL are listed so the admin can see them, but are not
 * available yet.
 */

interface StreamingProvider
{
    /** The provider key as stored: youtube, vimeo, aws_ivs, custom. */
    public function name(): string;

    /** The provider's name for people, in a language: "YouTube" (a brand reads the same in Tamil). */
    public function label(string $lang = 'en'): string;

    /** True when this provider can be used for a live stream in this phase. */
    public function isConfigured(): bool;

    /**
     * The provider's own id from what the admin pasted (a bare id or any link
     * form the provider publishes), or null when it is not one.
     */
    public function parseReference(string $input): ?string;

    /**
     * How the public page plays this stream, from the row alone (no network).
     * @return array{kind: string, embedUrl: ?string, watchUrl: ?string}
     */
    public function playback(array $stream): array;

    /** The poster to show: the admin's thumbnail_url, else the provider's default, else null. */
    public function thumbnailUrl(array $stream): ?string;

    /**
     * Phase 3: ask the provider what the broadcast is doing. Phase 1 answers
     * ['ok' => false, 'error' => 'not configured'] and never touches the network.
     * @return array{ok: bool, error?: string}
     */
    public function fetchStatus(array $stream): array;
}

/* ── YouTube ─────────────────────────────────────────────────────────────── */

/** An 11-character YouTube video id. */
const LIVE_YT_ID_RE = '/^[A-Za-z0-9_-]{11}$/';

/**
 * Every link form YouTube publishes for one video: watch?v= (in any query
 * position), youtu.be/, /live/, /embed/, /shorts/, /v/, /e/, on youtube.com,
 * youtube-nocookie.com, with or without www./m./music. and the scheme.
 */
const LIVE_YT_URL_RE = '~^(?:https?://)?(?:(?:www|m|music)\.)?(?:youtube(?:-nocookie)?\.com/(?:watch\?(?:[^#]*&)?v=|(?:embed|live|shorts|v|e)/)|youtu\.be/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])~i';

/** The video id in a pasted id or link, or null. "live_stream" (the channel embed) is not a video. */
function liveYoutubeId(mixed $input): ?string
{
    if (!is_string($input)) return null;
    $s = trim($input);
    if ($s === '' || strlen($s) > 500) return null;
    if (preg_match(LIVE_YT_ID_RE, $s)) return $s === 'live_stream' ? null : $s;
    if (!preg_match(LIVE_YT_URL_RE, $s, $m)) return null;
    return $m[1] === 'live_stream' ? null : $m[1];
}

/** The privacy-enhanced embed address; the frontend appends &hl=ta|en. */
function liveYoutubeEmbedUrl(string $id): string
{
    return 'https://www.youtube-nocookie.com/embed/' . rawurlencode($id) . '?rel=0&playsinline=1';
}

function liveYoutubeWatchUrl(string $id): string
{
    return 'https://www.youtube.com/watch?v=' . rawurlencode($id);
}

/** hqdefault exists for every video; maxresdefault does not (research §2). */
function liveYoutubeThumbnailUrl(string $id): string
{
    return 'https://i.ytimg.com/vi/' . rawurlencode($id) . '/hqdefault.jpg';
}

final class YouTubeProvider implements StreamingProvider
{
    public function name(): string { return 'youtube'; }
    public function label(string $lang = 'en'): string { return 'YouTube'; }

    /** Manual mode needs no key: the admin pastes the video id. */
    public function isConfigured(): bool { return true; }

    public function parseReference(string $input): ?string
    {
        return liveYoutubeId($input);
    }

    public function playback(array $stream): array
    {
        $id = (string) ($stream['provider_broadcast_id'] ?? '');
        if (!preg_match(LIVE_YT_ID_RE, $id) || $id === 'live_stream') {
            return ['kind' => 'none', 'embedUrl' => null, 'watchUrl' => null];
        }
        $override = liveSafeUrl($stream['playback_url'] ?? null);
        $watch = $override !== null && stripos($override, 'https://') === 0 ? $override : liveYoutubeWatchUrl($id);
        return ['kind' => 'iframe', 'embedUrl' => liveYoutubeEmbedUrl($id), 'watchUrl' => $watch];
    }

    public function thumbnailUrl(array $stream): ?string
    {
        $own = liveSafeUrl($stream['thumbnail_url'] ?? null);
        if ($own !== null) return $own;
        $id = (string) ($stream['provider_broadcast_id'] ?? '');
        return preg_match(LIVE_YT_ID_RE, $id) && $id !== 'live_stream' ? liveYoutubeThumbnailUrl($id) : null;
    }

    public function fetchStatus(array $stream): array
    {
        return ['ok' => false, 'error' => 'not configured'];
    }
}

/* ── Named placeholders (docs/live/SPEC-PHASE2.md §1.2) ─────────────────── */

/**
 * The slots a later phase fills in. Neither is configured, neither can be
 * chosen in the admin yet (LIVE_SAVABLE_PROVIDERS), and neither plays
 * anything; each only recognises the shape of its own reference so a row
 * carrying one is stored intact for the day the client arrives.
 */

/** A Vimeo video or event id: digits alone, or inside any vimeo.com link. */
const LIVE_VIMEO_ID_RE  = '/^[0-9]{5,12}$/';
const LIVE_VIMEO_URL_RE = '~^(?:https?://)?(?:www\.|player\.)?vimeo\.com/(?:event/|video/|channels/[a-z0-9_-]+/|groups/[a-z0-9_-]+/videos/)?([0-9]{5,12})(?![0-9])~i';

final class VimeoProvider implements StreamingProvider
{
    public function name(): string { return 'vimeo'; }
    public function label(string $lang = 'en'): string { return 'Vimeo'; }
    public function isConfigured(): bool { return false; }

    public function parseReference(string $input): ?string
    {
        $s = trim($input);
        if ($s === '' || strlen($s) > 500) return null;
        if (preg_match(LIVE_VIMEO_ID_RE, $s)) return $s;
        return preg_match(LIVE_VIMEO_URL_RE, $s, $m) ? $m[1] : null;
    }

    public function playback(array $stream): array
    {
        return ['kind' => 'none', 'embedUrl' => null, 'watchUrl' => null];
    }

    public function thumbnailUrl(array $stream): ?string
    {
        return liveSafeUrl($stream['thumbnail_url'] ?? null);
    }

    public function fetchStatus(array $stream): array
    {
        return ['ok' => false, 'error' => 'not configured'];
    }
}

/** An IVS channel ARN, or the https playback address of an HLS (.m3u8) stream. */
const LIVE_IVS_ARN_RE  = '/^arn:aws:ivs:[a-z]{2}-[a-z]+-[0-9]:[0-9]{12}:channel\/[A-Za-z0-9]{6,32}$/';
const LIVE_IVS_HLS_RE  = '~^https://[a-z0-9.-]+(?::[0-9]{2,5})?/[^\s?#]*\.m3u8(?:\?[^\s#]*)?$~i';

final class AwsIvsProvider implements StreamingProvider
{
    public function name(): string { return 'aws_ivs'; }
    public function label(string $lang = 'en'): string { return 'AWS IVS'; }
    public function isConfigured(): bool { return false; }

    /** The reference must fit the stored column (100 characters); a longer address is refused. */
    public function parseReference(string $input): ?string
    {
        $s = trim($input);
        if ($s === '' || strlen($s) > 100) return null;
        if (preg_match(LIVE_IVS_ARN_RE, $s)) return $s;
        if (preg_match(LIVE_IVS_HLS_RE, $s) && liveSafeUrl($s) !== null) return $s;
        return null;
    }

    public function playback(array $stream): array
    {
        return ['kind' => 'none', 'embedUrl' => null, 'watchUrl' => null];
    }

    public function thumbnailUrl(array $stream): ?string
    {
        return liveSafeUrl($stream['thumbnail_url'] ?? null);
    }

    public function fetchStatus(array $stream): array
    {
        return ['ok' => false, 'error' => 'not configured'];
    }
}

/* ── The custom URL and unknown keys ─────────────────────────────────────── */

/**
 * The custom URL provider, and what an unknown key resolves to: listed, never
 * configured. The custom provider keeps the pasted reference (≤ 100
 * characters) and plays as a plain link to its playback_url; anything else
 * plays nothing.
 */
final class UnavailableProvider implements StreamingProvider
{
    public function __construct(private string $key, private string $title)
    {
    }

    public function name(): string { return $this->key; }
    public function label(string $lang = 'en'): string { return $this->title; }
    public function isConfigured(): bool { return false; }

    public function parseReference(string $input): ?string
    {
        if ($this->key !== 'custom') return null;
        $s = trim($input);
        if ($s === '' || mb_strlen($s) > 100) return null;
        if (preg_match('/[\x00-\x1F\x7F]/', $s)) return null;
        return $s;
    }

    public function playback(array $stream): array
    {
        if ($this->key === 'custom') {
            $url = liveSafeUrl($stream['playback_url'] ?? null);
            if ($url !== null) return ['kind' => 'link', 'embedUrl' => null, 'watchUrl' => $url];
        }
        return ['kind' => 'none', 'embedUrl' => null, 'watchUrl' => null];
    }

    public function thumbnailUrl(array $stream): ?string
    {
        return liveSafeUrl($stream['thumbnail_url'] ?? null);
    }

    public function fetchStatus(array $stream): array
    {
        return ['ok' => false, 'error' => 'not configured'];
    }
}

/* ── Registry ────────────────────────────────────────────────────────────── */

/** key => StreamingProvider, one instance per provider per request, in LIVE_PROVIDERS order: youtube, vimeo, aws_ivs, custom. */
function liveProviderRegistry(): array
{
    static $registry = null;
    if ($registry !== null) return $registry;
    $registry = [];
    foreach (LIVE_PROVIDERS as $key => $label) {
        $registry[$key] = match ($key) {
            'youtube' => new YouTubeProvider(),
            'vimeo'   => new VimeoProvider(),
            'aws_ivs' => new AwsIvsProvider(),
            default   => new UnavailableProvider($key, $label),
        };
    }
    return $registry;
}

/** The provider for a stored key. Never throws: an unknown key is an unavailable provider. */
function liveProviderFor(string $name): StreamingProvider
{
    $key = strtolower(trim($name));
    return liveProviderRegistry()[$key] ?? new UnavailableProvider($key !== '' ? $key : 'unknown', 'Unknown provider');
}
