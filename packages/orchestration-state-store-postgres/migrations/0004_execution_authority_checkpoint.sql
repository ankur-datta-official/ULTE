BEGIN;

CREATE TABLE orchestration_execution_authority_checkpoint (
  schema_version TEXT NOT NULL CHECK (schema_version = 'EXECUTION_AUTHORITY_CHECKPOINT_V1'),
  checkpoint_ref TEXT NOT NULL PRIMARY KEY CHECK (checkpoint_ref <> '' AND checkpoint_ref !~ '^[[:space:]]|[[:space:]]$'),
  evidence_schema_version TEXT NOT NULL CHECK (evidence_schema_version = 'EXECUTION_ATTEMPT_RECOVERY_EVIDENCE_V1'),
  execution_attempt_id TEXT NOT NULL CHECK (execution_attempt_id <> '' AND execution_attempt_id !~ '^[[:space:]]|[[:space:]]$'),
  execution_plan_id TEXT NOT NULL CHECK (execution_plan_id <> '' AND execution_plan_id !~ '^[[:space:]]|[[:space:]]$'),
  trade_intent_id TEXT NOT NULL CHECK (trade_intent_id <> '' AND trade_intent_id !~ '^[[:space:]]|[[:space:]]$'),
  candidate_id TEXT NOT NULL CHECK (candidate_id <> '' AND candidate_id !~ '^[[:space:]]|[[:space:]]$'),
  instrument_id TEXT NOT NULL CHECK (instrument_id <> '' AND instrument_id !~ '^[[:space:]]|[[:space:]]$'),
  evidence_payload JSONB NOT NULL CHECK (jsonb_typeof(evidence_payload) = 'object')
);

COMMIT;
