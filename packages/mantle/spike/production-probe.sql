-- ADR-0034 handoff task 4: the same statements `cases/d1.ts` runs on local D1, for production D1.
-- The spike never touches a remote resource; run this yourself (a scratch database, not a tenant's):
--   wrangler d1 execute <scratch-db> --remote --file next/spike/production-probe.sql
-- Every statement must succeed, and the two SELECT results must be the ones in the comments.
-- Local D1 (workerd 1.20260903.1) authorizes fts5 and rtree; workerd 1.20260730 refused rtree.

CREATE VIRTUAL TABLE _probe_fts USING fts5(a, tokenize='trigram');
INSERT INTO _probe_fts (a) VALUES ('台北小籠包'), ('hello world');
SELECT rowid FROM _probe_fts WHERE _probe_fts = '"小籠包"';            -- 1 row (rowid 1); a two-character query matches nothing
SELECT bm25(_probe_fts) AS b, snippet(_probe_fts, 0, '[', ']', '..', 5) AS s FROM _probe_fts WHERE _probe_fts = '"hello"'; -- 1 row

CREATE VIRTUAL TABLE _probe_rtree USING rtree(id, minlat, maxlat, minlng, maxlng);
INSERT INTO _probe_rtree VALUES (1, 25.0, 25.0, 121.5, 121.5);
SELECT id FROM _probe_rtree WHERE minlat >= 24.9 AND maxlat <= 25.1;  -- 1 row

SELECT radians(1), sin(1), cos(1), asin(0.5), sqrt(4), atan2(1, 1);
SELECT strftime('%Y', 0, 'unixepoch'), unixepoch('2026-01-01 00:00:00');

CREATE TABLE _probe_assert (op INTEGER, ok INTEGER);
CREATE TRIGGER _probe_assert_t BEFORE INSERT ON _probe_assert BEGIN SELECT RAISE(IGNORE); END;
INSERT INTO _probe_assert SELECT 1, changes() = 1;

DROP TABLE _probe_assert;
DROP TABLE _probe_rtree;
DROP TABLE _probe_fts;
