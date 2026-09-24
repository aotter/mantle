CREATE TABLE IF NOT EXISTS _mantle_schedule_runs (
      run_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      schedule_id TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      error_summary TEXT,
      counts TEXT,
      PRIMARY KEY (run_id, attempt)
    );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS _mantle_schedule_runs_recent
      ON _mantle_schedule_runs (started_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS _mantle_schedule_runs_schedule_recent
      ON _mantle_schedule_runs (schedule_id, started_at DESC);
--> statement-breakpoint
INSERT INTO _mantle_schema_tables(name,projection) VALUES ('articles','{"columns":[["body","TEXT","string",false],["coverAssetId","TEXT","string",false],["summary","TEXT","string",false],["title","TEXT","string",false]],"indexes":[]}') ON CONFLICT(name) DO UPDATE SET projection=excluded.projection;
--> statement-breakpoint
INSERT INTO _mantle_managed_runtime_state(id,canonical_version) VALUES (1,(SELECT CASE WHEN canonical_version='0006-managed-runtime-version' THEN '0007-schedule-run-observations' ELSE NULL END FROM _mantle_managed_runtime_state WHERE id=1)) ON CONFLICT(id) DO UPDATE SET canonical_version=excluded.canonical_version;
--> statement-breakpoint
INSERT INTO _mantle_storage_state(id,fingerprint) VALUES (1,(SELECT CASE WHEN fingerprint='9ef85f9933e22328140e924045820af6be2a6985ed8ecc19b63a4f2a37826618' THEN '9ef85f9933e22328140e924045820af6be2a6985ed8ecc19b63a4f2a37826618' ELSE NULL END FROM _mantle_storage_state WHERE id=1)) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint;
