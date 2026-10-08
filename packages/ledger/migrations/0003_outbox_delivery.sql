-- 0003_outbox_delivery: delivery bookkeeping for the outbox and the
-- idempotency key the app relies on. One event per (task, revision,
-- payload); a second enqueue of the same triple returns the existing row.
ALTER TABLE outbox ADD COLUMN attempts     INTEGER NOT NULL DEFAULT 0;  -- delivery attempts so far
ALTER TABLE outbox ADD COLUMN last_error   TEXT;                        -- reason of the latest retryable/final failure
ALTER TABLE outbox ADD COLUMN receipt      TEXT;                        -- what the sink acknowledged with
ALTER TABLE outbox ADD COLUMN enqueued_at  TEXT;                        -- NULL for rows written before this migration
ALTER TABLE outbox ADD COLUMN settled_at   TEXT;                        -- delivered / failed at
CREATE UNIQUE INDEX outbox_task_revision_payload ON outbox (task_id, revision, payload_hash);
CREATE INDEX outbox_pending_retry ON outbox (state, retry_at);
