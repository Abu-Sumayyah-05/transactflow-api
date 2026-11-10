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
|---|---|---|
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
|---|---|---|
| Node.js | 24.4.1 | |
| npm | 11.4.2 | |
| PostgreSQL | 17 | `psql` installed locally |
| Redis | not installed | Proposal: run it in Docker from Phase 4 |
| Docker | 29.8 | Available for Redis, and later for running the stack |

### Design note for Phase 10

The owner asked for a well-chosen typeface and a distinctive colour palette, with no system default fonts and no stock "generic" colours. The font pairing and colour tokens will be proposed for approval before any screen is built.
