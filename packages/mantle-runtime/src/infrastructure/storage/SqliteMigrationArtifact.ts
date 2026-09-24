import type { SchemaManifest } from "@aotter/mantle-spec";
import type { Migration } from "../../domain/port/DatabaseDriver.js";
import { CANONICAL_MIGRATIONS } from "../boot/canonicalMigrations.js";
import { splitSqlStatements } from "../boot/SqliteMigrationRunner.js";
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
  readonly targetCanonicalVersion: string;
  readonly destructive: boolean;
  readonly reviewedUniqueIndexes?: readonly { readonly schema: string; readonly removed: readonly (readonly string[])[]; readonly added: readonly (readonly string[])[] }[];
  readonly migrations: readonly Migration[];
  readonly projections: readonly { readonly name: string; readonly projection: string }[];
  readonly checksum: string;
}

export interface SqliteMigrationSource {
  /** IDs in the source state; callers must verify that state against their migration ledger. */
  readonly appliedMigrationIds?: Iterable<string>;
  /** Explicitly permits only unique-index tuple replacement; other destructive changes still fail. */
  readonly reviewUniqueIndexes?: boolean;
}

/** Build the immutable SQLite artifact reviewed and replayed by deployment. */
export async function buildSqliteMigrationArtifact(
  sourceSchemas: Iterable<SchemaManifest>,
  targetSchemas: Iterable<SchemaManifest>,
  sourceState: SqliteMigrationSource = {},
): Promise<SqliteMigrationArtifact> {
  const source = [...validateSqliteSchemaTables(sourceSchemas)];
  const target = [...validateSqliteSchemaTables(targetSchemas)];
  const sourceByName = new Map(source.map((schema) => [schema.metadata.name.toLowerCase(), schema]));
  const targetNames = new Set(target.map((schema) => schema.metadata.name.toLowerCase()));
  const reviewedUniqueIndexes = target.flatMap((schema) => {
    const previous = sourceByName.get(schema.metadata.name.toLowerCase());
    if (!previous) return [];
    const before = new Map((previous.spec.uniqueIndexes ?? []).map((fields) => [JSON.stringify(fields), fields]));
    const after = new Map((schema.spec.uniqueIndexes ?? []).map((fields) => [JSON.stringify(fields), fields]));
    const removed = [...before].filter(([key]) => !after.has(key)).map(([, fields]) => fields);
    const added = [...after].filter(([key]) => !before.has(key)).map(([, fields]) => fields);
    return removed.length || added.length ? [{ schema: schema.metadata.name, removed, added }] : [];
  });
  const structuralDestructive = source.some((schema) => !targetNames.has(schema.metadata.name.toLowerCase())) || target.some((schema) => {
    const previous = sourceByName.get(schema.metadata.name.toLowerCase());
    if (!previous) return false;
    const sameUnique = { ...schema, spec: { ...schema.spec, uniqueIndexes: previous.spec.uniqueIndexes } };
    return previous.metadata.name !== schema.metadata.name ||
      Object.keys(previous.spec.schema.properties ?? {}).some((field) => !Object.hasOwn(schema.spec.schema.properties ?? {}, field)) ||
      !isAdditiveSchemaTableChange(schemaTableProjection(previous), schemaTableProjection(sameUnique));
  });
  const reviewed = sourceState.reviewUniqueIndexes && reviewedUniqueIndexes.length > 0 && !structuralDestructive;
  const destructive = structuralDestructive || (reviewedUniqueIndexes.length > 0 && !reviewed);
  const sourceFingerprint = await storageFingerprint(source);
  const targetFingerprint = await storageFingerprint(target);
  const sourceMigrationIds = new Set(schemaTableMigrations(source).map(({ id }) => id));
  const sourceUnique = schemaTableMigrations(source).filter(({ id }) => id.includes(":unique_"));
  const targetUnique = schemaTableMigrations(target).filter(({ id }) => id.includes(":unique_"));
  const sourceUniqueIds = new Set(sourceUnique.map(({ id }) => id));
  const targetUniqueIds = new Set(targetUnique.map(({ id }) => id));
  const addedUniqueIds = new Set(targetUnique.filter(({ id }) => !sourceUniqueIds.has(id)).map(({ id }) => id));
  const appliedMigrationIds = new Set(sourceState.appliedMigrationIds ?? []);
  const content = {
    version: 2 as const,
    sourceFingerprint,
    targetFingerprint,
    targetCanonicalVersion: CANONICAL_MIGRATIONS.at(-1)!.id,
    destructive,
    migrations: [
      ...CANONICAL_MIGRATIONS.filter(({ id }) => !appliedMigrationIds.has(id)),
      ...schemaTableMigrations(target).filter(({ id }) => !sourceMigrationIds.has(id) && !appliedMigrationIds.has(id) && !(reviewed && addedUniqueIds.has(id))),
      ...(reviewed ? targetUnique.filter(({ id }) => addedUniqueIds.has(id)).map((migration) => ({
        ...migration, id: `reviewed-unique:${targetFingerprint}:create:${migration.id}`,
      })) : []),
      ...(reviewed ? sourceUnique.filter(({ id }) => !targetUniqueIds.has(id)).map((migration) => {
        const name = migration.sql.match(/CREATE UNIQUE INDEX IF NOT EXISTS ("(?:[^"]|"")+") ON /)?.[1];
        if (!name) throw new Error("Invalid generated unique index SQL.");
        return {
          id: `reviewed-unique:${targetFingerprint}:drop:${migration.id}`,
          description: "Remove old unique index after target constraint is active",
          sql: `DROP INDEX IF EXISTS ${name}`,
        };
      }) : []),
    ],
    projections: target.map((schema) => ({ name: schema.metadata.name, projection: schemaTableProjection(schema) })),
    ...(reviewed ? { reviewedUniqueIndexes } : {}),
  };
  return { ...content, checksum: await sha256(JSON.stringify(content)) };
}

