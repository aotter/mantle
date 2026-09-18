import type { SchemaManifest } from "@aotter/mantle-spec";
import type { Migration } from "../../domain/port/DatabaseDriver.js";
import { CANONICAL_MIGRATIONS } from "../boot/canonicalMigrations.js";
import {
  isAdditiveSchemaTableChange,
  schemaTableMigrations,
  schemaTableProjection,
} from "./SqliteSchemaTables.js";

export interface SqliteMigrationArtifact {
  readonly version: 1;
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly destructive: boolean;
  readonly migrations: readonly Migration[];
  readonly checksum: string;
}

export interface ExplicitSqliteMigration {
  readonly id: string;
  readonly description: string;
  readonly sql: string;
}

/** Build the immutable SQLite artifact reviewed and replayed by deployment. */
export async function buildSqliteMigrationArtifact(
  sourceSchemas: Iterable<SchemaManifest>,
  targetSchemas: Iterable<SchemaManifest>,
  explicit?: ExplicitSqliteMigration,
): Promise<SqliteMigrationArtifact> {
  const source = sorted(sourceSchemas);
  const target = sorted(targetSchemas);
  const sourceByName = new Map(source.map((schema) => [schema.metadata.name, schema]));
  const targetNames = new Set(target.map((schema) => schema.metadata.name));
  const destructive = source.some((schema) => !targetNames.has(schema.metadata.name)) || target.some((schema) => {
    const previous = sourceByName.get(schema.metadata.name);
    return previous !== undefined && !isAdditiveSchemaTableChange(schemaTableProjection(previous), schemaTableProjection(schema));
  });
  if (destructive && !explicit) throw new Error("Schema change requires an explicit reviewed SQLite migration.");
  const sourceFingerprint = await storageFingerprint(source);
  const targetFingerprint = await storageFingerprint(target);
  const content = {
    version: 1 as const,
    sourceFingerprint,
    targetFingerprint,
    destructive,
    migrations: [
      ...CANONICAL_MIGRATIONS,
      ...(explicit ? [explicit] : schemaTableMigrations(target)),
      schemaRevisionMigration(source, target, targetFingerprint),
      storageRevisionMigration(targetFingerprint),
    ],
  };
  return { ...content, checksum: await sha256(JSON.stringify(content)) };
}

function schemaRevisionMigration(source: readonly SchemaManifest[], target: readonly SchemaManifest[], fingerprint: string): Migration {
  const targetNames = new Set(target.map((schema) => schema.metadata.name));
  const statements = source
    .filter((schema) => !targetNames.has(schema.metadata.name))
    .map((schema) => `DELETE FROM _mantle_schema_tables WHERE name = ${quoteText(schema.metadata.name)}`);
  for (const schema of target) {
    statements.push(`INSERT INTO _mantle_schema_tables(name, projection) VALUES (${quoteText(schema.metadata.name)}, ${quoteText(schemaTableProjection(schema))}) ON CONFLICT(name) DO UPDATE SET projection = excluded.projection`);
  }
  return {
    id: `schema-revision:${fingerprint}`,
    description: "Record native Schema-table ownership",
    sql: statements.length ? statements.join("; ") : "SELECT 1",
  };
}

function storageRevisionMigration(fingerprint: string): Migration {
  return {
    id: `storage-revision:${fingerprint}`,
    description: "Activate native Schema-table storage revision",
    sql: `INSERT INTO _mantle_storage_state(id, fingerprint) VALUES (1, '${fingerprint}') ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint`,
  };
}

export async function verifySqliteMigrationArtifact(artifact: SqliteMigrationArtifact): Promise<void> {
  const { checksum, ...content } = artifact;
  if (await sha256(JSON.stringify(content)) !== checksum) throw new Error("SQLite migration artifact checksum mismatch.");
}

export async function storageFingerprint(schemas: Iterable<SchemaManifest>): Promise<string> {
  return sha256(JSON.stringify(sorted(schemas).map((schema) => [schema.metadata.name, JSON.parse(schemaTableProjection(schema))])));
}

function sorted(schemas: Iterable<SchemaManifest>): SchemaManifest[] {
  return [...schemas].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

function quoteText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
