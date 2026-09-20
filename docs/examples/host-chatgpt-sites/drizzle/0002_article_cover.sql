ALTER TABLE "articles" ADD COLUMN "coverAssetId" TEXT;
--> statement-breakpoint
UPDATE _mantle_schema_tables SET projection='{"columns":[["body","TEXT","string",false],["coverAssetId","TEXT","string",false],["summary","TEXT","string",false],["title","TEXT","string",false]],"indexes":[]}' WHERE name='articles';
--> statement-breakpoint
UPDATE _mantle_storage_state SET fingerprint='9ef85f9933e22328140e924045820af6be2a6985ed8ecc19b63a4f2a37826618' WHERE id=1 AND fingerprint='e3cdedf91dbe27db4b9af7ff7e3512e81ae0b0bd69e5a90bd1c9e0526d86ba6b';
