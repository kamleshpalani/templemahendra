<?php
/**
 * backend/api/notifications.php — the signed-in devotee's notifications.
 *
 * Dispatched by api/index.php for every /api/notifications/* path
 * (docs/notifications/SPEC.md §6.1). Actions:
 *   GET  list            the feed: filters, search, date range, keyset pages
 *   GET  unread          the bell's cheap poll: a count and the newest id
 *   GET  categories      what a notification can be about
 *   GET  prefs           settings, plus which channels can reach this devotee
 *   POST prefs           save settings
 *   POST read | unread | archive | unarchive | delete   { ids: [int] }
 *   POST read-all        every visible notification
 *   POST click           { id } marks read, records the click, returns the link
 *   POST devices         register this browser for push
 *   POST devices-remove  forget it
 *
 * WHAT A DEVOTEE SEES. Only rows carrying their own devotee_id, shown in the app,
 * not deleted, and past their deliver_after. Every read and every change goes
 * through that one condition (notifVisibleSql), so an id belonging to someone
 * else — or to a message still held for later — changes nothing and says
 * nothing: the reply is "updated: 0", never "that is not yours".
 *
 * WHEN IT HAPPENED. A notification held for later (a recipient-time campaign
 * is created up to a day early) is dated by the moment it became visible, not
 * by the moment the row was written. Otherwise it would surface under
 * "Yesterday", below messages the devotee has already seen, and the bell's
 * "has anything new arrived?" check would miss it.
 *
 * The rules, the preferences and the devices all live in the Notification
 * Service (includes/notify.php); this file only speaks HTTP for them.
 */

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/devotee_auth.php';
require_once __DIR__ . '/../includes/notify.php';

$action = $notificationsAction ?? '';
$method = $_SERVER['REQUEST_METHOD'];

// Unknown actions are a 404 before anything else runs — before the session, so
// a typo is never answered with an auth challenge that implies the action exists.
const NOTIF_GET_ACTIONS  = ['list', 'unread', 'categories', 'prefs'];
const NOTIF_POST_ACTIONS = ['prefs', 'read', 'unread', 'read-all', 'archive', 'unarchive', 'delete', 'click', 'devices', 'devices-remove'];
if (!in_array($action, NOTIF_GET_ACTIONS, true) && !in_array($action, NOTIF_POST_ACTIONS, true)) {
    sendError('Not found', 404);
}

const NOTIF_MAX_IDS       = 200;
const NOTIF_PAGE_DEFAULT  = 20;
const NOTIF_PAGE_MAX      = 50;
const NOTIF_QUERY_MAX     = 100;
const NOTIF_MAX_CATEGORIES = 30;
const NOTIF_POST_PER_MIN  = 120;

/*
 * The moment a notification became visible: its creation, or its deliver_after
 * when it was held. Sorting, paging and date filters all use this one expression.
 */
const NOTIF_SHOWN_AT = 'GREATEST(n.created_at, COALESCE(n.deliver_after, n.created_at))';

// Everything here is one person's private data. No proxy or browser cache may
// keep a copy, and the bell's poll must always see the current count.
header('Cache-Control: no-store, private');

devoteeRequireTables();
$me   = devoteeRequireAuth();
$meId = (int) $me['id'];

if (!notifyTablesExist()) {
    sendJson([
        'error' => 'Notifications are not enabled on this site yet.',
        'code'  => 'notifications_disabled',
    ], 503);
}

/* ── Shared pieces ──────────────────────────────────────────────────────── */

/**
 * The WHERE fragment for "a notification this devotee can see", on alias n.
 * Uses the named parameters :me and :due exactly once each (native prepares
 * refuse a repeated name), supplied by notifVisibleParams().
 */
function notifVisibleSql(): string
{
    return 'n.devotee_id = :me AND n.show_in_app = 1 AND n.deleted_at IS NULL'
         . ' AND (n.deliver_after IS NULL OR n.deliver_after <= :due)';
}

function notifVisibleParams(int $devoteeId): array
{
    return [':me' => $devoteeId, ':due' => notifyNow()];
}

