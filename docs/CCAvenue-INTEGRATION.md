# CCAvenue integration

Operational guide for online donations and seva payments through CCAvenue's
hosted (non-seamless) checkout. The design contract, with every status,
transition and field, is `docs/payments/SPEC.md`; `README.md` → *Online
payments (CCAvenue)* is the admin-facing walk-through. This page is the
order of work for taking the gateway from *off* to PRODUCTION safely, and what
to check when something looks wrong.

Needs migrations `007_notifications.sql` and `010_payments.sql`. Payments are
**off** until an owner turns them on.

## How a payment flows

```
/donate form ──POST /api/payments/donations──▶ validate, create donations row (INITIATED)
                                              + payment_transactions attempt, amount from DB
             ◀── {url, fields: encRequest, access_code} ── ccavCheckoutFields()
browser auto-posts the hidden form ─────────▶ CCAvenue hosted page (cards/UPI/netbanking)
CCAvenue ── POST encResp ──▶ /api/payments/ccavenue/response | /cancel (browser)
         ── POST encResp ──▶ /api/payments/ccavenue/notify   (server-to-server, DEN)
payHandleGatewayResponse(): decrypt → find attempt FOR UPDATE → check currency,
  amount, merchant params → map order_status → (SUCCESS only) confirm with
  orderStatusTracker → payStateApply() → receipt number → commit → queue email/SMS/WhatsApp
browser ── 303 ──▶ /payment/result?ref=DON-…&t=<token>  →  /payment/receipt (printable, QR verify)
bin/payments_cron.php every 10 min: re-verify callback-only successes, close stale
  INITIATED attempts, expire unpaid seva holds, reconciliation sweep
```

Attempt statuses: `INITIATED → PENDING | SUCCESS | FAILED | CANCELLED`
(`FAILED`/`CANCELLED → SUCCESS` only from a verified status-API answer).
Payable (donation / booking) statuses add `REFUND_INITIATED`,
`PARTIALLY_REFUNDED`, `REFUNDED`. The brief's `CREATED` is `INITIATED` here.

## Security properties (what the tests assert)

- **Credentials never leave PHP.** Working keys and API codes exist only in
  PHP memory; `access_code` is the one value in the browser form and CCAvenue
  designs it to be public. Stored credentials are libsodium-encrypted under
  `PAYMENTS_SETTINGS_KEY`; environment values override stored ones.
- **The browser never sets the amount.** The encrypted request is built from
  the stored payable; a tampered response amount or currency parks the attempt
  as `PENDING` + `needs_review`, never `SUCCESS`.
- **The redirect is not trusted on its own.** Every response is decrypted
  server-side (AES-128-CBC, MD5 working key, fixed IV — the CCAvenue kit),
  matched to an attempt by `order_id`, checked, and a `Success` is confirmed
  with `orderStatusTracker` when the API is configured (`verification =
  status_api`); if the API is unreachable the callback stands
  (`verification = callback`) and the cron re-verifies.
- **Idempotent.** `order_id` and `tracking_id` are unique, the attempt row is
  locked `FOR UPDATE`, the transition table allows exactly one `SUCCESS`, one
  receipt number (`payment_counters`, gap-free per environment), one
  `payment.succeeded` notification (deduped by order id). A replayed response
  answers the same 303 and writes `response_duplicate`. A donor who pays
  twice gets one receipt; the second attempt is flagged `double_payment` for
  refund.
- **No card data.** Only allow-listed response keys are stored; `payRedact()`
  drops anything matching key/secret/token/card/cvv. Receipts mask the donor's
  income-tax PAN.
- **Every step is audited** in `payment_audit_log` (`attempt_created`,
  `redirect_issued`, `response_received`, `response_mismatch`,
  `verification_ok|disagrees|unavailable`, `status_changed`, `refund_*`, …).
- Public payment endpoints set no cookies, send `Cache-Control: no-store`, and
  reads by number require the access token issued with the 303.

## Environments and modes

