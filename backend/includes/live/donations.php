<?php

class LiveDonationUnavailable extends RuntimeException
{
}

class LiveDonationsNotReady extends RuntimeException
{
}

function liveDonationsExist(PDO $db): bool
{
    $s = $db->query("SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'live_stream_id'");
    return (int) $s->fetchColumn() === 1;
}

function liveDonationStreamId(PDO $db, string $slug, bool $lock = false): ?int
{
    if (!preg_match('/^[a-z0-9][a-z0-9-]{1,118}$/D', $slug) || !liveTablesExist()) return null;
    $s = $db->prepare("SELECT id FROM live_streams WHERE slug = :slug
        AND deleted_at IS NULL AND donations_enabled = 1
        AND status IN ('SCHEDULED','STARTING','LIVE','COMPLETED','OFFLINE','ERROR')" . ($lock ? ' FOR UPDATE' : ''));
    $s->execute([':slug' => $slug]);
    $id = $s->fetchColumn();
    return $id === false ? null : (int) $id;
}

function liveDonationTotals(PDO $db, int $streamId): array
{
    $receipt = payReceiptAttemptSql();
    $s = $db->prepare("SELECT d.currency, SUM(d.amount - d.amount_refunded) AS amount, COUNT(*) AS count
        FROM donations d
        JOIN {$receipt} r ON r.payable_type = 'donation' AND r.payable_id = d.id
        JOIN payment_transactions p ON p.id = r.receipt_id AND p.status = 'SUCCESS' AND p.environment = 'production'
        WHERE d.live_stream_id = :stream AND d.source = 'online'
          AND d.status IN ('SUCCESS','REFUND_INITIATED','PARTIALLY_REFUNDED')
          AND d.amount > d.amount_refunded
        GROUP BY d.currency ORDER BY d.currency");
    $s->execute([':stream' => $streamId]);
    return array_map(static fn(array $r): array => [
        'currency' => $r['currency'], 'amount' => (string) $r['amount'], 'count' => (int) $r['count'],
    ], $s->fetchAll());
}