/** The bell's number: visible, unread, not archived. */
function notifUnreadCount(int $devoteeId): int
{
    $stmt = getDB()->prepare(
        'SELECT COUNT(*) FROM notifications n
          WHERE ' . notifVisibleSql() . ' AND n.read_at IS NULL AND n.archived_at IS NULL'
    );
    $stmt->execute(notifVisibleParams($devoteeId));
    return (int) $stmt->fetchColumn();
}

/** A 422 in the shape every devotee form already understands. */
function notifInvalid(array $fields, string $message = 'Please correct the highlighted fields.'): never
{
    sendJson(['error' => $message, 'fields' => $fields], 422);
}

/** ":i0, :i1, …" and the matching parameters for an IN list. */
function notifInList(array $ids, string $prefix = 'i'): array
{
    $names  = [];
    $params = [];
    foreach (array_values($ids) as $k => $id) {
        $names[] = ':' . $prefix . $k;
        $params[':' . $prefix . $k] = $id;
    }
    return [implode(', ', $names), $params];
}

/** One row of the feed in the SPEC §6.1 item shape. */
function notifItem(array $r): array
{
    $cat   = notifyCategory((string) $r['category']);
    $label = (string) ($r['cta_label'] ?? '');
    return [
        'id'            => (int) $r['id'],
        'title'         => (string) $r['title'],
        'body'          => (string) $r['body'],
        'category'      => (string) $r['category'],
        'categoryLabel' => [
            'ta' => (string) ($cat['label_ta'] ?? $r['category']),
            'en' => (string) ($cat['label_en'] ?? $r['category']),
        ],
        'icon'          => (string) ($cat['icon'] ?? 'bell'),
        'priority'      => (string) $r['priority'],
        // Re-checked on the way out: the column was checked on the way in, but a
        // link a browser will follow is worth checking twice.
        'ctaUrl'        => notifySafeCtaUrl($r['cta_url'] ?? null),
        'ctaLabel'      => $label !== '' ? $label : null,
        'imageUrl'      => notifySafeCtaUrl($r['image_url'] ?? null),
        'createdAt'     => notifyIso($r['shown_at']),
        'readAt'        => notifyIso($r['read_at']),
        'archivedAt'    => notifyIso($r['archived_at']),
        'isRead'        => $r['read_at'] !== null,
        'isArchived'    => $r['archived_at'] !== null,
        'entity'        => $r['entity_type'] !== null && $r['entity_type'] !== ''
            ? ['type' => (string) $r['entity_type'], 'id' => $r['entity_id'] !== null ? (int) $r['entity_id'] : null]
            : null,
    ];
}

/** Categories as the devotee UI lists them, in the committee's order. */
function notifCategoriesPublic(): array
{
    $out = [];
    foreach (notifyCategories(true) as $key => $c) {
        $out[] = [
            'key'       => (string) $key,
            'label'     => ['ta' => (string) $c['label_ta'], 'en' => (string) $c['label_en']],
            'icon'      => (string) $c['icon'],
            'kind'      => (string) $c['kind'],
            'mutable'   => (bool) $c['mutable'],
            'defaultOn' => (int) $c['default_on'] === 1,
        ];
    }
    return $out;
}

/** The opaque page marker: base64url of "createdAt|id". */
function notifCursorEncode(string $shownAt, int $id): string
{
    return notifyB64u((string) notifyIso($shownAt) . '|' . $id);
}

/** ['at' => 'Y-m-d H:i:s' UTC, 'id' => int], or null for anything that is not a cursor this file made. */
function notifCursorDecode(string $cursor): ?array
{
    if (!preg_match('/^[A-Za-z0-9_-]{8,80}$/', $cursor)) return null;
    $raw = notifyB64uDecode($cursor);
    if (!preg_match('/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})Z\|([1-9][0-9]{0,9})$/', $raw, $m)) return null;
    if (!isValidDate($m[1])) return null;
    return ['at' => $m[1] . ' ' . $m[2], 'id' => (int) $m[3]];
}

/**
 * A query-string value that must be a single string. PHP turns "status[]=x"
 * into an array; that is a malformed request, not a filter.
 */
