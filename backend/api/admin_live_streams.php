<?php
/**
 * backend/api/admin_live_streams.php — the committee's JSON API for live
 * streams (docs/live/SPEC-PHASE1.md §4.4).
 *
 * api/index.php routes /api/admin/live-streams[/<id>] here with $liveAdminId
 * set (null for the collection); hit directly it answers 404. It uses the same
 * PHP session as the admin pages — sign in through /admin/login.php, then call
 * with the cookie and the CSRF token that GET returns — and the same store
 * functions as backend/admin/live_streams.php, so there is one write path.
 *
 *   GET    /api/admin/live-streams?f=&q=&sort=&dir=&page=  { streams, total, pages, page, csrf }   live.view
 *   GET    /api/admin/live-streams/<id>                    { stream }                              live.view
 *   POST   /api/admin/live-streams                         201 { stream } | 422 { error, fields }  live.manage
 *   PUT    /api/admin/live-streams/<id>                    200 { stream } | 422 | 404 | 409        live.manage (+ live.publish to change status)
 *   DELETE /api/admin/live-streams/<id>                    200 { success: true } | 404             live.manage
 *
 * Refusals are JSON, never a redirect or an HTML page:
 *   401 {"error","code":"unauthenticated"}   403 code "password_change" | "forbidden" | "csrf"
 * POST, PUT and DELETE need the session's CSRF token in the X-CSRF-Token header
 * (or a "_csrf" field of the JSON body). Uploads are not supported here: the
 * thumbnail and banner are URL fields. CORS is not widened; same origin only.
 */

// A caller with no session cookie at all cannot be signed in. Answer before
// auth.php starts a session, so this API never hands out a cookie of its own.
$liveAdminHasCookie = isset($_COOKIE[ini_get('session.name') ?: 'PHPSESSID']);
if (!$liveAdminHasCookie) {
    http_response_code(isset($liveAdminMatch) ? 401 : 404);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, private');
    header('X-Content-Type-Options: nosniff');
    echo isset($liveAdminMatch) ? '{"error":"Sign in to the admin first","code":"unauthenticated"}' : '{"error":"Not found"}';
    exit;
}

require_once __DIR__ . '/../includes/auth.php';   // session, .env.local, errors.php (HTML handlers, replaced below)

// auth.php installed the admin's HTML error page; this is an API, so put the
// JSON handlers back: a 500 with a reference, warnings logged and not fatal.
ini_set('display_errors', '0');
ini_set('log_errors', '1');
set_exception_handler(function (Throwable $e): void {
    $ref = strtoupper(substr(bin2hex(random_bytes(4)), 0, 8));
    error_log(sprintf('[live-admin %s] %s: %s in %s:%d', $ref, get_class($e), $e->getMessage(), $e->getFile(), $e->getLine()));
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store, private');
    }
    echo json_encode(['error' => 'The server could not complete that request. Please try again.', 'reference' => $ref], JSON_UNESCAPED_UNICODE);
    exit;
});
set_error_handler(function (int $no, string $str, string $file = '', int $line = 0): bool {
    if (!(error_reporting() & $no)) return false;
    error_log(sprintf('[live-admin warning] %s in %s:%d', $str, $file, $line));
    return true;
});

require_once __DIR__ . '/../includes/live.php';

/** A JSON answer, then stop. */
function liveAdminJson(array $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
    exit;
}

header('Cache-Control: no-store, private');
header('X-Content-Type-Options: nosniff');

// Hit directly, not through api/index.php: not a route.
if (!isset($liveAdminMatch) || !is_array($liveAdminMatch)) liveAdminJson(['error' => 'Not found'], 404);
$liveAdminTarget = isset($liveAdminId) && $liveAdminId !== null ? (int) $liveAdminId : null;
$liveAdminMethod = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));

// ── Who is asking ───────────────────────────────────────────────────────────
adminRevalidateSession();
if (empty($_SESSION['admin_logged_in'])) liveAdminJson(['error' => 'Sign in to the admin first', 'code' => 'unauthenticated'], 401);
if (!empty($_SESSION['admin_must_change'])) liveAdminJson(['error' => 'Choose a new password on your profile page first.', 'code' => 'password_change'], 403);

$liveAdminMe    = currentAdmin() ?? [];
$liveAdminActor = (string) ($liveAdminMe['username'] ?? 'admin');
$liveAdminWrite = in_array($liveAdminMethod, ['POST', 'PUT', 'DELETE'], true);

if (!adminCan($liveAdminWrite ? 'live.manage' : 'live.view')) {
    liveAdminJson(['error' => 'Your role cannot ' . ($liveAdminWrite ? 'change' : 'read') . ' live streams.', 'code' => 'forbidden'], 403);
}

