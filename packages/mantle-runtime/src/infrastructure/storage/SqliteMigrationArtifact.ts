import type { SchemaManifest } from "@aotter/mantle-spec";
import type { Migration } from "../../domain/port/DatabaseDriver.js";
import { CANONICAL_MIGRATIONS } from "../boot/canonicalMigrations.js";
import {
  isAdditiveSchemaTableChange,
  schemaTableMigrations,
  schemaTableProjection,
  validateSqliteSchemaTables,
} from "./SqliteSchemaTables.js";

export interface SqliteMigrationArtifact {
  readonly version: 2;
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly destructive: boolean;
  readonly migrations: readonly Migration[];
  readonly projections: readonly { readonly name: string; readonly projection: string }[];
  readonly checksum: string;
}

/** Build the immutable SQLite artifact reviewed and replayed by deployment. */
export async function buildSqliteMigrationArtifact(
  sourceSchemas: Iterable<SchemaManifest>,
  targetSchemas: Iterable<SchemaManifest>,
): Promise<SqliteMigrationArtifact> {
  const source = [...validateSqliteSchemaTables(sourceSchemas)];
  const target = [...validateSqliteSchemaTables(targetSchemas)];
  const sourceByName = new Map(source.map((schema) => [schema.metadata.name.toLowerCase(), schema]));
  const destructive = target.some((schema) => {
    const previous = sourceByName.get(schema.metadata.name.toLowerCase());
    return previous !== undefined && (previous.metadata.name !== schema.metadata.name ||
      !isAdditiveSchemaTableChange(schemaTableProjection(previous), schemaTableProjection(schema)));
  });
  const sourceFingerprint = await storageFingerprint(source);
  const targetFingerprint = await storageFingerprint(target);
  const sourceMigrationIds = new Set(schemaTableMigrations(source).map(({ id }) => id));
  const content = {
    version: 2 as const,
    sourceFingerprint,
    targetFingerprint,
    destructive,
    migrations: [
      ...CANONICAL_MIGRATIONS,
      ...schemaTableMigrations(target).filter(({ id }) => !sourceMigrationIds.has(id)),
    ],
    projections: target.map((schema) => ({ name: schema.metadata.name, projection: schemaTableProjection(schema) })),
  };
  return { ...content, checksum: await sha256(JSON.stringify(content)) };
}

export async function verifySqliteMigrationArtifact(artifact: SqliteMigrationArtifact): Promise<void> {
  const { checksum, ...content } = artifact;
  if (await sha256(JSON.stringify(content)) !== checksum) throw new Error("SQLite migration artifact checksum mismatch.");
}

export async function storageFingerprint(schemas: Iterable<SchemaManifest>): Promise<string> {
  return sha256(JSON.stringify(validateSqliteSchemaTables(schemas).map((schema) => [schema.metadata.name, JSON.parse(schemaTableProjection(schema))])));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