function notifQueryString(string $key): ?string
{
    if (!array_key_exists($key, $_GET)) return null;
    return is_string($_GET[$key]) ? $_GET[$key] : "\0invalid";
}

/**
 * The ids a bulk action names: a list of positive integers, at most 200,
 * duplicates dropped. Anything else is a 422 — silently ignoring a malformed id
 * would report success for a change that never happened.
 */
function notifIdsFromBody(array $body): array
{
    $raw = $body['ids'] ?? null;
    if (!is_array($raw) || !array_is_list($raw) || $raw === []) {
        notifInvalid(['ids' => 'Choose at least one notification.']);
    }
    if (count($raw) > NOTIF_MAX_IDS) {
        notifInvalid(['ids' => 'You can change at most ' . NOTIF_MAX_IDS . ' notifications at once.']);
    }
    $ids = [];
    foreach ($raw as $v) {
        $id = notifPositiveInt($v);
        if ($id === null) notifInvalid(['ids' => 'Those notifications could not be found. Reload the page and try again.']);
        $ids[$id] = $id;
    }
    return array_values($ids);
}

/** A positive integer id from JSON (a number, or a string of digits), else null. */
function notifPositiveInt(mixed $v): ?int
{
    if (is_int($v)) return $v >= 1 && $v <= 4294967295 ? $v : null;
    if (is_string($v) && preg_match('/^[1-9][0-9]{0,9}$/', $v) && (int) $v <= 4294967295) return (int) $v;
    return null;
}

/**
 * One delivery-history row per changed in-app delivery, in a single statement:
 * "mark all as read" can touch hundreds, and one INSERT per row would hold the
 * devotee's request for no benefit.
 */
function notifDeliveryEvents(array $deliveryIds, string $event, string $detail): void
{
    if ($deliveryIds === []) return;
    $rows   = [];
    $params = [];
    $now    = notifyNow();
    foreach (array_values($deliveryIds) as $k => $id) {
        $rows[] = "(:d{$k}, :e{$k}, :x{$k}, :t{$k})";
        $params[":d{$k}"] = $id;
        $params[":e{$k}"] = $event;
        $params[":x{$k}"] = $detail;
        $params[":t{$k}"] = $now;
    }
    getDB()->prepare('INSERT INTO notification_delivery_events (delivery_id, event, detail, created_at) VALUES ' . implode(', ', $rows))
           ->execute($params);
}

/**
 * Read or unread, on the notification AND its in-app delivery, so the admin's
 * "in-app read rate" means what the devotee did. $ids null means every visible
 * notification (read-all). Returns how many notifications changed.
 */
