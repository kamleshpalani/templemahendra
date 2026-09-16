<?php
/**
 * backend/includes/live/media.php — thumbnails and banners: uploaded files and
 * pasted links (docs/live/SPEC-PHASE1.md §4.1).
 *
 * The upload path is the gallery's (backend/admin/gallery.php): the size is
 * checked against UPLOAD_MAX_MB, the type comes from decoding the image with
 * getimagesize() — never from the client's MIME type or filename — the stored
 * name is random with a "live-" prefix, and the file lands in UPLOAD_DIR to be
 * served at /uploads/<name>. A pasted link is accepted only as a site path or
 * an https URL (the notification service's rule), so nothing stored here can
 * ever be a javascript: or http: address.
 */

/** The only upload names this module creates or removes. */
const LIVE_UPLOAD_RE = '#^/uploads/(live-[0-9a-f]{24}\.(?:jpg|png|webp))$#';

/**
 * Store one uploaded image from $_FILES[$field]. Returns
 *   ['ok' => true,  'url' => '/uploads/live-<24 hex>.<jpg|png|webp>', 'error' => null] or
 *   ['ok' => false, 'url' => null, 'error' => 'why'].
 * A missing file (UPLOAD_ERR_NO_FILE) is not an error: ok = false with error
 * null, so a form that leaves the field empty keeps its URL field instead.
 *
 * @param array  $file  one entry of $_FILES
 * @param string $field the field's name for messages ("thumbnail", "banner")
 * @return array{ok: bool, url: ?string, error: ?string}
 */
function liveStoreImage(array $file, string $field): array
{
    $label = $field !== '' ? $field : 'image';
    $err   = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);
    if ($err === UPLOAD_ERR_NO_FILE) return ['ok' => false, 'url' => null, 'error' => null];
    if ($err !== UPLOAD_ERR_OK) {
        $why = match ($err) {
            UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => 'That ' . $label . ' is larger than the server upload limit (' . (string) ini_get('upload_max_filesize') . ').',
            UPLOAD_ERR_PARTIAL => 'The ' . $label . ' upload was interrupted — try again.',
            default            => 'The ' . $label . ' could not be uploaded.',
        };
        return ['ok' => false, 'url' => null, 'error' => $why];
    }
    $tmp = (string) ($file['tmp_name'] ?? '');
    if ($tmp === '' || !is_file($tmp)) return ['ok' => false, 'url' => null, 'error' => 'The ' . $label . ' could not be uploaded.'];
    if ((int) ($file['size'] ?? 0) > UPLOAD_MAX_MB * 1024 * 1024 || filesize($tmp) > UPLOAD_MAX_MB * 1024 * 1024) {
        return ['ok' => false, 'url' => null, 'error' => 'The ' . $label . ' exceeds the ' . UPLOAD_MAX_MB . ' MB limit.'];
    }
    // Type and stored extension come from the decoded image itself.
    $info = @getimagesize($tmp);
    $kind = [IMAGETYPE_JPEG => 'jpg', IMAGETYPE_PNG => 'png', IMAGETYPE_WEBP => 'webp'][$info[2] ?? 0] ?? null;
    if (!$info || $kind === null) {
        return ['ok' => false, 'url' => null, 'error' => 'Only JPEG, PNG and WebP images are allowed for the ' . $label . '.'];
    }
    $name = 'live-' . bin2hex(random_bytes(12)) . '.' . $kind;
    $dest = UPLOAD_DIR . $name;
    if (!is_dir(UPLOAD_DIR)) @mkdir(UPLOAD_DIR, 0775, true);
    // Over HTTP the file must be a genuine upload. The CLI unit tests hand in a
    // plain temporary file, which move_uploaded_file() rightly refuses; there,
    // and only there, an ordinary move is used instead.
    $moved = is_uploaded_file($tmp)
        ? move_uploaded_file($tmp, $dest)
        : (PHP_SAPI === 'cli' && (@rename($tmp, $dest) || @copy($tmp, $dest)));
    if (!$moved) return ['ok' => false, 'url' => null, 'error' => 'The ' . $label . ' could not be saved on the server.'];
    @chmod($dest, 0644);
    return ['ok' => true, 'url' => '/uploads/' . $name, 'error' => null];
}

/**
 * A link a stream may carry: a site path ("/uploads/x.jpg", never "//host") or
 * an https URL with a plain host, at most 500 characters. Anything else —
 * javascript:, data:, plain http, credentials, whitespace, a non-string — is
 * null. Never "repaired".
 */
function liveSafeUrl(mixed $v): ?string
{
    if (!is_string($v)) return null;
    $u = trim($v);
    if ($u === '' || strlen($u) > 500) return null;
    if (preg_match('/[\x00-\x20\x7F\\\\]/', $u)) return null;
    if ($u[0] === '/') return str_starts_with($u, '//') ? null : $u;
    if (stripos($u, 'https://') !== 0) return null;
    $p = parse_url($u);
    if (!is_array($p) || strtolower((string) ($p['scheme'] ?? '')) !== 'https' || empty($p['host'])) return null;
    if (isset($p['user']) || isset($p['pass'])) return null;
    if (!preg_match('/^[A-Za-z0-9.-]+$/', (string) $p['host'])) return null;
    return $u;
}

/** True when $url names a file this module uploaded (/uploads/live-…). */
function liveIsOwnUpload(?string $url): bool
{
    return is_string($url) && preg_match(LIVE_UPLOAD_RE, $url) === 1;
}

/**
 * Remove an uploaded file this module created. Only /uploads/live-<hex>.<ext>
 * names are touched; a gallery photo or a pasted https link is left alone.
 */
function liveDeleteUpload(string $url): void
{
    if (!preg_match(LIVE_UPLOAD_RE, $url, $m)) return;
    $path = UPLOAD_DIR . $m[1];
    if (is_file($path)) @unlink($path);
}
