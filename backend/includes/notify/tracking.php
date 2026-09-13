<?php
/**
 * backend/includes/notify/tracking.php — link tracking, open tracking,
 * unsubscribe links, and the rule for which links a notification may carry.
 *
 * NO PII IN URLS. A tracking link must never say who it was sent to: mail
 * scanners, proxies and browser histories all keep URLs. So every link carries
 * an opaque signed token — "c123.<sig>" for a click on delivery 123 — and the
 * server looks up everything else. Tokens do not expire (an email read a year
 * later should still open its link); rotating NOTIFY_SECRET invalidates them all.
 *
 *   token = <kind><id>.<sig>
 *   sig   = base64url(first 12 bytes of HMAC-SHA256(kind . id, notifySecret()))
 */

require_once __DIR__ . '/time.php';

const NOTIFY_TOKEN_KINDS = ['c', 'o', 'u'];
const NOTIFY_TOKEN_RE    = '/^([cou])([0-9]{1,10})\.([A-Za-z0-9_-]{16})$/';

function notifyTokenSig(string $kind, int $id): string
{
    return notifyB64u(substr(hash_hmac('sha256', $kind . $id, notifySecret(), true), 0, 12));
}

/**
 * kind: 'c' click (delivery id), 'o' open (delivery id), 'u' unsubscribe (devotee id).
 *
 * @throws InvalidArgumentException for an unknown kind or an id out of range
 */
function notifyToken(string $kind, int $id): string
{
    if (!in_array($kind, NOTIFY_TOKEN_KINDS, true)) throw new InvalidArgumentException('A token kind is c, o or u.');
    if ($id < 1 || $id > 9999999999) throw new InvalidArgumentException('A token id must be a positive number.');
    return $kind . $id . '.' . notifyTokenSig($kind, $id);
}

/** ['kind' => …, 'id' => int] for a genuine token, null for anything else. */
function notifyTokenVerify(string $token): ?array
{
    if (!preg_match(NOTIFY_TOKEN_RE, $token, $m)) return null;
    $id = (int) $m[2];
    // "c0123" is not the token that was signed for 123; only the canonical form verifies.
    if ($id < 1 || (string) $id !== $m[2]) return null;
    try {
        $expected = notifyTokenSig($m[1], $id);
    } catch (Throwable) {
        return null;
    }
    return hash_equals($expected, $m[3]) ? ['kind' => $m[1], 'id' => $id] : null;
}

/**
 * A link a notification may carry: a site path ("/sevas", never "//host") or an
 * https URL. Anything else — javascript:, data:, plain http, a URL with
 * credentials or whitespace — is null, and the notification simply has no
 * button. Never "repaired": a mangled link that half-works is worse than none.
 */
function notifySafeCtaUrl(?string $url): ?string
{
    if ($url === null) return null;
    $u = trim($url);
    if ($u === '' || strlen($u) > 500) return null;
    if (preg_match('/[\x00-\x20\x7F\\\\]/', $u)) return null;
    if ($u[0] === '/') return str_starts_with($u, '//') ? null : $u;
    if (stripos($u, 'https://') !== 0) return null;
    $p = parse_url($u);
    if (!is_array($p) || strtolower((string) ($p['scheme'] ?? '')) !== 'https' || empty($p['host'])) return null;
    if (isset($p['user']) || isset($p['pass'])) return null; // https://temple.org@evil.example/ reads as the temple
    if (!preg_match('/^[A-Za-z0-9.-]+$/', (string) $p['host'])) return null;
    return $u;
}

/** A safe link made absolute, for places a relative link means nothing (email, push, WhatsApp). */
function notifyAbsoluteUrl(?string $url): ?string
{
    $safe = notifySafeCtaUrl($url);
    if ($safe === null) return null;
    return $safe[0] === '/' ? siteUrl($safe) : $safe;
}

/** The tracked form of a delivery's call-to-action, or null when there is nothing to track. */
function notifyTrackedUrl(int $deliveryId, ?string $target): ?string
{
    if ($target === null || trim($target) === '') return null;
    return siteUrl('/api/n/c/' . notifyToken('c', $deliveryId));
}

function notifyOpenPixelUrl(int $deliveryId): string
{
    return siteUrl('/api/n/o/' . notifyToken('o', $deliveryId));
}

function notifyUnsubscribeUrl(int $devoteeId): string
{
    return siteUrl('/api/n/u/' . notifyToken('u', $devoteeId));
}

function notifyPreferencesUrl(): string
{
    return siteUrl('/account?tab=notifications');
}

/**
 * A devotee (or their mail client) followed a tracked link. Recorded once.
 *
 * In-app: the click is also a read, of both the delivery and the notification.
 * Email: a click proves the message was opened even when the client blocked
 * the tracking pixel, so an unrecorded open is recorded too. Never throws.
 */
function notifyRecordClick(int $deliveryId): void
{
    if ($deliveryId < 1 || !notifyTablesExist()) return;
    try {
        $db  = getDB();
        $now = notifyNow();
        $stmt = $db->prepare('SELECT id, notification_id, channel, status, clicked_at, read_at FROM notification_deliveries WHERE id = :id');
        $stmt->execute([':id' => $deliveryId]);
        $d = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$d) return;

        $upd = $db->prepare('UPDATE notification_deliveries SET clicked_at = :now WHERE id = :id AND clicked_at IS NULL');
        $upd->execute([':now' => $now, ':id' => $deliveryId]);
        if ($upd->rowCount() > 0) notifyDeliveryEvent($deliveryId, 'clicked');

        if ($d['channel'] === 'inapp' || $d['channel'] === 'email') {
            notifyMarkDeliveryRead($deliveryId, $now, $d['channel'] === 'inapp' ? 'read (clicked in the app)' : 'read (link clicked)');
        }
        if ($d['channel'] === 'inapp') {
            $db->prepare('UPDATE notifications SET read_at = :now WHERE id = :n AND read_at IS NULL')
               ->execute([':now' => $now, ':n' => (int) $d['notification_id']]);
        }
    } catch (Throwable $e) {
        error_log('[notify] recording a click failed: ' . $e->getMessage());
    }
}

/** The email's tracking pixel loaded. Only email deliveries have one; recorded once. Never throws. */
function notifyRecordOpen(int $deliveryId): void
{
    if ($deliveryId < 1 || !notifyTablesExist()) return;
    try {
        $stmt = getDB()->prepare('SELECT channel FROM notification_deliveries WHERE id = :id');
        $stmt->execute([':id' => $deliveryId]);
        if ($stmt->fetchColumn() !== 'email') return;
        notifyMarkDeliveryRead($deliveryId, notifyNow(), 'opened');
    } catch (Throwable $e) {
        error_log('[notify] recording an open failed: ' . $e->getMessage());
    }
}

/**
 * Move a delivery to read, once. Only from a state where the message has reached
 * the devotee: an open can never come before a send, and a terminal failure
 * stays what it was.
 */
function notifyMarkDeliveryRead(int $deliveryId, string $at, string $detail): bool
{
    $stmt = getDB()->prepare(
        "UPDATE notification_deliveries
            SET status = 'read', read_at = COALESCE(read_at, :at1), delivered_at = COALESCE(delivered_at, :at2)
          WHERE id = :id AND status IN ('sent', 'delivered')"
    );
    $stmt->execute([':at1' => $at, ':at2' => $at, ':id' => $deliveryId]);
    if ($stmt->rowCount() > 0) {
        notifyDeliveryEvent($deliveryId, 'read', $detail);
        return true;
    }
    return false;
}
