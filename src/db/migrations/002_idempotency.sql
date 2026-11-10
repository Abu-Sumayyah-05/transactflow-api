-- Module 7: idempotency keys. One row per (key, scope). The scope includes the
-- user and the route, so two customers can never collide on a key.
CREATE TABLE idempotency_keys (
  key            TEXT NOT NULL,
  scope          TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response_code  INT,
  response       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (key, scope)
);
CREATE INDEX idempotency_keys_expiry ON idempotency_keys (expires_at);
