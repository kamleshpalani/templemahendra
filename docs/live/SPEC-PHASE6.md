# Live Darshan — Phase 6: email reminders

`POST /api/live-subscriptions` accepts a public upcoming stream slug, an email,
`lang` (`ta`/`en`), explicit `consent` and the shared `hp_token` honeypot.
It stores one subscription per stream and normalized address in MySQL.
No account, cookie, family registration or in-app bell is created.

The form has attempt/saved IP buckets and a hashed-address daily bucket.
Existing subscriptions return the same success response without exposing IDs,
tokens or subscription state. An unsubscribe is final for that broadcast;
reposting an address cannot restore withdrawn consent.

The existing notification worker queues email reminders from ten minutes before
the scheduled start until fifteen minutes after it. It checks public status,
the stream's notification flag and consent both at queueing and dispatch.
Cancellation, deletion, completion, rescheduling or unsubscribe invalidate a
queued reminder. Each subscription/scheduled-start pair is deduplicated.
Provider retries remain owned by the notification service; stale reminders
expire rather than being delivered hours after the broadcast.

Emails include the stream URL, local scheduled time and an HMAC-signed,
per-subscription unsubscribe link. GET/HEAD only show confirmation; POST
withdraws consent. The link discloses no address and uses no session. Signing
uses the notification service's existing persistent secret. Rotating that
secret invalidates existing links.

Apply migration 013 after 012. Configure notification email and run the existing
notification worker every minute. Without email configuration the public form
returns an unavailable response; it never claims a message was delivered.
Local verification uses the notification test driver, not real email delivery.

Verification covers validation, hidden streams, honeypots, flood buckets,
duplicates, unsubscribe tampering and idempotency, UTC reminder boundaries,
rescheduling, cancellation, delivery-time consent and local provider acceptance.
