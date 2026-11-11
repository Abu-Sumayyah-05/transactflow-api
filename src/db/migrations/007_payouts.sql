-- Phase 7: batch payouts (Module 6).
--
-- Money: when a batch is accepted, the total of its valid items moves
--   wallet -> PAYOUTS_RESERVED   (one transaction; refused if the wallet can't cover it)
-- Each item, just before it is sent:
--   PAYOUTS_RESERVED -> TRANSFERS_IN_FLIGHT   (the payment's hold)
-- and then exactly like a single bank transfer: on success
--   TRANSFERS_IN_FLIGHT -> PAYOUT_SETTLEMENT; on failure the hold is reversed and
--   PAYOUTS_RESERVED -> wallet refunds it. An item rejected before sending
--   (name enquiry) is refunded PAYOUTS_RESERVED -> wallet directly.
INSERT INTO accounts (type, code) VALUES ('SYSTEM', 'PAYOUTS_RESERVED');

CREATE TABLE payout_batches (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id             UUID NOT NULL REFERENCES users(id),
  account_id              UUID NOT NULL REFERENCES accounts(id),
  status                  TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'PROCESSING', 'DONE')),
  total_rows              INT NOT NULL CHECK (total_rows > 0),
  valid_rows              INT NOT NULL CHECK (valid_rows >= 0),
  reserved_kobo           BIGINT NOT NULL CHECK (reserved_kobo >= 0),
  reserve_transaction_id  UUID,
  -- One runner works a batch at a time. A runner that crashes simply lets
  -- its lease run out, and the next one carries on where it stopped.
  lease_until             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at            TIMESTAMPTZ
);
CREATE INDEX payout_batches_active ON payout_batches (created_at) WHERE status <> 'DONE';
CREATE INDEX payout_batches_merchant ON payout_batches (merchant_id, created_at DESC);

-- Sub-batches of 100 valid items, run strictly one after another.
CREATE TABLE payout_sub_batches (
  batch_id     UUID NOT NULL REFERENCES payout_batches(id),
  number       INT NOT NULL CHECK (number > 0),
  size         INT NOT NULL CHECK (size BETWEEN 1 AND 100),
  status       TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'DONE')),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  PRIMARY KEY (batch_id, number)
);

-- One row per CSV line. status:
--   REJECTED  failed a pre-send check (at upload, or name enquiry at send); never paid
--   QUEUED    waiting for its sub-batch
--   SENT      has a payment; its outcome is that payment's status
CREATE TABLE payout_items (
  id                      BIGSERIAL PRIMARY KEY,
  batch_id                UUID NOT NULL REFERENCES payout_batches(id),
  merchant_id             UUID NOT NULL REFERENCES users(id),
  row_number              INT NOT NULL,
  sub_batch               INT,                       -- NULL when rejected at upload
  bank                    TEXT,
  account_number          TEXT,
  account_name            TEXT,
  amount_kobo             BIGINT CHECK (amount_kobo > 0),
  reference               TEXT,                      -- the merchant's own ID for the row
  -- The per-item idempotency key. It is also the payment's reference at the
  -- bank, so even a resent request can't pay twice (the bank dedupes on it).
  idempotency_key         TEXT UNIQUE,
  status                  TEXT NOT NULL CHECK (status IN ('QUEUED', 'SENT', 'REJECTED')),
  reason                  TEXT,
  resolved_name           TEXT,                      -- from name enquiry
  payment_id              UUID UNIQUE REFERENCES payments(id),
  release_transaction_id  UUID,                      -- reserve refunded (rejected at send)
  UNIQUE (batch_id, row_number),
  CHECK ((status = 'SENT') = (payment_id IS NOT NULL)),
  CHECK (status = 'REJECTED' OR (sub_batch IS NOT NULL AND idempotency_key IS NOT NULL AND amount_kobo IS NOT NULL))
);
CREATE INDEX payout_items_work ON payout_items (batch_id, sub_batch, row_number) WHERE status = 'QUEUED';
-- Duplicate check across batches: a merchant reference can be paid once.
-- A rejected row never paid anyone, so its reference may be used again.
CREATE UNIQUE INDEX payout_items_merchant_reference ON payout_items (merchant_id, reference) WHERE status <> 'REJECTED';
