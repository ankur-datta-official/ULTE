BEGIN;

CREATE OR REPLACE FUNCTION enforce_broker_idempotency_record_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.adapter_id IS DISTINCT FROM OLD.adapter_id
    OR NEW.environment IS DISTINCT FROM OLD.environment
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.execution_attempt_id IS DISTINCT FROM OLD.execution_attempt_id
    OR NEW.operation IS DISTINCT FROM OLD.operation
    OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
    OR NEW.created_at_ms IS DISTINCT FROM OLD.created_at_ms
  THEN
    RAISE EXCEPTION 'broker idempotency identity is immutable';
  END IF;

  IF NEW.updated_at_ms < OLD.updated_at_ms THEN
    RAISE EXCEPTION 'broker idempotency updated_at_ms cannot move backwards';
  END IF;

  IF OLD.adapter_order_id IS NOT NULL
    AND NEW.adapter_order_id IS DISTINCT FROM OLD.adapter_order_id
  THEN
    RAISE EXCEPTION 'broker adapter_order_id cannot be replaced or removed';
  END IF;

  IF NEW.adapter_order_id IS NOT NULL
    AND (NEW.adapter_order_id = '' OR NEW.adapter_order_id ~ '^[[:space:]]|[[:space:]]$')
  THEN
    RAISE EXCEPTION 'broker adapter_order_id must be canonical';
  END IF;

  IF OLD.status IN ('CONFIRMED', 'REJECTED', 'FAILED_NOT_SUBMITTED') THEN
    RAISE EXCEPTION 'terminal broker idempotency record is immutable';
  END IF;

  IF NEW.status = OLD.status THEN
    IF OLD.status = 'OUTCOME_UNKNOWN'
      AND OLD.adapter_order_id IS NULL
      AND NEW.adapter_order_id IS NOT NULL
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'same-status broker idempotency update has no authorized enrichment';
  END IF;

  IF NOT (
    (OLD.status = 'CLAIMED' AND NEW.status IN
      ('SUBMITTED', 'CONFIRMED', 'REJECTED', 'OUTCOME_UNKNOWN', 'RETRY_AUTHORIZED'))
    OR (OLD.status = 'SUBMITTED' AND NEW.status IN
      ('CONFIRMED', 'REJECTED', 'OUTCOME_UNKNOWN', 'RETRY_AUTHORIZED', 'FAILED_NOT_SUBMITTED'))
    OR (OLD.status = 'OUTCOME_UNKNOWN' AND NEW.status IN
      ('CONFIRMED', 'REJECTED', 'RETRY_AUTHORIZED'))
    OR (OLD.status = 'RETRY_AUTHORIZED' AND NEW.status = 'SUBMITTED')
  ) THEN
    RAISE EXCEPTION 'illegal broker idempotency status transition: % -> %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
