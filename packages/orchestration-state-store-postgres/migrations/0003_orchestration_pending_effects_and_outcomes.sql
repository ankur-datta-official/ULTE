BEGIN;

CREATE TABLE orchestration_pending_effect (
  schema_version TEXT NOT NULL CHECK (schema_version = 'ORCHESTRATION_PENDING_EFFECT_V1'),
  session_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('DRY_RUN', 'SANDBOX')),
  operation TEXT NOT NULL CHECK (operation IN ('ENTRY_SUBMISSION', 'PROTECTION_SUBMISSION', 'ENTRY_CANCELLATION')),
  execution_attempt_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_revision BIGINT NOT NULL CHECK (created_revision BETWEEN 0 AND 9007199254740991),
  created_fence BIGINT NOT NULL CHECK (created_fence BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'RESOLVED')),
  resolved_outcome_key TEXT,
  resolved_revision BIGINT CHECK (resolved_revision BETWEEN 0 AND 9007199254740991),
  resolved_fence BIGINT CHECK (resolved_fence BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (adapter_id, idempotency_key),
  CHECK (session_id <> '' AND session_id !~ '^[[:space:]]|[[:space:]]$'),
  CHECK (adapter_id <> '' AND adapter_id !~ '^[[:space:]]|[[:space:]]$'),
  CHECK (execution_attempt_id <> '' AND execution_attempt_id !~ '^[[:space:]]|[[:space:]]$'),
  CHECK (idempotency_key <> '' AND idempotency_key !~ '^[[:space:]]|[[:space:]]$'),
  CHECK (request_fingerprint <> '' AND request_fingerprint !~ '^[[:space:]]|[[:space:]]$'),
  CHECK (resolved_outcome_key IS NULL OR
    (resolved_outcome_key <> '' AND resolved_outcome_key !~ '^[[:space:]]|[[:space:]]$')),
  CHECK ((state = 'PENDING' AND resolved_outcome_key IS NULL AND resolved_revision IS NULL AND resolved_fence IS NULL)
    OR (state = 'RESOLVED' AND resolved_outcome_key IS NOT NULL AND resolved_revision IS NOT NULL AND resolved_fence IS NOT NULL
      AND resolved_revision >= created_revision))
);

CREATE INDEX orchestration_pending_effect_unresolved_idx
  ON orchestration_pending_effect (session_id, created_revision, adapter_id, idempotency_key)
  WHERE state = 'PENDING';

CREATE TABLE orchestration_external_outcome (
  schema_version TEXT NOT NULL CHECK (schema_version = 'ORCHESTRATION_EXTERNAL_OUTCOME_V1'),
  outcome_key TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  execution_attempt_id TEXT NOT NULL,
  observed_at_ms BIGINT NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 9007199254740991),
  observed_fence BIGINT NOT NULL CHECK (observed_fence BETWEEN 1 AND 9007199254740991),
  pending_adapter_id TEXT,
  pending_environment TEXT CHECK (pending_environment IN ('DRY_RUN', 'SANDBOX')),
  pending_operation TEXT CHECK (pending_operation IN ('ENTRY_SUBMISSION', 'PROTECTION_SUBMISSION', 'ENTRY_CANCELLATION')),
  pending_execution_attempt_id TEXT,
  pending_idempotency_key TEXT,
  pending_request_fingerprint TEXT,
  observation_kind TEXT NOT NULL CHECK (observation_kind IN ('CANONICAL_EXECUTION_TRANSITION', 'BROKER_DISPOSITION')),
  observation_payload JSONB NOT NULL CHECK (jsonb_typeof(observation_payload) = 'object'),
  CHECK (outcome_key <> '' AND outcome_key !~ '^[[:space:]]|[[:space:]]$'),
  CHECK (session_id <> '' AND session_id !~ '^[[:space:]]|[[:space:]]$'),
  CHECK (execution_attempt_id <> '' AND execution_attempt_id !~ '^[[:space:]]|[[:space:]]$'),
  CHECK ((pending_adapter_id IS NULL AND pending_environment IS NULL AND pending_operation IS NULL
    AND pending_execution_attempt_id IS NULL AND pending_idempotency_key IS NULL AND pending_request_fingerprint IS NULL)
    OR (pending_adapter_id IS NOT NULL AND pending_environment IS NOT NULL AND pending_operation IS NOT NULL
      AND pending_execution_attempt_id IS NOT NULL AND pending_idempotency_key IS NOT NULL AND pending_request_fingerprint IS NOT NULL)),
  CHECK (pending_execution_attempt_id IS NULL OR pending_execution_attempt_id = execution_attempt_id),
  CHECK (observation_kind <> 'BROKER_DISPOSITION' OR pending_adapter_id IS NOT NULL),
  CHECK (pending_adapter_id IS NULL OR (pending_adapter_id <> '' AND pending_adapter_id !~ '^[[:space:]]|[[:space:]]$')),
  CHECK (pending_idempotency_key IS NULL OR (pending_idempotency_key <> '' AND pending_idempotency_key !~ '^[[:space:]]|[[:space:]]$')),
  CHECK (pending_request_fingerprint IS NULL OR (pending_request_fingerprint <> '' AND pending_request_fingerprint !~ '^[[:space:]]|[[:space:]]$'))
);

CREATE INDEX orchestration_external_outcome_execution_idx
  ON orchestration_external_outcome (session_id, execution_attempt_id, observed_at_ms, outcome_key);

COMMIT;
