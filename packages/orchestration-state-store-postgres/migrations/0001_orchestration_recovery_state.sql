BEGIN;

CREATE TABLE orchestration_recovery_state (
  schema_version TEXT NOT NULL CHECK (schema_version = 'ORCHESTRATION_RECOVERY_RECORD_V1'),
  session_id TEXT NOT NULL CHECK (session_id <> '' AND session_id !~ '^[[:space:]]|[[:space:]]$'),
  revision BIGINT NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  fence_token BIGINT NOT NULL CHECK (fence_token BETWEEN 1 AND 9007199254740991),
  mode TEXT NOT NULL CHECK (mode IN ('DRY_RUN', 'SANDBOX')),
  instrument_id TEXT NOT NULL CHECK (
    instrument_id <> '' AND instrument_id !~ '^[[:space:]]|[[:space:]]$'
    AND instrument_id ~ '^ulte:v1:[^:]+:(SPOT|PERPETUAL|FUTURE|OPTION|CFD|EQUITY|ETF|INDEX):[^:]+$'
  ),
  execution_authority_checkpoint_ref TEXT,
  execution_attempt_id TEXT,
  execution_plan_id TEXT,
  trade_intent_id TEXT,
  candidate_id TEXT,
  execution_instrument_id TEXT,
  risk_basis_checkpoint_ref TEXT,
  latest_r_outcome_ref TEXT,
  PRIMARY KEY (session_id),
  CHECK (
    (execution_authority_checkpoint_ref IS NULL AND execution_attempt_id IS NULL
      AND execution_plan_id IS NULL AND trade_intent_id IS NULL
      AND candidate_id IS NULL AND execution_instrument_id IS NULL)
    OR
    (execution_authority_checkpoint_ref IS NOT NULL AND execution_attempt_id IS NOT NULL
      AND execution_plan_id IS NOT NULL AND trade_intent_id IS NOT NULL
      AND candidate_id IS NOT NULL AND execution_instrument_id IS NOT NULL)
  ),
  CHECK (execution_instrument_id IS NULL OR execution_instrument_id = instrument_id),
  CHECK (risk_basis_checkpoint_ref IS NULL OR execution_authority_checkpoint_ref IS NOT NULL),
  CHECK (latest_r_outcome_ref IS NULL OR
    (execution_authority_checkpoint_ref IS NOT NULL AND risk_basis_checkpoint_ref IS NOT NULL)),
  CHECK (execution_authority_checkpoint_ref IS NULL OR
    (execution_authority_checkpoint_ref <> '' AND execution_authority_checkpoint_ref !~ '^[[:space:]]|[[:space:]]$')),
  CHECK (execution_attempt_id IS NULL OR (execution_attempt_id <> '' AND execution_attempt_id !~ '^[[:space:]]|[[:space:]]$')),
  CHECK (execution_plan_id IS NULL OR (execution_plan_id <> '' AND execution_plan_id !~ '^[[:space:]]|[[:space:]]$')),
  CHECK (trade_intent_id IS NULL OR (trade_intent_id <> '' AND trade_intent_id !~ '^[[:space:]]|[[:space:]]$')),
  CHECK (candidate_id IS NULL OR (candidate_id <> '' AND candidate_id !~ '^[[:space:]]|[[:space:]]$')),
  CHECK (risk_basis_checkpoint_ref IS NULL OR
    (risk_basis_checkpoint_ref <> '' AND risk_basis_checkpoint_ref !~ '^[[:space:]]|[[:space:]]$')),
  CHECK (latest_r_outcome_ref IS NULL OR
    (latest_r_outcome_ref <> '' AND latest_r_outcome_ref !~ '^[[:space:]]|[[:space:]]$'))
);

COMMIT;
