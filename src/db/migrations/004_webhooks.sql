-- Phase 4: webhooks, dead-letter queue, idempotency keys linked to payments.

-- One row per distinct VALID event (deduped on source + event_id), plus one row
-- per rejected delivery so the webhook log shows forged attempts too. Dedupe
-- only counts valid signatures, so an attacker sending a forged event with a
-- real event_id cannot make us ignore the genuine one.
--
-- status: RECEIVED -> PROCESSED
--         RECEIVED -> RETRY -> ... -> DEAD   (DEAD = the dead-letter queue)
--         REJECTED                           (bad signature, never processed)
CREATE TABLE webhook_events (
  id               BIGSERIAL PRIMARY KEY,
  event_id         TEXT,
  source           TEXT NOT NULL,
  event_type       TEXT,
  signature_valid  BOOLEAN NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('RECEIVED', 'RETRY', 'PROCESSED', 'DEAD', 'REJECTED')),
  payload          JSONB,
  raw_body         TEXT,                 -- kept only for rejected deliveries, for forensics
  received_count   INT NOT NULL DEFAULT 1,
  attempts         INT NOT NULL DEFAULT 0,
  last_error       TEXT,
  next_attempt_at  TIMESTAMPTZ,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX webhook_events_dedupe ON webhook_events (source, event_id) WHERE signature_valid;
CREATE INDEX webhook_events_due ON webhook_events (next_attempt_at) WHERE status IN ('RECEIVED', 'RETRY');
CREATE INDEX webhook_events_recent ON webhook_events (id DESC);

-- A key that started a payment points at it, so a retry can always be
-- answered with the payment's live status, even after a crash.
ALTER TABLE idempotency_keys ADD COLUMN payment_id UUID REFERENCES payments(id);
