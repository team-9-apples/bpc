-- SCRUM-22 / SCRUM-80: the database itself refuses what the SRS forbids, so no
-- route, script or future change can do it by mistake.
--
-- QS-OBS-01 / QS-OBS-02: the audit log is append-only. Entries can be added,
-- never changed or removed.
--
-- QS-REL-02: a completed request cannot be changed; it can only be deleted as
-- a whole (FR-DOC-07, SCRUM-53). Deleting a request still removes its
-- check_results through ON DELETE CASCADE.
--
-- Note for later migrations: SQLite drops a table's triggers together with the
-- table. A migration that rebuilds audit_log, requests or check_results (like
-- 0006 did) must create these triggers again.

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only (QS-OBS-01)');
END;

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only (QS-OBS-01)');
END;

CREATE TRIGGER requests_completed_no_update
BEFORE UPDATE ON requests
WHEN OLD.status = 'COMPLETED'
BEGIN
  SELECT RAISE(ABORT, 'a completed request cannot be changed (QS-REL-02)');
END;

CREATE TRIGGER check_results_completed_no_insert
BEFORE INSERT ON check_results
WHEN (SELECT status FROM requests WHERE id = NEW.request_id) = 'COMPLETED'
BEGIN
  SELECT RAISE(ABORT, 'a completed request cannot be changed (QS-REL-02)');
END;

CREATE TRIGGER check_results_completed_no_update
BEFORE UPDATE ON check_results
WHEN (SELECT status FROM requests WHERE id = OLD.request_id) = 'COMPLETED'
BEGIN
  SELECT RAISE(ABORT, 'a completed request cannot be changed (QS-REL-02)');
END;

-- Removing single results is refused too. When the whole request is deleted,
-- the cascade runs after the request row is gone, so the subquery finds no
-- COMPLETED request and the results are removed with it.
CREATE TRIGGER check_results_completed_no_delete
BEFORE DELETE ON check_results
WHEN (SELECT status FROM requests WHERE id = OLD.request_id) = 'COMPLETED'
BEGIN
  SELECT RAISE(ABORT, 'a completed request cannot be changed (QS-REL-02)');
END;
