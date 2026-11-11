-- Phase 8: transactional outbox (Module 10) and latency columns for metrics.

-- An event is INSERTed here in the same transaction as the business change
-- it describes, so the two can never disagree: both commit or neither does.
-- The relay (worker) publishes unpublished rows and stamps published_at.
-- event_id travels with the event; consumers use it to ignore repeats,
-- because delivery is at-least-once.
CREATE TABLE outbox (
  id            BIGSERIAL PRIMARY KEY,
  event_id      UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  event_type    TEXT NOT NULL,
  aggregate_id  TEXT,                     -- what the event is about (payment id, dispute id, ...)
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ,
  attempts      INT NOT NULL DEFAULT 0,
  last_error    TEXT
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
CREATE INDEX outbox_aggregate ON outbox (aggregate_id, id);

-- How long a payment request took: the bank call alone, and the whole
-- request. total_ms - bank_ms is our own "critical path" time.
ALTER TABLE payments ADD COLUMN bank_ms INT, ADD COLUMN total_ms INT;