| Mode | Credentials | Allowed where | Receipt series |
| --- | --- | --- | --- |
| SIMULATOR | built-in (`9999999` / `SIMULATORACCESS`) | only with `PAYMENTS_ALLOW_SIMULATOR=1` — local and CI; the routes 404 without it | `SIM-…` |
| TEST | `CCAVENUE_TEST_*` or stored from the admin | staging (and local against CCAvenue's test host) | `TEST-…` |
| PRODUCTION | `CCAVENUE_*` or stored from the admin, plus `PAYMENTS_SECRET` | production only | `TMR-YYYY-NNNNNN` |

The admin refuses to switch to PRODUCTION until credentials and
`PAYMENTS_SECRET` are present, the three return URLs are `https`, and the
*lifecycle passed testing* box is ticked. TEST and SIMULATOR payments print
"no real money" on the receipt and never touch the production receipt
counter.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `CCAVENUE_MERCHANT_ID` `CCAVENUE_ACCESS_CODE` `CCAVENUE_WORKING_KEY` | PRODUCTION checkout credentials (or store them from Admin → Payment Gateway) |
| `CCAVENUE_TEST_MERCHANT_ID` `CCAVENUE_TEST_ACCESS_CODE` `CCAVENUE_TEST_WORKING_KEY` | TEST credentials |
| `CCAVENUE_API_ACCESS_CODE` `CCAVENUE_API_WORKING_KEY` (`CCAVENUE_TEST_API_*`) | only if CCAvenue issued a separate pair for `orderStatusTracker` / `refundOrder` |
| `CCAVENUE_REDIRECT_URL` `CCAVENUE_CANCEL_URL` `CCAVENUE_NOTIFY_URL` | overrides; normally built from `SITE_URL` |
| `PAYMENTS_SECRET` | ≥ 32 random chars; signs result/receipt/QR links. Required for PRODUCTION. `php -r "echo bin2hex(random_bytes(24));"` |
| `PAYMENTS_SETTINGS_KEY` | base64 of 32 random bytes; encrypts credentials stored from the admin. `php -r "echo base64_encode(random_bytes(32));"` — back it up: without it stored credentials are unreadable |
| `PAYMENTS_CRON_KEY` | ≥ 24 chars; enables `GET /api/payments-cron` for hosts without CLI cron |
| `PAYMENTS_ALLOW_SIMULATOR` | `1` enables SIMULATOR mode. **Never on staging or production.** |
| `CCAVENUE_TRANSACTION_URL` `CCAVENUE_API_URL` `PAYMENTS_SIMULATOR_KEY` `PAYMENTS_SETTINGS_OVERLAY` | test-suite hooks; ignored in PRODUCTION |

All annotated in `backend/.env.example`. Never commit real values; set them in
hPanel (`DEPLOYMENT.md`).

### URLs to register with CCAvenue (per environment)

Admin → Payment Gateway → *CCAvenue dashboard values* shows them ready to copy.

| CCAvenue setting | Address |
| --- | --- |
| Redirect URL | `https://<domain>/api/payments/ccavenue/response` |
| Cancel URL | `https://<domain>/api/payments/ccavenue/cancel` |
| Dynamic Event Notification (DEN) | `https://<domain>/api/payments/ccavenue/notify` |

`https`, ≤ 100 characters, built from `SITE_URL`. Staging registers its own
three under the TEST account.

### IP allowlisting

`orderStatusTracker` and `refundOrder` only answer allowlisted server IPs,
separately for TEST and PRODUCTION. Ask CCAvenue to allowlist the site's
outbound public IP (on Hostinger: hPanel → Hosting → Details, or
`curl -s https://api.ipify.org` over SSH; shared plans may rotate it — ask
Hostinger for the stable egress address). Until then: *Test connection*
reports error 51407, successes are recorded on the callback alone and
re-checked by the cron, and refunds must be made in the CCAvenue dashboard
and recorded as manual.

## Going live — the order of work

1. **Local**: `PAYMENTS_ALLOW_SIMULATOR=1`, mode SIMULATOR, run
   `node tests/payments-api.mjs && node tests/payments-ui.mjs`
   (E2E-029…037, brief §31 cases with the simulator's Pay / Decline / Cancel /
   Awaited / Tamper amount / Wrong currency buttons).
2. **Staging, TEST mode**: set `PAYMENTS_SETTINGS_KEY`, `PAYMENTS_CRON_KEY`,
   `NOTIFY_CRON_KEY`, `MAIL_TRANSPORT=smtp`; store TEST credentials; register
   the three staging URLs under the TEST account; ask for the API allowlist;
   *Test connection* must pass. Then walk `docs/payments/SPEC.md` §14 with
   CCAvenue's test instruments — the ones a simulator cannot stand in for:
   - success (UPI, debit, credit, net banking), failure, cancel/abort
   - refresh and back button after payment, double click on Pay
   - duplicate callback (re-POST the captured `encResp` with curl → same 303,
     `response_duplicate`, counters unchanged)
   - invalid / tampered `encResp` → `response_undecryptable`, result page
     `state=unknown`, no state change
   - wrong amount (edit the form field before submit) → CCAvenue rejects or
     the response mismatches → `PENDING` + review, never `SUCCESS`
   - expired session / network drop between gateway and return → the cron
     closes or verifies the attempt within 10 minutes
   - receipt, email, SMS/WhatsApp, full and partial refund, reconciliation
     upload of the dashboard CSV
   Record each in `docs/DEFECTS.md` if it misbehaves. Items that need
   CCAvenue's confirmation (URL-encoding of response values, `encResp` on
   cancel, Tamil in `billing_name`, API host/version, refund window) are
   listed in SPEC §14 — get them in writing.
