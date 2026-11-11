# TransactFlow

A full-stack payment platform. Customers pay and transfer money, and an operations team monitors, reconciles and blocks risky activity. The backend covers one main idea from each of Modules 1 to 11 of the fintech course.

The build follows the *TransactFlow: Full-Stack Build Spec* (9 Nov 2026) in 11 phases. Each phase starts only after the previous phase's check passes and the owner approves.

## Phase 1: Audit (inventory)

**Date:** 10 Nov 2026

### What exists

Nothing. The spec assumes an existing Node.js/Express capstone, but the project folder was empty and not under version control when the audit ran. The owner chose to start fresh here rather than import older code.

### What to keep

Nothing to carry over. Every component is built new, so none of it can conflict with the spec (spec rule 10).

### What is missing (everything, by phase)

| Phase | Component | Status |
| --- | --- | --- |
| 2 | PostgreSQL schema and migrations (10 tables, money as BIGINT kobo), auth (JWT), accounts, double-entry ledger | Missing |
| 3 | Payment state machine, Mock Bank A, gateway adapter, TSQ job | Missing |
| 4 | Idempotency keys (Redis + DB), webhook HMAC, event-ID dedupe, dead-letter queue | Missing |
| 5 | Retries with backoff and jitter, circuit breaker, Mock Bank B fallback, row locking | Missing |
| 6 | Fraud scoring, Redis velocity counters, 3DS-style challenge, decline classifier, disputes and escrow | Missing |
| 7 | Payout CSV upload, pre-send checks, per-item keys, sub-batches of 100 | Missing |
| 8 | Transactional outbox, worker, metrics (success rate, p99, auth rate by bank) | Missing |
| 9 | MT940-style parser, five-stage recon pipeline, classified breaks, reports | Missing |
| 10 | React customer app (6 screens) and admin console (6 screens) | Missing |
| 11 | Seed data, architecture diagram, demo script, live deployment | Missing |

### Development environment found

| Tool | Version | Note |
| --- | --- | --- |
| Node.js | 24.4.1 | |
| npm | 11.4.2 | |
| PostgreSQL | 17 | `psql` installed locally; the project uses Postgres 16 in Docker instead |
| Redis | not installed | Proposal: run it in Docker from Phase 4 |
| Docker | 29.8 | Available for Redis, and later for running the stack |

## Running locally

```bash
cp .env.example .env        # then fill in POSTGRES_PASSWORD, the two URLs and JWT_SECRET
npm install
npm run db:up               # Postgres 16 (port 5433) and Redis 7 (port 6380) in Docker
npm run migrate             # applies src/db/migrations/*.sql
npm test                    # resets transactflow_test and runs every test
npm run bank:a              # Mock Bank A on http://localhost:5001 (separate terminal)
npm run dev                 # API on http://localhost:4000
```

Mock bank modes are switched live with `POST /_sim/mode` on the bank (header `x-sim-token: $SIM_TOKEN`), for example `{"mode":"timeout"}`, `{"mode":"error503","errorRate":0.5}` or `{"outcome":"DECLINED","declineCode":"51"}`. Webhook behaviour is part of the same mode: `{"webhook":"duplicate","webhookCopies":3}`, `{"webhook":"bad_signature"}` or `{"webhook":"off"}`. `{"outcome":"DECLINE_CYCLE"}` declines with each code in turn (51, 57, 61, 59, 54, 82), and `POST /_sim/disputes {"reference":"TF-..."}` raises a chargeback for an approved charge. The admin console wraps this in Phase 10.

## Progress

| Phase | Status | Check |
| --- | --- | --- |
| 1. Audit | Done | Inventory committed |
| 2. Foundation | Done | Wallet-to-wallet transfer writes balanced entries; 34 tests pass, including the debits-equal-credits invariant |
| 2b. Idempotency on transfers (owner request) | Done | Same key twice moves money once; different body returns 409 |
| 3. Payment lifecycle (+ card vault, bank transfers) | Done | Timeout mode: payment goes UNKNOWN, then TSQ moves it to the bank's real status; 92 tests pass |
| 4. Idempotency and webhooks | Done | Same key twice charges once; changed body returns 409; duplicate webhook processed once; 111 tests pass |
| 5. Resilience | Done | 503 mode opens Bank A's breaker and card traffic moves to Bank B; two simultaneous spends of one balance let only one through; 152 tests pass |
| 6. Fraud and checkout | Awaiting approval | Scores land in the right bands at every edge (0/40/41/79/80); an 8-attempt card-testing burst lets exactly 5 through and blocks 3, none of which reach a bank; 226 tests pass |

### Design note for Phase 10

The owner asked for a well-chosen typeface and a distinctive colour palette, with no system default fonts and no stock "generic" colours. The font pairing and colour tokens will be proposed for approval before any screen is built.
