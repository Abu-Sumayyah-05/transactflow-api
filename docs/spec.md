# TransactFlow: Full-Stack Build Spec

Nov 9, 2026 · Ahmad Subair. Transcribed from the owner's PDF on 11 Nov 2026 so every session can read it.

## Goal

TransactFlow is a full-stack payment platform where customers pay and transfer money and an operations team monitors, reconciles and blocks risky activity. Its backend implements the main idea from every module of the fintech course (Modules 1 to 11), built on the existing Node.js/Express capstone.

Success means a recruiter can open the live site and watch the hard problems of payments get handled:

- A double-tapped Pay button charges once, not twice.
- A gateway timeout ends in the correct final status, not a guess.
- A failing gateway trips the circuit breaker and traffic moves to a backup.
- A nightly reconciliation report shows classified breaks, not a vague "mismatch".
- Every decline shows a clear reason to the customer.

## The site

Two sides: a customer app with six screens and an admin console with six screens. Both talk to the same backend.

| Screen | Side | What the user sees |
| --- | --- | --- |
| Sign up and login | Customer | Account creation, JWT login, KYC status badge |
| Wallet | Customer | Balance in naira, recent transactions, top-up button |
| Checkout | Customer | Card form (hosted-fields style), 3DS-style challenge step, clear success or decline message |
| Transfer | Customer | Enter recipient, name enquiry shows the account name, confirm, status updates live |
| History | Customer | Every transaction with its state (PENDING, AUTHORIZED, COMPLETED, FAILED) and receipt |
| Payouts | Customer (merchant) | Upload a CSV, see a batch progress bar and a per-item result report |
| Live dashboard | Admin | Success rate, p99 latency, volume, gateway health, circuit-breaker state |
| Fraud queue | Admin | Flagged transactions with the score and the rules that fired, approve or block |
| Reconciliation | Admin | Matched, pending settlement and break counts, with classified breaks to resolve |
| Webhook log | Admin | Each event received, signature valid or not, duplicate or new, retry count |
| Dead-letter queue | Admin | Events that failed repeatedly, with a replay button |
| Simulator controls | Admin | Switches that make the fake bank time out, duplicate webhooks or return 503 |

## Architecture

Node.js/Express, PostgreSQL, Redis and React, with two simulated banks behind a single gateway adapter. Every call to a bank passes through one adapter with a circuit breaker.

- React app (customer and admin sites) → Express API (auth, idempotency keys, state machine, fraud rules, ledger writes)
- Express API → PostgreSQL (payments, ledger, outbox, audit log), Redis (idempotency keys, velocity counters), Gateway adapter (circuit breaker, retry with backoff, fallback)
- Gateway adapter → Mock Bank A (primary), Mock Bank B (fallback). Both banks are simulators we control and send webhooks back to the Express API.
- Worker (outbox relay, webhook delivery, recon job) reads the outbox in PostgreSQL.

The API writes payments and ledger entries to PostgreSQL in one transaction and keeps idempotency keys and velocity counters in Redis. The worker sends events from the outbox and runs reconciliation. Balances are never cached.

## Backend features by module

The rule column is what must be implemented exactly.

| Module | Feature | Rule to implement |
| --- | --- | --- |
| 1. Players and rails | Decline classifier | Map each issuer response code to a customer message (insufficient funds, international use disabled, FX limit, suspected fraud, card expired, invalid CVV). Never show a bare "declined". |
| 2. Payment lifecycle | Payment state machine | States INITIALIZED, PENDING, AUTHORIZED, COMPLETED, FAILED. Reject illegal jumps. A timeout stores UNKNOWN and starts a transaction status query (TSQ) job with a TTL, never FAILED. |
| 3. Ledger and recon | Double-entry ledger | Every transaction writes balanced debit and credit entries. Entries are append-only, and mistakes are fixed with reversing entries. Money is stored as integer kobo, never floats. |
| 4. Security | Tokenization and encryption | Store a token for the card, never the PAN or CVV. Encrypt sensitive fields with AES-256 at rest, serve everything over TLS. |
| 5. Checkout | Checkout flow and 3DS-style step | Hosted-field style card form, a challenge step for medium-risk payments, a webhook as the source of truth for the final status. |
| 6. Payouts | Batch disbursement | Pre-send checks (format, duplicate, name enquiry, amount sanity). One idempotency key per item, sub-batches of 100, backpressure, an itemised result report. |
| 7. Async | Idempotency and webhooks | Idempotency-Key header, a stored request hash (same key with a different body returns 409), Redis SETNX with a 24 hour TTL. Webhooks use an HMAC over the raw body, constant-time compare, event-ID dedupe, return 200 on duplicates. Failed events go to a dead-letter queue. |
| 8. Resiliency | Retries and circuit breaker | Retry only 5xx and timeouts, using exponential backoff with full jitter. Breaker is CLOSED, OPEN or HALF-OPEN: opens at 50% failures over 10 seconds, 60 second cooldown, 5 probe requests. While OPEN, fail fast or route to Mock Bank B. Lock the row with SELECT ... FOR UPDATE when changing a balance. |
| 9. Fraud | Rules engine | Score each payment: +20 billing mismatch, +10 free email, +15 new device, -30 account older than 1 year, -20 known address. 0 to 40 approve, 41 to 79 challenge, 80 and above block. Velocity counters in Redis (INCR with a TTL) catch card testing. Disputes move funds through an escrow ledger account. |
| 10. Scale | Performance and observability | Critical path of four steps under 200 ms. Never cache balances. Use the transactional outbox for events. Expose success rate, p99 latency and authorization rate sliced by bank. |
| 11. Reconciliation | Recon engine | Five stages: ingest, normalise, match, classify, resolve and report. Items inside the settlement window are PENDING SETTLEMENT, not breaks. Parse an MT940-style file defensively: log and flag unparseable lines, and halt if opening balance plus transactions does not equal closing balance. Produce the four regulatory-style reports and keep an audit trail. |