function notifSetRead(int $devoteeId, ?array $ids, bool $read): int
{
    $db  = getDB();
    $now = notifyNow();
    [$in, $idParams] = $ids === null ? ['', []] : notifInList($ids);
    $idSql = $ids === null ? '' : " AND n.id IN ($in)";

    $db->beginTransaction();
    try {
        $stmt = $db->prepare(
            'UPDATE notifications n SET n.read_at = ' . ($read ? ':now' : 'NULL')
            . ' WHERE ' . notifVisibleSql() . ' AND n.read_at IS ' . ($read ? 'NULL' : 'NOT NULL') . $idSql
        );
        $stmt->execute(notifVisibleParams($devoteeId) + $idParams + ($read ? [':now' => $now] : []));
        $updated = $stmt->rowCount();

        // The deliveries are brought into line whether or not the notification
        // itself changed: that also repairs a row left half-read by an older
        // client, and it never touches a delivery the devotee has not received
        // (queued, skipped, cancelled).
        $from = $read ? "('sent', 'delivered')" : "('read')";
        $sel  = $db->prepare(
            "SELECT d.id FROM notification_deliveries d
               JOIN notifications n ON n.id = d.notification_id
              WHERE " . notifVisibleSql() . $idSql . " AND d.channel = 'inapp' AND d.status IN $from"
        );
        $sel->execute(notifVisibleParams($devoteeId) + $idParams);
        $deliveryIds = array_map('intval', $sel->fetchAll(PDO::FETCH_COLUMN));

        if ($deliveryIds) {
            [$din, $dParams] = notifInList($deliveryIds, 'd');
            if ($read) {
                $db->prepare(
                    "UPDATE notification_deliveries
                        SET status = 'read', read_at = COALESCE(read_at, :at1), delivered_at = COALESCE(delivered_at, :at2)
                      WHERE id IN ($din) AND status IN ('sent', 'delivered')"
                )->execute($dParams + [':at1' => $now, ':at2' => $now]);
                notifDeliveryEvents($deliveryIds, 'read', 'read by the devotee');
            } else {
                $db->prepare(
                    "UPDATE notification_deliveries SET status = 'sent', read_at = NULL
                      WHERE id IN ($din) AND status = 'read'"
                )->execute($dParams);
                notifDeliveryEvents($deliveryIds, 'unread', 'marked unread by the devotee');
            }
        }
        $db->commit();
        return $updated;
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
}

/** archive, unarchive or delete (soft). Returns how many notifications changed. */
function notifSetFlag(int $devoteeId, array $ids, string $action): int
{
    [$in, $idParams] = notifInList($ids);
    $set = match ($action) {
        'archive'   => 'n.archived_at = :now WHERE n.archived_at IS NULL AND ',
        'unarchive' => 'n.archived_at = NULL WHERE n.archived_at IS NOT NULL AND ',
        'delete'    => 'n.deleted_at = :now WHERE ',   // the visible condition already requires deleted_at IS NULL
    };
    $params = notifVisibleParams($devoteeId) + $idParams;
    if ($action !== 'unarchive') $params[':now'] = notifyNow();
    $stmt = getDB()->prepare('UPDATE notifications n SET ' . $set . notifVisibleSql() . " AND n.id IN ($in)");
    $stmt->execute($params);
    return $stmt->rowCount();
}

/**
 * GET prefs: the saved choices, and whether each channel can reach this devotee
 * at all — so the settings page can say "Add a phone number" or "Not available
 * yet" instead of offering a switch that does nothing.
 */
function notifPrefsPayload(array $me): array
{
    $id    = (int) $me['id'];
    $prefs = notifyPrefs($id);

    $hasEmail      = filter_var((string) ($me['email'] ?? ''), FILTER_VALIDATE_EMAIL) !== false;
    $emailVerified = !empty($me['email_verified_at']);
    $digits        = preg_replace('/\D+/', '', (string) ($me['phone'] ?? '')) ?? '';
    $hasPhone      = strlen($digits) >= 7;
    $phoneVerified = $hasPhone && !empty($me['phone_verified_at']);

    $stmt = getDB()->prepare('SELECT COUNT(*) FROM devotee_devices WHERE devotee_id = :d AND is_active = 1');
    $stmt->execute([':d' => $id]);
    $devices = (int) $stmt->fetchColumn();

    // Contact first, then the provider: the same order the channel policy
    // applies, so the reason shown is the reason a message would be skipped.
    $reason = static function (string $channel, bool $hasContact, string $missing): ?string {
        if (!$hasContact) return $missing;
        return notifyProviderFor($channel)->isConfigured() ? null : 'not configured';
    };
    $emailReason = $reason('email', $hasEmail, 'no email');
    $waReason    = $reason('whatsapp', $hasPhone, 'no phone');
    $smsReason   = $reason('sms', $hasPhone, 'no phone');

    // A browser can only subscribe with the application server key. Without one
    // (the FCM driver, or half-set VAPID variables) web push is not available
    // here, whatever the driver says. Having no device yet is not a reason: this
    // page is where the devotee adds one.
    $publicKey  = notifyVapidPublicKey();
    $pushReason = notifyProviderFor('push')->isConfigured() && $publicKey !== null ? null : 'not configured';

    $languages = [];
    foreach (notifyLanguages() as $code => $label) {
        $languages[] = ['code' => (string) $code, 'label' => (string) $label];
    }

    return [
        'prefs'      => $prefs,
        'categories' => notifCategoriesPublic(),
        'channels'   => [
            'inapp'    => ['available' => true],
            'email'    => ['available' => $emailReason === null, 'reason' => $emailReason, 'verified' => $hasEmail && $emailVerified],
            'whatsapp' => ['available' => $waReason === null, 'reason' => $waReason, 'verified' => $phoneVerified],
            'sms'      => ['available' => $smsReason === null, 'reason' => $smsReason, 'verified' => $phoneVerified],
            'push'     => ['available' => $pushReason === null, 'reason' => $pushReason, 'publicKey' => $publicKey, 'devices' => $devices],
        ],
        'languages'  => $languages,
        'phone'      => ['number' => $hasPhone ? '+' . $digits : null, 'verified' => $phoneVerified],
    ];
}

/* ── GET ────────────────────────────────────────────────────────────────── */

if ($method === 'GET' && in_array($action, NOTIF_GET_ACTIONS, true)) {
    $db = getDB();
    switch ($action) {

        case 'list': {
            $fields = [];

            $status = notifQueryString('status') ?? 'all';
            if (!in_array($status, ['all', 'unread', 'read', 'archived'], true)) {
                $fields['status'] = 'Choose all, unread, read or archived.';
            }

            $categories = [];
            $catRaw = notifQueryString('category');
            if ($catRaw !== null && trim($catRaw) !== '') {
                foreach (explode(',', $catRaw) as $key) {
                    $key = trim($key);
                    if ($key === '') continue;
                    // Shape only: a category the committee has since removed is still
                    // a fair filter for old messages, and simply matches what it matches.
                    if (!preg_match('/^[a-z0-9_]{1,32}$/', $key)) {
                        $fields['category'] = 'Choose categories from the list.';
                        break;
                    }
                    $categories[$key] = $key;
                }
                if (count($categories) > NOTIF_MAX_CATEGORIES) $fields['category'] = 'Choose fewer categories.';
            }

            $q = notifQueryString('q');
            $q = $q === null ? '' : trim($q);
            if ($q === "\0invalid" || str_contains($q, "\0") || mb_strlen($q) > NOTIF_QUERY_MAX) {
                $fields['q'] = 'Search for at most ' . NOTIF_QUERY_MAX . ' characters.';
            }

            // Dates are the devotee's own calendar days: "13 September" in
            // Leicester starts five and a half hours after it does in Pudupatti.
            $tz = notifyPrefs($meId)['effectiveTimezone'];
            $fromUtc = $toUtc = null;
            $from = notifQueryString('from');
            $to   = notifQueryString('to');
            if ($from !== null && $from !== '') {
                if (!isValidDate($from)) $fields['from'] = 'Enter the start date as YYYY-MM-DD.';
                else $fromUtc = notifyToUtc($from . ' 00:00:00', $tz);
            }
            if ($to !== null && $to !== '') {
                if (!isValidDate($to)) {
                    $fields['to'] = 'Enter the end date as YYYY-MM-DD.';
                } else {
                    // Inclusive of the whole last day: everything before the next midnight.
                    $toUtc = notifyToUtc((new DateTimeImmutable($to))->modify('+1 day')->format('Y-m-d') . ' 00:00:00', $tz);
                }
            }
            if ($fromUtc !== null && $toUtc !== null && $from > $to) {
                $fields['to'] = 'The end date is before the start date.';
            }

            $limit = NOTIF_PAGE_DEFAULT;
            $limitRaw = notifQueryString('limit');
            if ($limitRaw !== null && $limitRaw !== '') {
                if (!preg_match('/^[0-9]{1,3}$/', $limitRaw) || (int) $limitRaw < 1 || (int) $limitRaw > NOTIF_PAGE_MAX) {
                    $fields['limit'] = 'Ask for between 1 and ' . NOTIF_PAGE_MAX . ' notifications.';
                } else {
                    $limit = (int) $limitRaw;
                }
            }

            $cursor = null;
            $cursorRaw = notifQueryString('cursor');
            if ($cursorRaw !== null && $cursorRaw !== '') {
                $cursor = notifCursorDecode($cursorRaw);
                if ($cursor === null) $fields['cursor'] = 'That page is no longer available. Reload the list.';
            }

            if ($fields) notifInvalid($fields, 'Some of the filters are not valid.');

            $where  = [notifVisibleSql()];
            $params = notifVisibleParams($meId);
            $where[] = match ($status) {
                'unread'   => 'n.read_at IS NULL AND n.archived_at IS NULL',
                'read'     => 'n.read_at IS NOT NULL AND n.archived_at IS NULL',
                'archived' => 'n.archived_at IS NOT NULL',
                default    => 'n.archived_at IS NULL',
            };
            if ($categories) {
                [$in, $catParams] = notifInList(array_values($categories), 'c');
                $where[] = "n.category IN ($in)";
                $params += $catParams;
            }
            if ($q !== '') {
                // '!' is the escape character, so a search for "100%" or "a_b" means
                // exactly that and not "anything". The column collation already
                // makes the match case-insensitive.
                $like = '%' . str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $q) . '%';
                $where[] = "(n.title LIKE :q1 ESCAPE '!' OR n.body LIKE :q2 ESCAPE '!')";
                $params[':q1'] = $like;
                $params[':q2'] = $like;
            }
            if ($fromUtc !== null) {
                $where[] = NOTIF_SHOWN_AT . ' >= :fromUtc';
                $params[':fromUtc'] = $fromUtc;
            }
            if ($toUtc !== null) {
                $where[] = NOTIF_SHOWN_AT . ' < :toUtc';
                $params[':toUtc'] = $toUtc;
            }
            if ($cursor !== null) {
                // Keyset, not OFFSET: a notification arriving while the devotee
                // scrolls must not shift the next page and repeat a row.
                $where[] = '(' . NOTIF_SHOWN_AT . ' < :cur1 OR (' . NOTIF_SHOWN_AT . ' = :cur2 AND n.id < :curId))';
                $params[':cur1']  = $cursor['at'];
                $params[':cur2']  = $cursor['at'];
                $params[':curId'] = $cursor['id'];
            }

            $stmt = $db->prepare(
                'SELECT n.id, n.title, n.body, n.category, n.priority, n.cta_url, n.cta_label, n.image_url,
                        n.entity_type, n.entity_id, n.read_at, n.archived_at, ' . NOTIF_SHOWN_AT . ' AS shown_at
                   FROM notifications n
                  WHERE ' . implode(' AND ', $where) . '
                  ORDER BY shown_at DESC, n.id DESC
                  LIMIT ' . ($limit + 1)
            );
            $stmt->execute($params);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            $next = null;
            if (count($rows) > $limit) {
                $rows = array_slice($rows, 0, $limit);
                $last = $rows[$limit - 1];
                $next = notifCursorEncode((string) $last['shown_at'], (int) $last['id']);
            }

            sendJson([
                'items'      => array_map('notifItem', $rows),
                'nextCursor' => $next,
                'unread'     => notifUnreadCount($meId),
            ]);
        }

        case 'unread': {
            $stmt = $db->prepare(
                'SELECT n.id, ' . NOTIF_SHOWN_AT . ' AS shown_at
                   FROM notifications n
                  WHERE ' . notifVisibleSql() . ' AND n.archived_at IS NULL
                  ORDER BY shown_at DESC, n.id DESC
                  LIMIT 1'
            );
            $stmt->execute(notifVisibleParams($meId));
            $latest = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
            sendJson([
                'unread'   => notifUnreadCount($meId),
                'latestId' => $latest ? (int) $latest['id'] : null,
                'latestAt' => $latest ? notifyIso($latest['shown_at']) : null,
            ]);
        }

        case 'categories':
            sendJson(notifCategoriesPublic());

        case 'prefs':
            sendJson(notifPrefsPayload($me));
    }
    sendError('Not found', 404);
}

