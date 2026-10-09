BEGIN;

ALTER TABLE orchestration_recovery_state
  ADD COLUMN terminal_non_submission_disposition_ref TEXT;
ALTER TABLE orchestration_recovery_state
  DROP CONSTRAINT orchestration_recovery_state_schema_version_check;
ALTER TABLE orchestration_recovery_state
  ADD CONSTRAINT orchestration_recovery_state_schema_version_check
  CHECK (schema_version IN ('ORCHESTRATION_RECOVERY_RECORD_V1', 'ORCHESTRATION_RECOVERY_RECORD_V2')),
  ADD CONSTRAINT orchestration_recovery_terminal_version_check
  CHECK ((schema_version = 'ORCHESTRATION_RECOVERY_RECORD_V1' AND terminal_non_submission_disposition_ref IS NULL)
    OR (schema_version = 'ORCHESTRATION_RECOVERY_RECORD_V2'
      AND terminal_non_submission_disposition_ref IS NOT NULL
      AND execution_authority_checkpoint_ref IS NOT NULL)),
  ADD CONSTRAINT orchestration_recovery_terminal_ref_check
  CHECK (terminal_non_submission_disposition_ref IS NULL OR
    (terminal_non_submission_disposition_ref <> ''
      AND terminal_non_submission_disposition_ref !~ '^[[:space:]]|[[:space:]]$'));

ALTER TABLE orchestration_pending_effect
  RENAME COLUMN resolved_outcome_key TO resolved_authority_ref;
ALTER TABLE orchestration_pending_effect ADD COLUMN resolution_kind TEXT;
UPDATE orchestration_pending_effect SET resolution_kind = 'EXTERNAL_OUTCOME' WHERE state = 'RESOLVED';
DO $$
DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'orchestration_pending_effect'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%resolved_authority_ref%'
  LOOP
    EXECUTE format('ALTER TABLE orchestration_pending_effect DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END;
$$;
ALTER TABLE orchestration_pending_effect
  DROP CONSTRAINT orchestration_pending_effect_schema_version_check;
ALTER TABLE orchestration_pending_effect
  ADD CONSTRAINT orchestration_pending_effect_schema_version_check
  CHECK (schema_version IN ('ORCHESTRATION_PENDING_EFFECT_V1', 'ORCHESTRATION_PENDING_EFFECT_V2')),
  ADD CONSTRAINT orchestration_pending_resolution_check CHECK (
    (state = 'PENDING' AND resolution_kind IS NULL AND resolved_authority_ref IS NULL
      AND resolved_revision IS NULL AND resolved_fence IS NULL)
    OR (state = 'RESOLVED' AND resolution_kind IN ('EXTERNAL_OUTCOME', 'TERMINAL_NON_SUBMISSION')
      AND resolved_authority_ref IS NOT NULL AND resolved_revision IS NOT NULL
      AND resolved_fence IS NOT NULL AND resolved_revision >= created_revision)),
  ADD CONSTRAINT orchestration_pending_resolution_ref_check CHECK (
    resolved_authority_ref IS NULL OR
    (resolved_authority_ref <> '' AND resolved_authority_ref !~ '^[[:space:]]|[[:space:]]$')),
  ADD CONSTRAINT orchestration_pending_resolution_version_check CHECK (
    schema_version = 'ORCHESTRATION_PENDING_EFFECT_V2' OR
    resolution_kind IS DISTINCT FROM 'TERMINAL_NON_SUBMISSION'),
  ADD CONSTRAINT orchestration_pending_identity_unique
  UNIQUE (adapter_id, environment, operation, execution_attempt_id, idempotency_key, request_fingerprint),
  ADD CONSTRAINT orchestration_pending_session_identity_unique
  UNIQUE (session_id, adapter_id, environment, operation, execution_attempt_id, idempotency_key, request_fingerprint);

CREATE TABLE orchestration_terminal_non_submission_disposition (
  schema_version TEXT NOT NULL CHECK (schema_version = 'TERMINAL_NON_SUBMISSION_DISPOSITION_RECEIPT_V1'),
  disposition_ref TEXT NOT NULL PRIMARY KEY CHECK (disposition_ref <> '' AND disposition_ref !~ '^[[:space:]]|[[:space:]]$'),
  session_id TEXT NOT NULL UNIQUE REFERENCES orchestration_recovery_state (session_id),
  adapter_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('DRY_RUN', 'SANDBOX')),
  operation TEXT NOT NULL CHECK (operation IN ('ENTRY_SUBMISSION', 'PROTECTION_SUBMISSION', 'ENTRY_CANCELLATION')),
  execution_attempt_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  expected_revision BIGINT NOT NULL CHECK (expected_revision BETWEEN 0 AND 9007199254740990),
  committed_revision BIGINT NOT NULL CHECK (committed_revision BETWEEN 1 AND 9007199254740991),
  committed_fence BIGINT NOT NULL CHECK (committed_fence BETWEEN 1 AND 9007199254740991),
  committing_owner_id TEXT NOT NULL CHECK (committing_owner_id <> '' AND committing_owner_id !~ '^[[:space:]]|[[:space:]]$'),
  unchanged_checkpoint_ref TEXT NOT NULL REFERENCES orchestration_execution_authority_checkpoint (checkpoint_ref),
  source_event_ref TEXT NOT NULL CHECK (source_event_ref <> '' AND source_event_ref !~ '^[[:space:]]|[[:space:]]$'),
  observed_at_ms BIGINT NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 9007199254740991),
  proof_payload JSONB NOT NULL CHECK (jsonb_typeof(proof_payload) = 'object'),
  commit_payload JSONB NOT NULL CHECK (jsonb_typeof(commit_payload) = 'object'),
  UNIQUE (adapter_id, environment, idempotency_key),
  FOREIGN KEY (session_id, adapter_id, environment, operation, execution_attempt_id, idempotency_key, request_fingerprint)
    REFERENCES orchestration_pending_effect
      (session_id, adapter_id, environment, operation, execution_attempt_id, idempotency_key, request_fingerprint),
  CHECK (committed_revision = expected_revision + 1)
);

