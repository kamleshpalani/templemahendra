# Phase 7 — stream-linked donations

The stream Donate action opens `/donate?stream=<saved-slug>`. The donation form
keeps this context through every step, reload and browser Back action, displays
the bilingual stream title, and submits the slug with the existing payment
payload. Visiting plain `/donate` never inherits a previous stream from a draft.
Unavailable streams block checkout; the donor can explicitly choose a general
donation instead. A cancelled, draft, deleted or donations-disabled broadcast
cannot accept a new linked donation.

Migration 014 adds nullable `donations.live_stream_id`, indexed and constrained
to `live_streams`. The server resolves the slug again under a row lock inside
the payable-creation transaction. Attribution stays with the payable through
retries, callbacks and refunds; client IDs and totals are never trusted.
Existing unlinked donations and their APIs keep their contracts.

`GET /api/live-streams/<slug-or-id>/donations` returns `{totals, server_time}`.
Each total has `currency`, a decimal-string `amount`, and integer `count`.
Only online donations whose receipt attempt succeeded in **production** count.
Each payable counts once, successful refunds reduce its amount, and fully
refunded payables contribute nothing. Currencies remain separate. Simulator,
test, pending, failed and cancelled payments never inflate public totals.
No donor names, addresses, references or other individual payment data leave
this endpoint. Hidden/disabled/cancelled streams return 404; missing migration
returns 503. The stream page shows these aggregate totals with an explanatory
label and a retry state, using the existing money formatter.

Install schema plus sorted migrations, including 014. Verify against MySQL 8
using scoped local payment fixtures and the simulator, then record the public
Tamil/English/mobile checkout flow. Simulator acceptance does not verify
CCAvenue settlement.
