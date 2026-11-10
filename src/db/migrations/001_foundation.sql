-- Phase 2: users, accounts, double-entry ledger.
-- All money is BIGINT kobo. No NUMERIC, no floats.

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL UNIQUE,
  full_name      TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  kyc_status     TEXT NOT NULL DEFAULT 'UNVERIFIED'
                 CHECK (kyc_status IN ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED')),
  role           TEXT NOT NULL DEFAULT 'customer'
                 CHECK (role IN ('customer', 'merchant', 'admin')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- WALLET accounts belong to a user and may never go negative.
-- SYSTEM accounts belong to the platform (FUNDING now, ESCROW in Phase 6) and
-- are the other side of money entering or leaving wallets.
CREATE TABLE accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id),
  type          TEXT NOT NULL CHECK (type IN ('WALLET', 'SYSTEM')),
  code          TEXT UNIQUE,
  currency      CHAR(3) NOT NULL DEFAULT 'NGN',
  balance_kobo  BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (type <> 'WALLET' OR balance_kobo >= 0),
  CHECK ((type = 'WALLET' AND user_id IS NOT NULL AND code IS NULL)
      OR (type = 'SYSTEM' AND user_id IS NULL AND code IS NOT NULL))
);
CREATE UNIQUE INDEX accounts_one_wallet_per_user_currency
  ON accounts (user_id, currency) WHERE type = 'WALLET';

CREATE TABLE ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID NOT NULL,
  account_id      UUID NOT NULL REFERENCES accounts(id),
  direction       TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_kobo     BIGINT NOT NULL CHECK (amount_kobo > 0),
  memo            TEXT,
  reverses        UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_tx ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_account ON ledger_entries (account_id, id DESC);
-- A transaction can be reversed at most once.
CREATE UNIQUE INDEX ledger_entries_one_reversal
  ON ledger_entries (reverses, account_id, direction) WHERE reverses IS NOT NULL;

-- Guard 1: append-only. Any UPDATE or DELETE on a ledger row is an error.
CREATE FUNCTION ledger_entries_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: post a reversing entry instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only();

CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_append_only();

-- Guard 2: balanced. Checked at COMMIT (DEFERRED), once all entries of the
-- transaction are in, so a half-written transaction can never be saved.
CREATE FUNCTION ledger_entries_check_balanced() RETURNS trigger AS $$
DECLARE
  net BIGINT;
  n   INT;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_kobo ELSE -amount_kobo END), 0),
         COUNT(*)
    INTO net, n
    FROM ledger_entries
   WHERE transaction_id = NEW.transaction_id;
  IF net <> 0 OR n < 2 THEN
    RAISE EXCEPTION 'unbalanced ledger transaction % (net % kobo, % entries)',
      NEW.transaction_id, net, n;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_check_balanced();

INSERT INTO accounts (type, code) VALUES ('SYSTEM', 'FUNDING');
