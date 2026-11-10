-- Phase 3: card vault, payments, payment state history.

-- Module 4: the card vault. The PAN is stored only as AES-256-GCM ciphertext
-- (pan_encrypted), so a database dump alone reveals no card number. The CVV is
-- never stored anywhere. Everything outside this table refers to the card by
-- its token.
CREATE TABLE cards (
  token          TEXT PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id),
  pan_encrypted  TEXT NOT NULL,
  fingerprint    TEXT NOT NULL,          -- keyed HMAC of the PAN, for "same card?" checks
  brand          TEXT NOT NULL,
  last4          CHAR(4) NOT NULL,
  exp_month      SMALLINT NOT NULL CHECK (exp_month BETWEEN 1 AND 12),
  exp_year       SMALLINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);

CREATE TABLE payments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference              TEXT NOT NULL UNIQUE,
  account_id             UUID NOT NULL REFERENCES accounts(id),
  type                   TEXT NOT NULL CHECK (type IN ('CARD_TOPUP', 'BANK_TRANSFER')),
  amount_kobo            BIGINT NOT NULL CHECK (amount_kobo > 0),
  currency               CHAR(3) NOT NULL DEFAULT 'NGN',
  status                 TEXT NOT NULL DEFAULT 'INITIALIZED'
                         CHECK (status IN ('INITIALIZED', 'PENDING', 'AUTHORIZED', 'COMPLETED', 'FAILED', 'UNKNOWN')),
  bank                   TEXT NOT NULL CHECK (bank IN ('A', 'B')),
  card_token             TEXT REFERENCES cards(token),
  destination_account    TEXT,           -- bank transfers: 10-digit NUBAN
  destination_name       TEXT,           -- from name enquiry
  response_code          TEXT,
  bank_reference         TEXT,
  hold_transaction_id    UUID,           -- bank transfers: wallet -> in-flight hold
  ledger_transaction_id  UUID,           -- the entries that settled the payment
  tsq_attempts           INT NOT NULL DEFAULT 0,
  tsq_next_at            TIMESTAMPTZ,
  tsq_expires_at         TIMESTAMPTZ,
  needs_review           BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (type <> 'CARD_TOPUP' OR card_token IS NOT NULL),
  CHECK (type <> 'BANK_TRANSFER' OR destination_account IS NOT NULL)
);
CREATE INDEX payments_tsq_due ON payments (tsq_next_at) WHERE status = 'UNKNOWN' AND tsq_next_at IS NOT NULL;
CREATE INDEX payments_stale_pending ON payments (updated_at) WHERE status = 'PENDING';
CREATE INDEX payments_account ON payments (account_id, created_at DESC);

CREATE TABLE payment_events (
  id           BIGSERIAL PRIMARY KEY,
  payment_id   UUID NOT NULL REFERENCES payments(id),
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  reason       TEXT,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_events_payment ON payment_events (payment_id, id);

CREATE FUNCTION payment_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_events_no_update_delete
  BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION payment_events_append_only();

-- Second line of defence for Module 2: the database refuses any status change
-- that is not on this list, even from a hand-written UPDATE. Must match
-- TRANSITIONS in src/payments/stateMachine.js.
CREATE FUNCTION payments_status_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'INITIALIZED' AND NEW.status IN ('PENDING', 'FAILED'))
    OR (OLD.status = 'PENDING'     AND NEW.status IN ('AUTHORIZED', 'COMPLETED', 'FAILED', 'UNKNOWN'))
    OR (OLD.status = 'UNKNOWN'     AND NEW.status IN ('AUTHORIZED', 'COMPLETED', 'FAILED'))
    OR (OLD.status = 'AUTHORIZED'  AND NEW.status IN ('COMPLETED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'illegal payment transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payments_status_guard
  BEFORE UPDATE OF status ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_status_guard();

-- System accounts used by payments.
--   CARD_SETTLEMENT      money the card bank owes us for approved top-ups
--   TRANSFERS_IN_FLIGHT  customer money held while a bank transfer is in progress
--   PAYOUT_SETTLEMENT    money we owe the bank for transfers it has paid out
INSERT INTO accounts (type, code) VALUES
  ('SYSTEM', 'CARD_SETTLEMENT'),
  ('SYSTEM', 'TRANSFERS_IN_FLIGHT'),
  ('SYSTEM', 'PAYOUT_SETTLEMENT');