export async function verifySqliteMigrationArtifact(artifact: SqliteMigrationArtifact): Promise<void> {
  const { checksum, ...content } = artifact;
  if (await sha256(JSON.stringify(content)) !== checksum) throw new Error("SQLite migration artifact checksum mismatch.");
}

/** Render a managed SQLite migration; deployment applies this file, not Runtime boot. */
export function renderSqliteManagedMigration(
  artifact: SqliteMigrationArtifact,
  source?: { readonly canonicalVersion: string },
): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const version = source?.canonicalVersion && source.canonicalVersion >= "0006-managed-runtime-version"
    ? `(SELECT CASE WHEN canonical_version=${quote(source.canonicalVersion)} THEN ${quote(artifact.targetCanonicalVersion)} ELSE NULL END FROM _mantle_managed_runtime_state WHERE id=1)`
    : quote(artifact.targetCanonicalVersion);
  const fingerprint = source
    ? `(SELECT CASE WHEN fingerprint=${quote(artifact.sourceFingerprint)} THEN ${quote(artifact.targetFingerprint)} ELSE NULL END FROM _mantle_storage_state WHERE id=1)`
    : quote(artifact.targetFingerprint);
  return [
    ...artifact.migrations.flatMap(({ sql }) => splitSqlStatements(sql).map((statement) => `${statement};`)),
    ...artifact.projections.map(({ name, projection }) =>
      `INSERT INTO _mantle_schema_tables(name,projection) VALUES (${quote(name)},${quote(projection)}) ON CONFLICT(name) DO UPDATE SET projection=excluded.projection;`),
    `INSERT INTO _mantle_managed_runtime_state(id,canonical_version) VALUES (1,${version}) ON CONFLICT(id) DO UPDATE SET canonical_version=excluded.canonical_version;`,
    `INSERT INTO _mantle_storage_state(id,fingerprint) VALUES (1,${fingerprint}) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint;`,
  ].join("\n--> statement-breakpoint\n") + "\n";
}

export async function storageFingerprint(schemas: Iterable<SchemaManifest>): Promise<string> {
  return sha256(JSON.stringify(validateSqliteSchemaTables(schemas).map((schema) => [schema.metadata.name, JSON.parse(schemaTableProjection(schema))])));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
