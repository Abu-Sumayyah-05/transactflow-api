-- Phase 6: fraud decisions, checkout signals and the 3DS-style challenge.

-- The card's issuing country, read from the BIN when the card is saved, so
-- the billing-mismatch rule never needs the card number again.
ALTER TABLE cards ADD COLUMN issuer_country CHAR(2);

-- A payment that is blocked, or still waiting for its challenge, has not been
-- sent to any bank yet, so it has no bank. Every payment that reached a bank
-- still has one.
ALTER TABLE payments ALTER COLUMN bank DROP NOT NULL;
ALTER TABLE payments ADD CONSTRAINT payments_bank_when_sent
  CHECK (bank IS NOT NULL OR status IN ('INITIALIZED', 'PENDING', 'FAILED'));

ALTER TABLE payments
  -- Signals for the rules. The billing address itself is not stored: only
  -- its country and a keyed hash (enough to ask "seen this address before?").
  ADD COLUMN billing_country       CHAR(2),
  ADD COLUMN billing_address_hash  TEXT,
  ADD COLUMN device_id             TEXT,
  -- Why WE failed a payment that no bank declined (fraud block, challenge
  -- failed or expired). Bank declines keep using response_code.
  ADD COLUMN failure_code          TEXT CHECK (failure_code IN ('FRAUD_BLOCKED', 'CHALLENGE_FAILED', 'CHALLENGE_EXPIRED', 'REVIEW_BLOCKED')),
  -- 3DS-style challenge. REQUIRED while waiting for the customer; PASSED
  -- (right code) or WAIVED (an admin approved it) before it goes to the bank.
  ADD COLUMN challenge_status      TEXT CHECK (challenge_status IN ('REQUIRED', 'PASSED', 'WAIVED', 'FAILED', 'EXPIRED')),
  ADD COLUMN challenge_otp_hash    TEXT,
  ADD COLUMN challenge_expires_at  TIMESTAMPTZ,
  ADD COLUMN challenge_attempts    INT NOT NULL DEFAULT 0;

CREATE INDEX payments_challenge_due ON payments (challenge_expires_at)
  WHERE status = 'PENDING' AND challenge_status = 'REQUIRED';
-- "Has this user completed a payment from this device / this address?"
CREATE INDEX payments_device ON payments (account_id, device_id) WHERE status = 'COMPLETED';
CREATE INDEX payments_billing ON payments (account_id, billing_address_hash) WHERE status = 'COMPLETED';

-- Velocity counters when Redis is down. Mirrors Redis INCR + EXPIRE: one
-- row per counter, bumped by a single upsert, so parallel attempts queue on
-- the row lock and each gets its own count (a SELECT COUNT(*) would let a
-- burst all read the same number).
CREATE UNLOGGED TABLE velocity_counters (
  key         TEXT PRIMARY KEY,
  count       INT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

-- One decision per card payment, with the reason. review_status drives the
-- admin fraud queue:
--   NOT_NEEDED            approved by the rules
--   OPEN                  flagged (challenge or block) and not yet reviewed
--   CLEARED_BY_CHALLENGE  the customer passed the challenge
--   APPROVED / BLOCKED    an admin decided
CREATE TABLE fraud_decisions (
  id             BIGSERIAL PRIMARY KEY,
  payment_id     UUID NOT NULL UNIQUE REFERENCES payments(id),
  score          INT NOT NULL,
  rules_fired    JSONB NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('APPROVE', 'CHALLENGE', 'BLOCK')),
  review_status  TEXT NOT NULL CHECK (review_status IN ('NOT_NEEDED', 'OPEN', 'CLEARED_BY_CHALLENGE', 'APPROVED', 'BLOCKED')),
  reviewed_by    UUID REFERENCES users(id),
  reviewed_at    TIMESTAMPTZ,
  review_note    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fraud_decisions_queue ON fraud_decisions (created_at DESC) WHERE review_status = 'OPEN';
