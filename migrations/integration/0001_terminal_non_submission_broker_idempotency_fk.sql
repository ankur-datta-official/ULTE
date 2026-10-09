BEGIN;

ALTER TABLE orchestration_terminal_non_submission_disposition
  ADD CONSTRAINT orchestration_terminal_broker_idempotency_fk
  FOREIGN KEY (adapter_id, environment, idempotency_key)
  REFERENCES broker_idempotency_records (adapter_id, environment, idempotency_key);

COMMIT;
