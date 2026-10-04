BEGIN;

CREATE TABLE orchestration_pending_intent_commit (
  schema_version TEXT NOT NULL CHECK (schema_version = 'ORCHESTRATION_PENDING_INTENT_COMMIT_RECEIPT_V1'),
  adapter_id TEXT NOT NULL CHECK (adapter_id <> '' AND adapter_id !~ '^[[:space:]]|[[:space:]]$'),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key <> '' AND idempotency_key !~ '^[[:space:]]|[[:space:]]$'),
  session_id TEXT NOT NULL CHECK (session_id <> '' AND session_id !~ '^[[:space:]]|[[:space:]]$'),
  expected_revision BIGINT NOT NULL CHECK (expected_revision BETWEEN 0 AND 9007199254740990),
  committed_revision BIGINT NOT NULL CHECK (committed_revision BETWEEN 1 AND 9007199254740991),
  committed_fence BIGINT NOT NULL CHECK (committed_fence BETWEEN 1 AND 9007199254740991),
  committing_owner_id TEXT NOT NULL CHECK (committing_owner_id <> '' AND committing_owner_id !~ '^[[:space:]]|[[:space:]]$'),
  previous_checkpoint_ref TEXT NOT NULL CHECK (previous_checkpoint_ref <> '' AND previous_checkpoint_ref !~ '^[[:space:]]|[[:space:]]$'),
  committed_checkpoint_ref TEXT NOT NULL CHECK (committed_checkpoint_ref <> '' AND committed_checkpoint_ref !~ '^[[:space:]]|[[:space:]]$'),
  commit_payload JSONB NOT NULL CHECK (jsonb_typeof(commit_payload) = 'object'),
  PRIMARY KEY (adapter_id, idempotency_key),
  FOREIGN KEY (adapter_id, idempotency_key) REFERENCES orchestration_pending_effect (adapter_id, idempotency_key),
  FOREIGN KEY (previous_checkpoint_ref) REFERENCES orchestration_execution_authority_checkpoint (checkpoint_ref),
  FOREIGN KEY (committed_checkpoint_ref) REFERENCES orchestration_execution_authority_checkpoint (checkpoint_ref),
  CHECK (committed_revision = expected_revision + 1),
  CHECK (previous_checkpoint_ref <> committed_checkpoint_ref)
);

CREATE TABLE orchestration_external_outcome_adoption (
  schema_version TEXT NOT NULL CHECK (schema_version = 'ORCHESTRATION_EXTERNAL_OUTCOME_ADOPTION_RECEIPT_V1'),
  outcome_key TEXT NOT NULL PRIMARY KEY CHECK (outcome_key <> '' AND outcome_key !~ '^[[:space:]]|[[:space:]]$'),
  session_id TEXT NOT NULL CHECK (session_id <> '' AND session_id !~ '^[[:space:]]|[[:space:]]$'),
  execution_attempt_id TEXT NOT NULL CHECK (execution_attempt_id <> '' AND execution_attempt_id !~ '^[[:space:]]|[[:space:]]$'),
  expected_revision BIGINT NOT NULL CHECK (expected_revision BETWEEN 0 AND 9007199254740990),
  adopted_revision BIGINT NOT NULL CHECK (adopted_revision BETWEEN 1 AND 9007199254740991),
  adopted_fence BIGINT NOT NULL CHECK (adopted_fence BETWEEN 1 AND 9007199254740991),
  adopting_owner_id TEXT NOT NULL CHECK (adopting_owner_id <> '' AND adopting_owner_id !~ '^[[:space:]]|[[:space:]]$'),
  previous_checkpoint_ref TEXT NOT NULL CHECK (previous_checkpoint_ref <> '' AND previous_checkpoint_ref !~ '^[[:space:]]|[[:space:]]$'),
  committed_checkpoint_ref TEXT NOT NULL CHECK (committed_checkpoint_ref <> '' AND committed_checkpoint_ref !~ '^[[:space:]]|[[:space:]]$'),
  commit_payload JSONB NOT NULL CHECK (jsonb_typeof(commit_payload) = 'object'),
  FOREIGN KEY (outcome_key) REFERENCES orchestration_external_outcome (outcome_key),
  FOREIGN KEY (previous_checkpoint_ref) REFERENCES orchestration_execution_authority_checkpoint (checkpoint_ref),
  FOREIGN KEY (committed_checkpoint_ref) REFERENCES orchestration_execution_authority_checkpoint (checkpoint_ref),
  CHECK (adopted_revision = expected_revision + 1),
  CHECK (previous_checkpoint_ref <> committed_checkpoint_ref)
);

COMMIT;