if ($method === 'GET' || !in_array($action, NOTIF_POST_ACTIONS, true) || $method !== 'POST') {
    $allowed = array_merge(
        in_array($action, NOTIF_GET_ACTIONS, true) ? ['GET'] : [],
        in_array($action, NOTIF_POST_ACTIONS, true) ? ['POST'] : []
    );
    header('Allow: ' . implode(', ', $allowed));
    sendError('Method not allowed', 405);
}

/* ── POST ───────────────────────────────────────────────────────────────── */

devoteeRequireCsrf();

// Per devotee, not per address: a family on one connection must not share a
// budget, and a devotee on a phone switching networks keeps theirs. Counted
// after the CSRF check so a forged request cannot spend someone's allowance.
if (!rateLimitAllow('notif-post', NOTIF_POST_PER_MIN, 60, 'd' . $meId)) {
    header('Retry-After: 60');
    sendJson([
        'error'      => 'That was a lot of changes in a short time. Please wait a minute and try again.',
        'code'       => 'rate_limited',
        'retryAfter' => 60,
    ], 429);
}

$body = getJsonBody();

switch ($action) {

    case 'prefs': {
        $input  = [];
        $fields = [];

        if (array_key_exists('lang', $body)) {
            $lang = is_string($body['lang']) ? strtolower(trim($body['lang'])) : '';
            if (!isset(notifyLanguages()[$lang])) $fields['lang'] = 'Choose one of the languages offered.';
            else $input['lang'] = $lang;
        }
        if (array_key_exists('timezone', $body)) {
            $tz = $body['timezone'];
            if ($tz === null || (is_string($tz) && trim($tz) === '')) $input['timezone'] = null;
            elseif (is_string($tz) && notifyIsTimezone(trim($tz))) $input['timezone'] = trim($tz);
            else $fields['timezone'] = 'Choose a time zone from the list.';
        }
        if (array_key_exists('channels', $body)) {
            $channels = $body['channels'];
            if (!is_array($channels) || ($channels !== [] && array_is_list($channels))) {
                $fields['channels'] = 'Those channel settings could not be read.';
            } else {
                foreach (NOTIFY_CHANNELS as $c) {
                    if (!array_key_exists($c, $channels)) continue;
                    if (notifyBool($channels[$c]) === null) {
                        $fields['channels'] = 'Those channel settings could not be read.';
                        break;
                    }
                }
                $input['channels'] = $channels;
            }
        }
        if (array_key_exists('muted', $body)) {
            $muted = $body['muted'];
            if (!is_array($muted) || !array_is_list($muted) || count($muted) > 100
                || array_filter($muted, static fn($k): bool => !is_string($k)) !== []) {
                $fields['muted'] = 'Those category settings could not be read.';
            } else {
                // Security, booking and emergency keys are dropped by the service:
                // those messages cannot be muted, and a stale page must not fail over it.
                $input['muted'] = $muted;
            }
        }
        foreach (['promotional', 'unsubscribed'] as $flag) {
            if (!array_key_exists($flag, $body)) continue;
            $v = notifyBool($body[$flag]);
            if ($v === null) $fields[$flag] = 'Choose yes or no.';
            else $input[$flag] = $v;
        }

        if ($fields) notifInvalid($fields, 'Please correct the highlighted settings.');

        // The tables were checked above, so anything but a validation message is
        // a real failure and goes to the API's JSON error handler with a reference.
        try {
            $prefs = notifySavePrefs($meId, $input);
        } catch (InvalidArgumentException $e) {
            notifInvalid([], $e->getMessage());
        }
        sendJson(['ok' => true, 'prefs' => $prefs, 'message' => 'Your notification settings are saved.']);
    }

    case 'read':
    case 'unread': {
        $ids = notifIdsFromBody($body);
        $updated = notifSetRead($meId, $ids, $action === 'read');
        sendJson(['ok' => true, 'updated' => $updated, 'unread' => notifUnreadCount($meId)]);
    }

    case 'read-all': {
        $updated = notifSetRead($meId, null, true);
        sendJson(['ok' => true, 'updated' => $updated, 'unread' => notifUnreadCount($meId)]);
    }

    case 'archive':
    case 'unarchive':
    case 'delete': {
        $ids = notifIdsFromBody($body);
        $updated = notifSetFlag($meId, $ids, $action);
        sendJson(['ok' => true, 'updated' => $updated, 'unread' => notifUnreadCount($meId)]);
    }

    case 'click': {
        $id = notifPositiveInt($body['id'] ?? null);
        if ($id === null) notifInvalid(['id' => 'That notification could not be found.']);

        $params = notifVisibleParams($meId) + [':id' => $id];
        $stmt = getDB()->prepare('SELECT n.id, n.cta_url FROM notifications n WHERE ' . notifVisibleSql() . ' AND n.id = :id');
        $stmt->execute($params);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            sendJson(['error' => 'That notification is no longer available.', 'code' => 'not_found'], 404);
        }

        // notifyRecordClick marks the in-app delivery and the notification read
        // and records the click once, however often the devotee taps.
        $stmt = getDB()->prepare("SELECT id FROM notification_deliveries WHERE notification_id = :n AND channel = 'inapp'");
        $stmt->execute([':n' => $id]);
        $deliveryId = (int) $stmt->fetchColumn();
        if ($deliveryId > 0) notifyRecordClick($deliveryId);

        // A notification whose in-app delivery was never "sent" (an old row, a
        // repaired one) is still read once the devotee has opened it.
        getDB()->prepare('UPDATE notifications SET read_at = :now WHERE id = :id AND devotee_id = :me AND read_at IS NULL')
               ->execute([':now' => notifyNow(), ':id' => $id, ':me' => $meId]);

        sendJson(['ok' => true, 'url' => notifySafeCtaUrl($row['cta_url']), 'unread' => notifUnreadCount($meId)]);
    }

    case 'devices': {
        $fields   = [];
        $platform = $body['platform'] ?? 'web';
        if (!is_string($platform) || !in_array($platform, ['web', 'android', 'ios'], true)) {
            $fields['platform'] = 'This kind of device is not supported.';
            $platform = 'web';
        }
        $sub = $body['subscription'] ?? null;
        if (!is_array($sub)) {
            notifInvalid(['subscription' => 'This browser did not send a push subscription. Turn notifications off and on again.']);
        }
        $endpoint = is_string($sub['endpoint'] ?? null) ? trim($sub['endpoint']) : '';
        $keys     = is_array($sub['keys'] ?? null) ? $sub['keys'] : [];

        if ($platform === 'web') {
            $host = parse_url($endpoint, PHP_URL_HOST);
            if ($endpoint === '' || strlen($endpoint) > 2000 || stripos($endpoint, 'https://') !== 0 || !is_string($host) || $host === '') {
                $fields['endpoint'] = 'This browser gave an address push messages cannot use.';
            }
            $p256 = $keys['p256dh'] ?? null;
            $auth = $keys['auth'] ?? null;
            if (!is_string($p256) || !preg_match('/^[A-Za-z0-9_-]{87}$/', $p256) || !is_string($auth) || !preg_match('/^[A-Za-z0-9_-]{22}$/', $auth)) {
                $fields['keys'] = 'This browser gave encryption keys push messages cannot use.';
            }
        } elseif ($endpoint === '' || strlen($endpoint) > 2000) {
            $fields['endpoint'] = 'This device gave a push token that cannot be used.';
        }
        if ($fields) notifInvalid($fields, 'This device could not be registered for notifications.');

        $subscription = ['endpoint' => $endpoint];
        if ($platform === 'web') $subscription['keys'] = ['p256dh' => $keys['p256dh'], 'auth' => $keys['auth']];
        $ua = isset($_SERVER['HTTP_USER_AGENT']) && is_string($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : null;

        $result = notifyRegisterDevice($meId, $subscription, $platform, $ua);
        if (!$result['ok']) {
            notifInvalid(['subscription' => (string) $result['error']], (string) $result['error']);
        }
        sendJson(['ok' => true, 'deviceId' => (int) $result['id']]);
    }

    case 'devices-remove': {
        $endpoint = is_string($body['endpoint'] ?? null) ? trim($body['endpoint']) : '';
        if ($endpoint === '' || strlen($endpoint) > 2000) {
            notifInvalid(['endpoint' => 'Which device should stop receiving notifications?']);
        }
        // Scoped to the caller inside the service: another devotee's endpoint is
        // simply not found, and the answer is the same either way.
        $removed = notifyRemoveDevice($meId, $endpoint);
        sendJson(['ok' => true, 'removed' => $removed]);
    }
}

sendError('Not found', 404);