3. **Production**: store PRODUCTION credentials, set `PAYMENTS_SECRET`,
   register the production URLs, allowlist the production egress IP, switch
   the mode, then make one real small donation and refund it. Confirm the
   receipt email, the `TMR-` number and the entry in Admin → Online Payments.

## Operations

- **Cron**: `*/10 * * * * php public_html/bin/payments_cron.php` (or
  `GET /api/payments-cron` with `X-Cron-Key`). It re-verifies callback-only
  successes, expires stale attempts and seva holds, and runs the reconciliation
  sweep under `GET_LOCK('temple_payments_cron')`.
- **Admin → Online Payments**: KPIs, transactions with CSV export, per-payment
  detail with *Check with CCAvenue now*, *Resend receipt*, *Mark reviewed*;
  Refunds (owner/finance); Reconciliation — paid there but not here, paid here
  without confirmation, needs review, duplicate callbacks, double payments,
  refund mismatches, stale attempts, and the dashboard CSV comparison.
- **Needs review** rows are the ones to look at daily: they are the amount /
  currency mismatches, wrong-environment keys, tracking-id conflicts and
  API disagreements. Nothing in that state is ever shown to a donor as paid.
- **Roles**: `payments.view` everyone, `payments.manage` finance/editor/admin/owner,
  `payments.refund` finance/admin/owner, `payments.settings` owner only.

## Troubleshooting

| Symptom | Look at |
| --- | --- |
| Checkout button says payments are unavailable | mode is off, or TEST/PRODUCTION credentials missing for the current mode (Admin → Payment Gateway) |
| Donor returns to `state=unknown` | `payment_audit_log` `response_undecryptable` (wrong working key or environment) or `response_unknown_order` |
| Success but `verification = callback` for a long time | API not allowlisted (51407) — see IP allowlisting; the cron keeps retrying |
| Receipt email never arrives | `notify_worker.php` not scheduled, or `MAIL_TRANSPORT` blank (messages go to `backend/logs/mail.log`) |
| *Test connection* fails with 51407 | server IP not allowlisted for that environment |
| Two payments for one donation | expected `double_payment` flag; refund the extra attempt from Reconciliation |

## What remains untested with real money

Everything above the simulator line has been exercised only against the
simulator and a mocked TEST host (`CCAVENUE_TRANSACTION_URL`). Real TEST
credentials, real settlement, real refunds, SMS DLT and WhatsApp templates,
and the CCAvenue dashboard export headers are outstanding until staging is
connected to a CCAvenue test account (`GAP-ANALYSIS.md`, `DEPLOYMENT.md` →
*Staging validation*).
