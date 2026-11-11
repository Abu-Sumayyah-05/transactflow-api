-- Phase 6: disputes (card chargebacks) through an escrow ledger account.
--
--   ESCROW          money frozen while a dispute is open. Not the customer's
--                   to spend, not yet given back to the card.
--   DISPUTE_LOSSES  what the platform absorbs when a chargeback is upheld but
--                   the customer had already spent the money.
INSERT INTO accounts (type, code) VALUES ('SYSTEM', 'ESCROW'), ('SYSTEM', 'DISPUTE_LOSSES');

CREATE TABLE disputes (
  id                         BIGSERIAL PRIMARY KEY,
  payment_id                 UUID NOT NULL UNIQUE REFERENCES payments(id),  -- one dispute per charge
  source                     TEXT NOT NULL,           -- the bank that raised it
  event_id                   TEXT,                    -- the webhook that opened it
  reason                     TEXT,
  amount_kobo                BIGINT NOT NULL CHECK (amount_kobo > 0),
  held_kobo                  BIGINT NOT NULL CHECK (held_kobo >= 0),       -- moved wallet -> ESCROW
  shortfall_kobo             BIGINT NOT NULL CHECK (shortfall_kobo >= 0),  -- already spent
  status                     TEXT NOT NULL DEFAULT 'OPEN'
                             CHECK (status IN ('OPEN', 'CUSTOMER_WON', 'MERCHANT_WON')),
  hold_transaction_id        UUID,
  resolution_transaction_id  UUID,
  resolved_by                UUID REFERENCES users(id),
  opened_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at                TIMESTAMPTZ,
  CHECK (held_kobo + shortfall_kobo = amount_kobo),
  CHECK ((status = 'OPEN') = (resolved_at IS NULL))
);
CREATE INDEX disputes_open ON disputes (opened_at DESC) WHERE status = 'OPEN';
