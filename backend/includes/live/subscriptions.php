<?php

function liveSubscriptionsExist(): bool
{
    static $exists = null;
    if ($exists !== null) return $exists;
    try {
        getDB()->query('SELECT id FROM live_stream_subscriptions LIMIT 0')->closeCursor();
        return $exists = true;
    } catch (Throwable) {
        return $exists = false;
    }
}

function liveSubscriptionToken(int $id): string
{
    return $id . '.' . hash_hmac('sha256', 'live-subscription:' . $id, notifySecret());
}

function liveSubscriptionTokenId(string $token): ?int
{
    if (!preg_match('/^([1-9][0-9]{0,9})\.[a-f0-9]{64}$/D', $token, $match)) return null;
    $id = (int) $match[1];
    return hash_equals(liveSubscriptionToken($id), $token) ? $id : null;
}

function liveSubscriptionUnsubscribeUrl(int $id): string
{
    return siteUrl('/api/live-subscriptions/unsubscribe?token=' . liveSubscriptionToken($id));
}

function liveSubscriptionLoad(int $id): ?array
{
    if (!liveSubscriptionsExist()) return null;
    $stmt = getDB()->prepare(
        'SELECT q.*, s.status, s.notifications_enabled, s.deleted_at, s.scheduled_start_at,
                s.title_ta, s.title_en, s.slug, s.timezone
           FROM live_stream_subscriptions q JOIN live_streams s ON s.id = q.live_stream_id
          WHERE q.id = :id'
    );
    $stmt->execute([':id' => $id]);
    return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
}

function liveSubscriptionDue(array $row, string $now): bool
{
    if ($row['unsubscribed_at'] !== null || $row['deleted_at'] !== null
        || !(int) $row['notifications_enabled']
        || !in_array($row['status'], ['SCHEDULED', 'STARTING', 'LIVE'], true)) return false;
    $start = livePollTs($row['scheduled_start_at']);
    $at = livePollTs($now);
    return $start !== null && $at !== null && $at >= $start - 600 && $at <= $start + 900;
}

function liveSubscriptionRecipient(int $id, string $email, string $start): ?array
{
    $row = liveSubscriptionLoad($id);
    if ($row === null || $row['email'] !== $email || $row['scheduled_start_at'] !== $start
        || !liveSubscriptionDue($row, notifyNow())) return null;
    $recipient = notifyGuestRecipient($email, null, $row['lang']);
    $recipient['consent'] = true;
    return $recipient;
}

function liveSubscribe(PDO $db, string $slug, string $email, string $lang): bool
{
    $db->beginTransaction();
    try {
        $stmt = $db->prepare('SELECT * FROM live_streams WHERE slug = :slug AND deleted_at IS NULL FOR UPDATE');
        $stmt->execute([':slug' => $slug]);
        $stream = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$stream || !(int) $stream['notifications_enabled']
            || !in_array($stream['status'], ['SCHEDULED', 'STARTING'], true)
            || $stream['scheduled_start_at'] === null
            || $stream['scheduled_start_at'] < gmdate('Y-m-d H:i:s', strtotime(notifyNow() . ' UTC') - 900)) {
            $db->rollBack();
            return false;
        }
        $db->prepare(
            'INSERT INTO live_stream_subscriptions (live_stream_id, email, lang, consent_at)
             VALUES (:stream, :email, :lang, :now)
             ON DUPLICATE KEY UPDATE id = id'
        )->execute([':stream' => $stream['id'], ':email' => $email, ':lang' => $lang, ':now' => notifyNow()]);
        $db->commit();
        return true;
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
}

function liveQueueReminders(PDO $db, int $limit = 200, ?array $streamIds = null): int
{
    if (!liveSubscriptionsExist() || !notifyProviderFor('email')->isConfigured()) return 0;
    $now = notifyNow();
    $params = [
        ':earliest' => gmdate('Y-m-d H:i:s', strtotime($now . ' UTC') - 900),
        ':latest' => gmdate('Y-m-d H:i:s', strtotime($now . ' UTC') + 600),
    ];
    $scope = '';
    if ($streamIds !== null) {
        $ids = array_values(array_filter(array_map('intval', $streamIds), static fn(int $id): bool => $id > 0));
        if (!$ids) return 0;
        $scope = ' AND s.id IN (' . implode(',', $ids) . ')';
    }
    $stmt = $db->prepare(
        "SELECT q.id, q.live_stream_id FROM live_stream_subscriptions q
           JOIN live_streams s ON s.id = q.live_stream_id
          WHERE q.unsubscribed_at IS NULL AND s.deleted_at IS NULL AND s.notifications_enabled = 1
            AND s.status IN ('SCHEDULED', 'STARTING', 'LIVE')
            AND s.scheduled_start_at BETWEEN :earliest AND :latest
            AND (q.reminded_start_at IS NULL OR q.reminded_start_at <> s.scheduled_start_at)"
        . $scope . ' ORDER BY s.scheduled_start_at, q.id LIMIT ' . max(1, min(1000, $limit))
    );
    $stmt->execute($params);
    $created = 0;
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $candidate) {
        $db->beginTransaction();
        try {
            $lock = $db->prepare('SELECT id FROM live_streams WHERE id = :id FOR UPDATE');
            $lock->execute([':id' => $candidate['live_stream_id']]);
            $lock->closeCursor();
            $lock = $db->prepare('SELECT id FROM live_stream_subscriptions WHERE id = :id FOR UPDATE');
            $lock->execute([':id' => $candidate['id']]);
            $lock->closeCursor();
            $row = liveSubscriptionLoad((int) $candidate['id']);
            if ($row === null || !liveSubscriptionDue($row, $now)
                || $row['reminded_start_at'] === $row['scheduled_start_at']) {
                $db->commit();
                continue;
            }
            $lang = $row['lang'];
            $title = trim((string) $row['title_' . $lang]) ?: $row['title_' . ($lang === 'en' ? 'ta' : 'en')];
            $result = notifyCreate([
                'event' => 'live.reminder', 'category' => 'live_reminders', 'channels' => ['email'],
                'to_email' => $row['email'], 'lang' => $lang,
                'entity_type' => 'live_subscription', 'entity_id' => (int) $row['id'],
                'vars' => ['scheduledStart' => $row['scheduled_start_at']],
                'dedupe_key' => 'live-reminder:' . $row['id'] . ':' . $row['scheduled_start_at'],
                'title' => $lang === 'ta' ? 'தரிசன நினைவூட்டல்: ' . $title : 'Darshan reminder: ' . $title,
                'body' => $title . "\n" . livePollWhen($row['scheduled_start_at'], $row),
                'cta_url' => '/live-darshan/' . $row['slug'],
                'cta_label' => $lang === 'ta' ? 'தரிசனத்திற்குச் செல்ல' : 'Open darshan',
            ]);
            if (empty($result['id'])) throw new RuntimeException('Reminder could not be queued');
            $db->prepare('UPDATE live_stream_subscriptions SET reminded_start_at = :start WHERE id = :id')
                ->execute([':start' => $row['scheduled_start_at'], ':id' => $row['id']]);
            $db->commit();
            $created++;
        } catch (Throwable $e) {
            if ($db->inTransaction()) $db->rollBack();
            error_log('[live-reminder] ' . liveRedact($e->getMessage()));
        }
    }
    return $created;
}