ALTER TABLE orchestration_recovery_state
  ADD CONSTRAINT orchestration_recovery_terminal_receipt_fk
  FOREIGN KEY (terminal_non_submission_disposition_ref)
  REFERENCES orchestration_terminal_non_submission_disposition (disposition_ref);

CREATE FUNCTION orchestration_terminal_recovery_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.terminal_non_submission_disposition_ref IS NOT NULL THEN
    IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
       OR NEW.terminal_non_submission_disposition_ref IS DISTINCT FROM OLD.terminal_non_submission_disposition_ref
       OR NEW.revision IS DISTINCT FROM OLD.revision
       OR NEW.mode IS DISTINCT FROM OLD.mode OR NEW.instrument_id IS DISTINCT FROM OLD.instrument_id
       OR NEW.execution_authority_checkpoint_ref IS DISTINCT FROM OLD.execution_authority_checkpoint_ref
       OR NEW.execution_attempt_id IS DISTINCT FROM OLD.execution_attempt_id
       OR NEW.execution_plan_id IS DISTINCT FROM OLD.execution_plan_id
       OR NEW.trade_intent_id IS DISTINCT FROM OLD.trade_intent_id
       OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
       OR NEW.execution_instrument_id IS DISTINCT FROM OLD.execution_instrument_id
       OR NEW.risk_basis_checkpoint_ref IS DISTINCT FROM OLD.risk_basis_checkpoint_ref
       OR NEW.latest_r_outcome_ref IS DISTINCT FROM OLD.latest_r_outcome_ref
       OR NEW.session_id IS DISTINCT FROM OLD.session_id
       OR NEW.fence_token <> OLD.fence_token + 1
       OR NOT EXISTS (SELECT 1 FROM orchestration_recovery_lease lease
         WHERE lease.session_id = OLD.session_id AND lease.fence_token = NEW.fence_token)
    THEN
      RAISE EXCEPTION 'terminal recovery state is immutable except lease fence synchronization';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orchestration_terminal_recovery_guard_before_update
BEFORE UPDATE ON orchestration_recovery_state
FOR EACH ROW EXECUTE FUNCTION orchestration_terminal_recovery_guard();

CREATE FUNCTION orchestration_terminal_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'terminal disposition receipt is immutable';
END;
$$;
CREATE TRIGGER orchestration_terminal_receipt_immutable_before_update
BEFORE UPDATE ON orchestration_terminal_non_submission_disposition
FOR EACH ROW EXECUTE FUNCTION orchestration_terminal_receipt_immutable();
CREATE TRIGGER orchestration_terminal_receipt_immutable_before_delete
BEFORE DELETE ON orchestration_terminal_non_submission_disposition
FOR EACH ROW EXECUTE FUNCTION orchestration_terminal_receipt_immutable();

COMMIT;