// ── Method / route shape ────────────────────────────────────────────────────
$liveAdminAllowed = $liveAdminTarget === null ? ['GET', 'HEAD', 'POST'] : ['GET', 'HEAD', 'PUT', 'DELETE'];
if (!in_array($liveAdminMethod, $liveAdminAllowed, true)) {
    header('Allow: ' . implode(', ', $liveAdminAllowed));
    liveAdminJson(['error' => 'Method not allowed'], 405);
}
if (!liveTablesExist()) {
    liveAdminJson(['error' => 'Live streaming is not installed yet: apply database migration 011_live_streams.sql first.', 'code' => 'not_installed'], 503);
}
$liveAdminDb = getDB();

// ── The body and the CSRF token (writes only) ───────────────────────────────
$liveAdminBody = [];
if ($liveAdminWrite) {
    $raw = (string) file_get_contents('php://input');
    if (strlen($raw) > 512 * 1024) liveAdminJson(['error' => 'That request is too large.', 'fields' => []], 413);
    if (trim($raw) !== '') {
        $decoded = json_decode($raw, true);
        if (!is_array($decoded) || ($decoded !== [] && array_is_list($decoded))) {
            liveAdminJson(['error' => 'Send a JSON object with the stream fields.', 'fields' => []], 422);
        }
        $liveAdminBody = $decoded;
    }
    $sent = (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? (is_string($liveAdminBody['_csrf'] ?? null) ? $liveAdminBody['_csrf'] : ''));
    if ($sent === '' || !hash_equals(csrfToken(), $sent)) {
        liveAdminJson(['error' => 'The request did not carry a valid CSRF token. Reload the admin and try again.', 'code' => 'csrf'], 403);
    }
    unset($liveAdminBody['_csrf']);
}

// ── Routes ──────────────────────────────────────────────────────────────────
if ($liveAdminMethod === 'GET' || $liveAdminMethod === 'HEAD') {
    if ($liveAdminTarget === null) {
        $f = liveAdminFilters($_GET);
        $list = liveListAdmin($liveAdminDb, $f, $f['page'], 25);
        liveAdminJson([
            'streams' => array_map('liveShapeAdmin', $list['rows']),
            'total'   => $list['total'],
            'pages'   => $list['pages'],
            'page'    => $list['page'],
            'csrf'    => csrfToken(),
        ]);
    }
    $row = liveLoad($liveAdminDb, $liveAdminTarget, true);
    if ($row === null) liveAdminJson(['error' => 'Not found'], 404);
    liveAdminJson(['stream' => liveShapeAdmin($row)]);
}

if ($liveAdminMethod === 'POST') {
    $v = liveValidate($liveAdminBody, null, $liveAdminDb);
    if ($v['errors']) liveAdminJson(['error' => 'Please correct the highlighted fields.', 'fields' => $v['errors']], 422);
    $id = liveInsert($liveAdminDb, $v['values'], $liveAdminActor);
    liveAdminJson(['stream' => liveShapeAdmin(liveLoad($liveAdminDb, $id, true))], 201);
}

if ($liveAdminMethod === 'PUT') {
    $existing = liveLoad($liveAdminDb, $liveAdminTarget);
    if ($existing === null) liveAdminJson(['error' => 'Not found'], 404);
    $v = liveValidate($liveAdminBody, $existing, $liveAdminDb);
    $wantsStatus = isset($v['values']['status']) && (string) $v['values']['status'] !== (string) $existing['status'];
    // An illegal jump is answered as a 409, not a field error, so a client can tell it apart.
    if ($wantsStatus && isset($v['errors']['status']) && liveIsStatus($v['values']['status'])) {
        liveAdminJson(['error' => 'That status change is not allowed.', 'code' => 'transition', 'from' => (string) $existing['status'], 'to' => (string) $v['values']['status']], 409);
    }
    if ($v['errors']) liveAdminJson(['error' => 'Please correct the highlighted fields.', 'fields' => $v['errors']], 422);
    if ($wantsStatus && !adminCan('live.publish')) {
        liveAdminJson(['error' => 'Your role cannot change a stream\'s status.', 'code' => 'forbidden'], 403);
    }
    try {
        liveUpdate($liveAdminDb, $liveAdminTarget, $v['values'], $liveAdminActor);
    } catch (LiveTransitionException $e) {
        liveAdminJson(['error' => 'That status change is not allowed.', 'code' => 'transition', 'from' => (string) $existing['status'], 'to' => (string) $v['values']['status']], 409);
    } catch (LiveValidationException $e) {
        // liveSetStatus() re-checked the stored row for the target status (the
        // body was already validated, so this is the same 422 shape, rolled back).
        liveAdminJson(['error' => 'Please correct the highlighted fields.', 'fields' => $e->fields], 422);
    }
    liveAdminJson(['stream' => liveShapeAdmin(liveLoad($liveAdminDb, $liveAdminTarget, true))]);
}

if ($liveAdminMethod === 'DELETE') {
    if (!liveSoftDelete($liveAdminDb, $liveAdminTarget, $liveAdminActor)) liveAdminJson(['error' => 'Not found'], 404);
    liveAdminJson(['success' => true]);
}

liveAdminJson(['error' => 'Not found'], 404);