## Mock bank simulator

A small separate Express service, run twice as Bank A and Bank B. The admin console flips these modes live and the backend has to cope.

| Mode | What the bank does | What it proves |
| --- | --- | --- |
| Timeout | Processes the payment but never replies | Status becomes UNKNOWN, then the TSQ job finds the real result |
| Slow | Replies after 5 to 10 seconds | Request timeouts and the row lock do not hang the system |
| Error 503 | Returns 503 for a set percentage of calls | Retries with backoff and jitter, then the breaker opens |
| Duplicate webhook | Sends the same event two or three times | Event-ID dedupe processes it once |
| Bad signature | Sends a webhook with a wrong HMAC | Request rejected with 401 and logged |
| Decline codes | Returns each decline code in turn | Classifier shows the right customer message |
| Settlement file | Produces a daily MT940-style file, optionally with a bad line, a missing item or a wrong closing balance | Recon flags breaks and halts on a broken file |
| Late settlement | Leaves late-night items out of today's file | Items show as PENDING SETTLEMENT, not as breaks |

## Data model

PostgreSQL holds ten tables. All money columns are BIGINT in kobo.

| Table | Key columns | Rule |
| --- | --- | --- |
| users | id, email, password_hash, kyc_status, role | role is customer, merchant or admin |
| accounts | id, user_id, currency, balance_kobo | Balance is derived from and checked against ledger_entries |
| payments | id, reference, account_id, amount_kobo, status, bank, created_at | Unique reference, status changes only through the state machine |
| payment_events | id, payment_id, from_status, to_status, at | Append-only history of every state change |
| ledger_entries | id, transaction_id, account_id, direction, amount_kobo, created_at | Append-only. For each transaction_id, debits equal credits |
| idempotency_keys | key, scope, request_hash, response, expires_at | Unique on key plus scope. Mirrors the Redis lock |
| outbox | id, event_type, payload, published_at | Written in the same transaction as the business change |
| webhook_events | event_id, source, signature_valid, status, attempts | Unique event_id for deduplication. Failed ones move to the dead-letter queue |
| fraud_decisions | id, payment_id, score, rules_fired, outcome | Keeps the reason for every decision |
| recon_items | id, reference, internal_amount, gateway_amount, bank_amount, class, resolved_at | class is MATCHED, PENDING_SETTLEMENT, MISSING_FROM_SWITCH, MISSING_FROM_BANK, AMOUNT_MISMATCH or DUPLICATE_POSTING |

## API endpoints

All routes are under `/api/v1`. Every POST that moves money requires an `Idempotency-Key` header.

| Method and path | Purpose | Notes |
| --- | --- | --- |
| POST /auth/register, /auth/login | Create account, get a JWT | Rate limited |
| GET /accounts/me | Balance and recent activity | Reads the database, never a cache |
| POST /payments | Start a card payment | Idempotent. Runs fraud check, then the gateway adapter |
| POST /payments/:id/challenge | Complete the 3DS-style step | Only valid from the PENDING state |
| GET /payments/:id | Status and receipt | Triggers a TSQ check if the status is UNKNOWN |
| POST /transfers | Wallet to wallet or to a bank account | Name enquiry first. Locks both rows, writes balanced ledger entries |
| POST /payouts/batches | Upload a CSV of payouts | Validates, then queues sub-batches of 100 |
| GET /payouts/batches/:id | Batch progress and per-item results | Itemised report |
| POST /webhooks/bank | Receive bank events | Verifies HMAC on the raw body, dedupes by event_id, returns 200 fast |
| GET /admin/metrics | Success rate, p99, authorization rate by bank | Admin only |
| GET /admin/fraud, POST /admin/fraud/:id/decision | Review queue and decisions | Admin only |
| GET /admin/recon/runs, POST /admin/recon/run | Recon results and manual run | Admin only |
| GET /admin/dlq, POST /admin/dlq/:id/replay | Dead-letter queue and replay | Admin only |
| POST /admin/simulator/mode | Set a bank's failure mode | Admin only, calls the simulator |

