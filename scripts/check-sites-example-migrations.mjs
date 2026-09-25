import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CANONICAL_MIGRATIONS } from "../packages/mantle-runtime/dist/infrastructure/boot/canonicalMigrations.js";
import { buildSqliteMigrationArtifact } from "../packages/mantle-runtime/dist/infrastructure/storage/SqliteMigrationArtifact.js";

const root = join(import.meta.dirname, "../docs/examples/host-chatgpt-sites/drizzle");
const journal = JSON.parse(readFileSync(join(root, "meta/_journal.json"), "utf8"));
const state = JSON.parse(readFileSync(join(root, "meta/mantle-state.json"), "utf8"));
const db = new DatabaseSync(":memory:");
for (const entry of journal.entries) {
  db.exec(readFileSync(join(root, `${entry.tag}.sql`), "utf8"));
  if (entry.idx === 4) {
    assert.equal(db.prepare("SELECT canonical_version FROM _mantle_managed_runtime_state WHERE id=1").get().canonical_version,
      "0006-managed-runtime-version");
  }
}
assert.equal(db.prepare("SELECT canonical_version FROM _mantle_managed_runtime_state WHERE id=1").get().canonical_version,
  CANONICAL_MIGRATIONS.at(-1).id);
assert.equal(db.prepare("SELECT fingerprint FROM _mantle_storage_state WHERE id=1").get().fingerprint, state.fingerprint);
assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE name='_mantle_schedule_runs'").get());
assert.equal(state.canonicalVersion, CANONICAL_MIGRATIONS.at(-1).id);
assert.equal((await buildSqliteMigrationArtifact(state.schemas, state.schemas, {
  appliedMigrationIds: state.appliedMigrationIds,
})).migrations.length, 0);
db.close();
console.log("Sites example migrations upgrade to the current runtime");
