-- Phase 9: reconciliation (Module 11).

-- What the bank itself said it moved when it answered us (API response,
-- TSQ or webhook). This is the "gateway" side of the three-way match:
--   internal_amount  what our ledger recorded
--   gateway_amount   what the bank told us online, at the time
--   bank_amount      what the bank's settlement file says, at end of day
ALTER TABLE payments ADD COLUMN gateway_amount_kobo BIGINT;

-- One row per reconciliation run (one bank, one settlement file).
--   RUNNING -> COMPLETED
--           -> HALTED    the file failed the balance check or had no balances;
--                        nothing in it was used
--           -> SKIPPED   this exact statement was already reconciled
--           -> FAILED    the file could not be fetched
CREATE TABLE recon_runs (
  id              BIGSERIAL PRIMARY KEY,
  bank            TEXT NOT NULL CHECK (bank IN ('A', 'B')),
  status          TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'HALTED', 'SKIPPED', 'FAILED')),
  trigger         TEXT NOT NULL CHECK (trigger IN ('MANUAL', 'SCHEDULED')),
  started_by      UUID REFERENCES users(id),
  statement_ref   TEXT,
  statement_date  DATE,
  cutoff          TIMESTAMPTZ,
  file_sha256     TEXT,
  raw_file        TEXT,                 -- the file exactly as received, for audit
  opening_kobo    BIGINT,
  closing_kobo    BIGINT,
  entries_count   INT,
  flagged_lines   JSONB NOT NULL DEFAULT '[]',
  halt_reason     TEXT,
  counts          JSONB,                -- items per class at the end of the run
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);
CREATE INDEX recon_runs_recent ON recon_runs (id DESC);
CREATE INDEX recon_runs_statement ON recon_runs (bank, statement_ref) WHERE status = 'COMPLETED';

-- One row per (bank, reference), kept across runs: an item that is
-- PENDING_SETTLEMENT tonight becomes MATCHED when tomorrow's file has it.
CREATE TABLE recon_items (
  id               BIGSERIAL PRIMARY KEY,
  bank             TEXT NOT NULL,
  reference        TEXT NOT NULL,
  payment_id       UUID REFERENCES payments(id),
  internal_amount  BIGINT,
  gateway_amount   BIGINT,
  bank_amount      BIGINT,
  class            TEXT NOT NULL CHECK (class IN ('MATCHED', 'PENDING_SETTLEMENT', 'MISSING_FROM_SWITCH',
                                                  'MISSING_FROM_BANK', 'AMOUNT_MISMATCH', 'DUPLICATE_POSTING')),
  detail           TEXT,                -- why, in words
  statement_ref    TEXT,                -- the statement the bank's entry was in
  first_run_id     BIGINT NOT NULL REFERENCES recon_runs(id),
  last_run_id      BIGINT NOT NULL REFERENCES recon_runs(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ,
  resolved_by      UUID REFERENCES users(id),
  resolution_note  TEXT,
  UNIQUE (bank, reference)
);
CREATE INDEX recon_items_open ON recon_items (class, created_at)
  WHERE resolved_at IS NULL AND class <> 'MATCHED';
CREATE INDEX recon_items_run ON recon_items (last_run_id);

-- Audit trail: who or what did what, and when. Append-only.
CREATE TABLE recon_audit (
  id       BIGSERIAL PRIMARY KEY,
  run_id   BIGINT REFERENCES recon_runs(id),
  item_id  BIGINT REFERENCES recon_items(id),
  action   TEXT NOT NULL,
  detail   JSONB NOT NULL DEFAULT '{}',
  actor    UUID REFERENCES users(id),   -- NULL = the system
  at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX recon_audit_run ON recon_audit (run_id, id);
CREATE INDEX recon_audit_item ON recon_audit (item_id, id);

CREATE FUNCTION recon_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'recon_audit is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER recon_audit_no_update_delete
  BEFORE UPDATE OR DELETE ON recon_audit
  FOR EACH ROW EXECUTE FUNCTION recon_audit_append_only();
