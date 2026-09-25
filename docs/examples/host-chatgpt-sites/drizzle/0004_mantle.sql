CREATE TABLE IF NOT EXISTS _mantle_managed_runtime_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  canonical_version TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO _mantle_schema_tables(name,projection) VALUES ('articles','{"columns":[["body","TEXT","string",false],["coverAssetId","TEXT","string",false],["summary","TEXT","string",false],["title","TEXT","string",false]],"indexes":[]}') ON CONFLICT(name) DO UPDATE SET projection=excluded.projection;
--> statement-breakpoint
INSERT INTO _mantle_managed_runtime_state(id,canonical_version) VALUES (1,'0006-managed-runtime-version') ON CONFLICT(id) DO UPDATE SET canonical_version=excluded.canonical_version;
--> statement-breakpoint
INSERT INTO _mantle_storage_state(id,fingerprint) VALUES (1,(SELECT CASE WHEN fingerprint='9ef85f9933e22328140e924045820af6be2a6985ed8ecc19b63a4f2a37826618' THEN '9ef85f9933e22328140e924045820af6be2a6985ed8ecc19b63a4f2a37826618' ELSE NULL END FROM _mantle_storage_state WHERE id=1)) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint;
