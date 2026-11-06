-- SCRUM-42 (FR-CHK-04, CR-10): a check can also have the state NOT_APPLICABLE.
-- SQLite cannot change a CHECK constraint, so the table is rebuilt and its rows copied.

CREATE TABLE check_results_new (
  id          INTEGER PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  source      TEXT    NOT NULL CHECK (source IN ('VIES', 'BMF', 'HFU', 'FIRMENBUCH', 'GISA')),
  state       TEXT    NOT NULL CHECK (state IN ('VALID', 'INVALID', 'NOT_FOUND', 'UNAVAILABLE', 'NOT_APPLICABLE')),
  details     TEXT,                                      -- JSON returned to the client
  queried_at  TEXT    NOT NULL,
  UNIQUE (request_id, source)
);

INSERT INTO check_results_new (id, request_id, source, state, details, queried_at)
  SELECT id, request_id, source, state, details, queried_at FROM check_results;

DROP TABLE check_results;
ALTER TABLE check_results_new RENAME TO check_results;