## Build phases

Build in this order. Do not start a phase until the previous phase's check passes.

1. **Audit.** Read the existing TransactFlow code and write an inventory in the README: what exists, what is missing, what to keep. Check: inventory committed, no new features yet.
2. **Foundation.** PostgreSQL schema and migrations, auth, accounts, integer kobo, the double-entry ledger. Check: a wallet-to-wallet transfer writes balanced entries, and a test proves debits equal credits.
3. **Payment lifecycle.** State machine, Mock Bank A, a basic gateway adapter, the TSQ job. Check: in timeout mode the payment goes to UNKNOWN, then to the bank's real final status.
4. **Idempotency and webhooks.** Idempotency keys in Redis and the database, HMAC verification, event-ID dedupe, dead-letter queue. Check: the same key twice charges once, a changed body returns 409, a duplicate webhook is processed once.
5. **Resiliency.** Retries with backoff and jitter, circuit breaker, Mock Bank B fallback, row locking. Check: in 503 mode the breaker opens and traffic moves to Bank B, and two parallel spends of one balance let only one through.
6. **Fraud and checkout.** Scoring rules, Redis velocity counters, the challenge step, decline classifier, disputes with the escrow ledger account. Check: scores fall in the right bands and a card-testing burst is blocked.
7. **Payouts.** CSV upload, pre-send checks, per-item keys, sub-batches of 100. Check: a 250-item batch runs as 3 sub-batches, and rerunning after a crash pays nobody twice.
8. **Outbox, worker and metrics.** Transactional outbox, the worker, success rate, p99 and authorization rate by bank. Check: kill the app between the database commit and the publish, and the event still goes out after restart.
9. **Reconciliation.** MT940-style parser, five-stage pipeline, timing-aware matching, classified breaks, reports. Check: each simulator settlement mode produces the expected classes, and a wrong closing balance halts the run.
10. **Frontend.** Customer app first, then the admin console, wired to the real API. Check: every screen in the site table works end to end.
11. **Ship.** Seed data, README with the architecture diagram, a 3-minute demo script, a live deployment. Check: a stranger can follow the README and run the demo.

## Tests and definition of done

The project is done when all of these automated tests pass and the live demo works. Each test names the module it protects.

- Ledger: for every transaction, debits equal credits, and balances are integer kobo (Module 3).
- State machine: an illegal transition such as COMPLETED to PENDING is rejected (Module 2).
- Timeout: a payment stuck in UNKNOWN resolves to the bank's real status through TSQ (Module 2).
- Idempotency: the same key and body charges once, the same key with a different body returns 409 (Module 7).
- Webhook: a valid signature is accepted, a bad one gets 401, a duplicate event is processed once (Module 7).
- Retries: 4xx errors are never retried, 5xx errors are retried with backoff and jitter (Module 8).
- Circuit breaker: it opens at 50% failures over 10 seconds, goes HALF-OPEN after 60 seconds, closes after the probes pass and reopens if they fail (Module 8).
- Concurrency: two simultaneous spends of one balance let only one succeed (Module 8).
- Fraud: scores map to approve, challenge and block at the stated thresholds, and a card-testing burst is blocked (Module 9).
- Payouts: a crash and rerun pays no recipient twice (Module 6).
- Outbox: an event is published after a crash between the commit and the publish (Module 10).
- Recon: late items are PENDING SETTLEMENT, not breaks. A bad line is logged and flagged. A wrong closing balance halts the run (Module 11).
- Security: no raw card number or CVV is stored, in logs or in the database (Module 4).

## Rules for Claude Code

These rules apply to every session.

1. The owner, Abu Sumayyah, makes the decisions. Follow this spec, and ask before adding, dropping or changing a feature.
2. Explain every piece of code right after writing it, in plain language, including why it is built that way. The owner is learning from it.
3. Work one build phase at a time. Run that phase's check, show the result, and wait for approval before the next phase.
4. Write the test first for money logic: ledger, idempotency, state machine, concurrency.
5. Money is always integer kobo. Never use floats for amounts.
6. Never store or log a full card number or CVV. Never put secrets in the repo, and use environment variables.
7. Never mark a payment successful because a request was sent. Success comes from a confirmed bank response or a verified webhook.
8. Never delete or edit a ledger entry. Fix mistakes with a reversing entry.
9. Keep commits small, one per feature, with clear messages.
10. If the existing TransactFlow code conflicts with this spec, say so and propose options. Do not silently rewrite it.
