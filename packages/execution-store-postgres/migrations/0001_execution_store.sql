BEGIN;

CREATE TABLE broker_idempotency_records (
  adapter_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('DRY_RUN', 'SANDBOX', 'LIVE')),
  idempotency_key TEXT NOT NULL,
  execution_attempt_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (
    operation IN ('ENTRY_SUBMISSION', 'PROTECTION_SUBMISSION', 'ENTRY_CANCELLATION')
  ),
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'CLAIMED',
      'SUBMITTED',
      'CONFIRMED',
      'REJECTED',
      'OUTCOME_UNKNOWN',
      'RETRY_AUTHORIZED',
      'FAILED_NOT_SUBMITTED'
    )
  ),
  created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms >= created_at_ms),
  adapter_order_id TEXT,
  PRIMARY KEY (adapter_id, environment, idempotency_key)
);

CREATE FUNCTION enforce_broker_idempotency_record_update()
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

  RETURN NEW;
END;
$$;

CREATE TRIGGER broker_idempotency_records_guard
BEFORE UPDATE ON broker_idempotency_records
FOR EACH ROW
EXECUTE FUNCTION enforce_broker_idempotency_record_update();

CREATE TABLE broker_audit_events (
  event_id TEXT NOT NULL,
  occurred_at_ms BIGINT NOT NULL CHECK (occurred_at_ms >= 0),
  adapter_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('DRY_RUN', 'SANDBOX', 'LIVE')),
  execution_attempt_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (
    operation IN ('ENTRY_SUBMISSION', 'PROTECTION_SUBMISSION', 'ENTRY_CANCELLATION')
  ),
  idempotency_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN (
      'CLAIMED',
      'SUBMITTED',
      'CONFIRMED',
      'REJECTED',
      'OUTCOME_UNKNOWN',
      'RECONCILIATION_REQUIRED',
      'RECONCILED_ACCEPTED',
      'RECONCILED_REJECTED',
      'RETRY_AUTHORIZED',
      'DO_NOT_RETRY',
      'IDEMPOTENCY_CONFLICT'
    )
  ),
  adapter_order_id TEXT,
  normalized_failure_category TEXT CHECK (
    normalized_failure_category IS NULL
    OR normalized_failure_category IN (
      'AUTHENTICATION',
      'AUTHORIZATION',
      'RATE_LIMIT',
      'NETWORK',
      'TIMEOUT',
      'INVALID_REQUEST',
      'INSUFFICIENT_FUNDS',
      'INSTRUMENT_UNAVAILABLE',
      'MARKET_UNAVAILABLE',
      'ORDER_REJECTED',
      'IDEMPOTENCY_CONFLICT',
      'ADAPTER_UNAVAILABLE',
      'UNKNOWN'
    )
  ),
  PRIMARY KEY (adapter_id, environment, event_id)
);

CREATE FUNCTION reject_broker_audit_event_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'broker audit events are append-only';
END;
$$;

CREATE TRIGGER broker_audit_events_append_only
BEFORE UPDATE OR DELETE ON broker_audit_events
FOR EACH ROW
EXECUTE FUNCTION reject_broker_audit_event_change();

COMMIT;
