BEGIN;

CREATE TABLE orchestration_recovery_lease (
  session_id TEXT NOT NULL CHECK (session_id <> '' AND session_id !~ '^[[:space:]]|[[:space:]]$'),
  owner_id TEXT CHECK (owner_id IS NULL OR (owner_id <> '' AND owner_id !~ '^[[:space:]]|[[:space:]]$')),
  fence_token BIGINT NOT NULL CHECK (fence_token BETWEEN 1 AND 9007199254740991),
  expires_at_ms BIGINT CHECK (expires_at_ms IS NULL OR expires_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (session_id),
  CHECK ((owner_id IS NULL) = (expires_at_ms IS NULL))
);

CREATE FUNCTION orchestration_recovery_lease_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fence_token < OLD.fence_token THEN
    RAISE EXCEPTION 'recovery lease fence cannot decrease';
  END IF;
  IF NEW.owner_id IS NOT NULL
     AND (OLD.owner_id IS NULL OR NEW.owner_id IS DISTINCT FROM OLD.owner_id)
     AND NEW.fence_token <= OLD.fence_token THEN
    RAISE EXCEPTION 'new recovery lease owner requires a higher fence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orchestration_recovery_lease_guard_before_update
BEFORE UPDATE ON orchestration_recovery_lease
FOR EACH ROW EXECUTE FUNCTION orchestration_recovery_lease_guard();

COMMIT;
