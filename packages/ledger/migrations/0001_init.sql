-- 0001_init: the app's own facts (方案 §08). Applied in one transaction by
-- src/migrations.ts; never edited in place — later changes are new files.

CREATE TABLE tasks (
  task_id          TEXT PRIMARY KEY,
  operation_id     TEXT NOT NULL,
  fingerprint      TEXT NOT NULL,
  type             TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  target_id        TEXT,
  target_revision  INTEGER,
  payload          TEXT NOT NULL,            -- JSON TaskPayload
  payload_hash     TEXT NOT NULL,
  state            TEXT NOT NULL,
  state_reason     TEXT,
  revision         INTEGER NOT NULL,
  deadline         TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX tasks_operation_id ON tasks (operation_id);
CREATE INDEX tasks_created ON tasks (created_at);

-- One row per state change, written in the same transaction as the change.
CREATE TABLE task_audit (
  audit_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES tasks (task_id),
  from_state    TEXT NOT NULL,
  to_state      TEXT NOT NULL,
  from_revision INTEGER NOT NULL,
  to_revision   INTEGER NOT NULL,
  at            TEXT NOT NULL,
  reason        TEXT
);
CREATE INDEX task_audit_task ON task_audit (task_id);

CREATE TABLE approvals (
  approval_id      TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  target_revision  INTEGER NOT NULL,
  draft_revision   INTEGER NOT NULL,
  content_hash     TEXT NOT NULL,
  allowed_action   TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  consumed_at      TEXT
);
CREATE INDEX approvals_task ON approvals (task_id);

CREATE TABLE attempts (
  attempt_id       TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL,
  step_id          TEXT NOT NULL,
  attempt_ordinal  INTEGER NOT NULL,
  request_id       TEXT,                     -- chosen before dispatch, never swapped
  canonical_digest TEXT,
  session_id       TEXT,
  run_id           TEXT,
  snapshot_id      TEXT,
  state            TEXT NOT NULL,
  receipt_id       TEXT,
  receipt          TEXT,                     -- JSON, the platform receipt verbatim
  unknown_reason   TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX attempts_step_ordinal ON attempts (task_id, step_id, attempt_ordinal);
CREATE UNIQUE INDEX attempts_request_id ON attempts (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX attempts_state ON attempts (state);

CREATE TABLE quota_reservations (
  reservation_id TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  action_kind    TEXT NOT NULL,
  policy_day     TEXT NOT NULL,
  intent_id      TEXT NOT NULL,
  state          TEXT NOT NULL,              -- reserved | consumed | released | held
  created_at     TEXT NOT NULL
);
-- One live reservation per intent; a released one may be replaced.
CREATE UNIQUE INDEX quota_live_intent ON quota_reservations (account_id, action_kind, intent_id) WHERE state <> 'released';
CREATE INDEX quota_account_day ON quota_reservations (account_id, action_kind, policy_day);

CREATE TABLE facts (
  fact_id      TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  fact_kind    TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  evidence_ids TEXT NOT NULL,                -- JSON string[]
  observed_at  TEXT NOT NULL,
  confidence   REAL NOT NULL,
  reason       TEXT,
  data         TEXT                          -- JSON object
);
CREATE INDEX facts_task ON facts (task_id);

CREATE TABLE evidence (
  evidence_id     TEXT PRIMARY KEY,
  artifact_id     TEXT,
  local_path      TEXT,
  sha256          TEXT NOT NULL,
  capture_time    TEXT NOT NULL,
  coverage        TEXT NOT NULL,
  crop            TEXT,                      -- JSON {x,y,width,height}
  retention_until TEXT NOT NULL
);

CREATE TABLE outbox (
  event_id     TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  payload      TEXT NOT NULL,                -- JSON object
  state        TEXT NOT NULL,                -- pending | delivered | failed
  retry_at     TEXT
);
CREATE INDEX outbox_state ON outbox (state);

-- Single rows: the bound account and the policy.
CREATE TABLE account (
  singleton    INTEGER PRIMARY KEY CHECK (singleton = 1),
  account_id   TEXT NOT NULL,
  visible_label TEXT NOT NULL,
  evidence_ids TEXT NOT NULL,                -- JSON string[]
  confirmed_at TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  status       TEXT NOT NULL
);

CREATE TABLE policy (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision  INTEGER NOT NULL,
  body      TEXT NOT NULL                    -- JSON Policy without revision
);

-- Keys from the legacy `handled` array. Suppression only: never a task,
-- never a success, no wechatPid, no mode.
CREATE TABLE legacy_suppression (
  key         TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  migrated_at TEXT NOT NULL
);
