import {
  buildDdl,
  buildSchemaSqlView,
  dropSchemaSqlViewSql,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type {
  DatabaseDriver,
  Migration,
} from "../../domain/port/DatabaseDriver.js";

/**
 * Canonical migration list — the runtime owns the schema; adapters
 * just execute. `id` strings are stable forever; the `_migrations`
 * tracking table makes subsequent boots idempotent. Append-only from
 * v0.1.0 onwards.
 */
export const CANONICAL_MIGRATIONS: readonly Migration[] = [
  {
    id: "0001-init",
    description:
      "v0.1.0 schema: entries / site_config + Better Auth tables (ADR-0014)",
    // SQLite: Better Auth serializes Date → ISO 8601 string and
    // boolean → 0/1, so date columns are TEXT and booleans INTEGER.
    sql: `
      CREATE TABLE IF NOT EXISTS entries (
        id          TEXT PRIMARY KEY,
        collection  TEXT NOT NULL,
        status      TEXT NOT NULL,
        version     INTEGER NOT NULL DEFAULT 1,
        data        TEXT NOT NULL,
        author_id   TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_by_collection_updated
        ON entries (collection, updated_at DESC);
      CREATE INDEX IF NOT EXISTS entries_by_collection_status
        ON entries (collection, status);

      CREATE TABLE IF NOT EXISTS site_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user (
        id            TEXT PRIMARY KEY NOT NULL,
        name          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE,
        emailVerified INTEGER NOT NULL DEFAULT 0,
        image         TEXT,
        createdAt     TEXT NOT NULL,
        updatedAt     TEXT NOT NULL,
        role          TEXT,
        banned        INTEGER DEFAULT 0,
        banReason     TEXT,
        banExpires    TEXT,
        githubLogin   TEXT
      );
      -- Partial index keeps ensureBootstrapOwner's role-IN scan off
      -- the pile of role=NULL rows.
      CREATE INDEX IF NOT EXISTS user_role_idx ON user (role) WHERE role IS NOT NULL;

      CREATE TABLE IF NOT EXISTS session (
        id             TEXT PRIMARY KEY NOT NULL,
        expiresAt      TEXT NOT NULL,
        token          TEXT NOT NULL UNIQUE,
        createdAt      TEXT NOT NULL,
        updatedAt      TEXT NOT NULL,
        ipAddress      TEXT,
        userAgent      TEXT,
        userId         TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        impersonatedBy TEXT
      );
      CREATE INDEX IF NOT EXISTS session_userId_idx ON session (userId);

      CREATE TABLE IF NOT EXISTS account (
        id                       TEXT PRIMARY KEY NOT NULL,
        issuer                   TEXT NOT NULL,
        accountId                TEXT NOT NULL,
        providerId               TEXT NOT NULL,
        userId                   TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        accessToken              TEXT,
        refreshToken             TEXT,
        idToken                  TEXT,
        accessTokenExpiresAt     TEXT,
        refreshTokenExpiresAt    TEXT,
        scope                    TEXT,
        password                 TEXT,
        createdAt                TEXT NOT NULL,
        updatedAt                TEXT NOT NULL,
        UNIQUE (issuer, accountId)
      );
      CREATE INDEX IF NOT EXISTS account_userId_idx ON account (userId);

      CREATE TABLE IF NOT EXISTS verification (
        id         TEXT PRIMARY KEY NOT NULL,
        identifier TEXT NOT NULL,
        value      TEXT NOT NULL,
        expiresAt  TEXT NOT NULL,
        createdAt  TEXT NOT NULL,
        updatedAt  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier);

      CREATE TABLE IF NOT EXISTS jwks (
        id         TEXT PRIMARY KEY NOT NULL,
        publicKey  TEXT NOT NULL,
        privateKey TEXT NOT NULL,
        createdAt  TEXT NOT NULL,
        expiresAt  TEXT,
        alg        TEXT,
        crv        TEXT
      );

      CREATE TABLE IF NOT EXISTS oauthClient (
        id                               TEXT PRIMARY KEY NOT NULL,
        clientId                         TEXT NOT NULL UNIQUE,
        clientSecret                     TEXT,
        clientDiscoveryId                TEXT,
        disabled                         INTEGER DEFAULT 0,
        skipConsent                      INTEGER,
        enableEndSession                 INTEGER,
        subjectType                      TEXT,
        scopes                           TEXT,
        clientCredentialsScopes          TEXT DEFAULT '[]',
        userId                           TEXT REFERENCES user(id) ON DELETE CASCADE,
        createdAt                        TEXT,
        updatedAt                        TEXT,
        name                             TEXT,
        uri                              TEXT,
        icon                             TEXT,
        contacts                         TEXT,
        tos                              TEXT,
        policy                           TEXT,
        softwareId                       TEXT,
        softwareVersion                  TEXT,
        softwareStatement                TEXT,
        redirectUris                     TEXT NOT NULL,
        postLogoutRedirectUris           TEXT,
        backchannelLogoutUri             TEXT,
        backchannelLogoutSessionRequired INTEGER,
        tokenEndpointAuthMethod          TEXT,
        applicationType                  TEXT,
        jwks                             TEXT,
        jwksUri                          TEXT,
        grantTypes                       TEXT,
        responseTypes                    TEXT,
        requirePKCE                      INTEGER,
        dpopBoundAccessTokens            INTEGER DEFAULT 0,
        referenceId                      TEXT,
        metadata                         TEXT
      );
      CREATE INDEX IF NOT EXISTS oauthClient_userId_idx ON oauthClient (userId);

      CREATE TABLE IF NOT EXISTS oauthResource (
        id                              TEXT PRIMARY KEY NOT NULL,
        identifier                      TEXT NOT NULL UNIQUE,
        name                            TEXT NOT NULL,
        accessTokenTtl                  INTEGER,
        refreshTokenTtl                 INTEGER,
        signingAlgorithm                TEXT,
        signingKeyId                    TEXT,
        allowedScopes                   TEXT,
        customClaims                    TEXT,
        dpopBoundAccessTokensRequired   INTEGER DEFAULT 0,
        disabled                        INTEGER DEFAULT 0,
        createdAt                       TEXT,
        updatedAt                       TEXT,
        policyVersion                   INTEGER DEFAULT 1,
        metadata                        TEXT
      );

      CREATE TABLE IF NOT EXISTS oauthClientResource (
        id         TEXT PRIMARY KEY NOT NULL,
        clientId   TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
        resourceId TEXT NOT NULL REFERENCES oauthResource(identifier) ON DELETE CASCADE,
        metadata   TEXT,
        createdAt  TEXT,
        UNIQUE (clientId, resourceId)
      );
      CREATE INDEX IF NOT EXISTS oauthClientResource_clientId_idx
        ON oauthClientResource (clientId);
      CREATE INDEX IF NOT EXISTS oauthClientResource_resourceId_idx
        ON oauthClientResource (resourceId);

      CREATE TABLE IF NOT EXISTS oauthRefreshToken (
        id                    TEXT PRIMARY KEY NOT NULL,
        token                 TEXT NOT NULL UNIQUE,
        clientId              TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
        sessionId             TEXT REFERENCES session(id) ON DELETE SET NULL,
        userId                TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        referenceId           TEXT,
        authorizationCodeId   TEXT,
        resources             TEXT,
        requestedUserInfoClaims TEXT,
        expiresAt             TEXT NOT NULL,
        createdAt             TEXT NOT NULL,
        revoked               TEXT,
        rotatedAt             TEXT,
        rotationReplayResponse TEXT,
        rotationReplayExpiresAt TEXT,
        authTime              TEXT,
        confirmation          TEXT,
        scopes                TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS oauthRefreshToken_clientId_idx ON oauthRefreshToken (clientId);
      CREATE INDEX IF NOT EXISTS oauthRefreshToken_sessionId_idx ON oauthRefreshToken (sessionId);
      CREATE INDEX IF NOT EXISTS oauthRefreshToken_userId_idx ON oauthRefreshToken (userId);
      CREATE INDEX IF NOT EXISTS oauthRefreshToken_authorizationCodeId_idx
        ON oauthRefreshToken (authorizationCodeId);

      CREATE TABLE IF NOT EXISTS oauthAccessToken (
        id                      TEXT PRIMARY KEY NOT NULL,
        token                   TEXT NOT NULL UNIQUE,
        clientId                TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
        sessionId               TEXT REFERENCES session(id) ON DELETE SET NULL,
        userId                  TEXT REFERENCES user(id) ON DELETE CASCADE,
        referenceId             TEXT,
        authorizationCodeId     TEXT,
        resources               TEXT,
        requestedUserInfoClaims TEXT,
        refreshId               TEXT REFERENCES oauthRefreshToken(id) ON DELETE CASCADE,
        expiresAt               TEXT NOT NULL,
        createdAt               TEXT NOT NULL,
        revoked                 TEXT,
        confirmation            TEXT,
        scopes                  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS oauthAccessToken_clientId_idx ON oauthAccessToken (clientId);
      CREATE INDEX IF NOT EXISTS oauthAccessToken_sessionId_idx ON oauthAccessToken (sessionId);
      CREATE INDEX IF NOT EXISTS oauthAccessToken_userId_idx ON oauthAccessToken (userId);
      CREATE INDEX IF NOT EXISTS oauthAccessToken_refreshId_idx ON oauthAccessToken (refreshId);
      CREATE INDEX IF NOT EXISTS oauthAccessToken_authorizationCodeId_idx
        ON oauthAccessToken (authorizationCodeId);

      CREATE TABLE IF NOT EXISTS oauthConsent (
        id                      TEXT PRIMARY KEY NOT NULL,
        clientId                TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
        userId                  TEXT REFERENCES user(id) ON DELETE CASCADE,
        referenceId             TEXT,
        resources               TEXT,
        requestedUserInfoClaims TEXT,
        scopes                  TEXT NOT NULL,
        createdAt               TEXT NOT NULL,
        updatedAt               TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS oauthConsent_clientId_idx ON oauthConsent (clientId);
      CREATE INDEX IF NOT EXISTS oauthConsent_userId_idx ON oauthConsent (userId);

      CREATE TABLE IF NOT EXISTS oauthClientAssertion (
        id        TEXT PRIMARY KEY NOT NULL,
        expiresAt TEXT NOT NULL
      );
    `,
  },
  {
    id: "0002-media-assets",
    description:
      "media_assets table — committed MediaAsset rows for #272 multi-variant uploads. Entry data references rows by id (x-mantle-ref: media_assets); runtime.media.resolve materialises the variants set at render time.",
    sql: `
      CREATE TABLE IF NOT EXISTS media_assets (
        id          TEXT PRIMARY KEY,
        created_at  INTEGER NOT NULL,
        owner_id    TEXT,
        alt         TEXT,
        caption     TEXT,
        variants    TEXT NOT NULL,
        metadata    TEXT
      );
      CREATE INDEX IF NOT EXISTS media_assets_by_owner_created
        ON media_assets (owner_id, created_at DESC);
    `,
  },
  {
    id: "0003-pending-media-uploads",
    description:
      "Strongly-consistent create-to-commit media upload state; Workers KV remains derivative-only",
    sql: `
      CREATE TABLE IF NOT EXISTS pending_media_uploads (
        id          TEXT PRIMARY KEY,
        record      TEXT NOT NULL,
        expires_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS pending_media_uploads_expires_at
        ON pending_media_uploads (expires_at);
    `,
  },
  {
    id: "0004-published-entry-access-paths",
    description:
      "Measured indexes for published collection, locale, sitemap, and llms reads",
    sql: `
      ALTER TABLE entries ADD COLUMN entry_locale TEXT
        GENERATED ALWAYS AS (json_extract(data, '$.locale')) VIRTUAL;

      CREATE INDEX IF NOT EXISTS entries_published_updated
        ON entries (updated_at DESC, id DESC)
        WHERE status = 'published';
      CREATE INDEX IF NOT EXISTS entries_published_locale_updated
        ON entries (entry_locale, updated_at DESC, id DESC)
        WHERE status = 'published';
      CREATE INDEX IF NOT EXISTS entries_published_collection_updated
        ON entries (collection, updated_at DESC, id DESC)
        WHERE status = 'published';
      CREATE INDEX IF NOT EXISTS entries_published_collection_locale_updated
        ON entries (collection, entry_locale, updated_at DESC, id DESC)
        WHERE status = 'published';
    `,
  },
  {
    id: "0005-admin-entry-list-access-paths",
    description: "Keyset indexes for bounded admin entry listing",
    sql: `
      CREATE INDEX IF NOT EXISTS entries_by_collection_updated_id
        ON entries (collection, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS entries_by_collection_status_updated_id
        ON entries (collection, status, updated_at DESC, id DESC);

      DROP INDEX IF EXISTS entries_by_collection_updated;
      DROP INDEX IF EXISTS entries_by_collection_status;
      DROP INDEX IF EXISTS entries_published_collection_updated;
    `,
  },
  {
    id: "0006-schema-sql-views",
    description: "Track Schema logical SQL views",
    sql: `
      CREATE TABLE IF NOT EXISTS _mantle_schema_views (
        name TEXT PRIMARY KEY NOT NULL
      );
    `,
  },
  {
    id: "0007-boot-state",
    description: "Skip unchanged boot reconciliation on cold Worker isolates",
    sql: `
      CREATE TABLE IF NOT EXISTS _mantle_boot_state (
        id          TEXT PRIMARY KEY NOT NULL,
        fingerprint TEXT NOT NULL
      );
    `,
  },
];

/** Keep Schema logical tables exact across manifest additions, edits, and removals. */
export async function reconcileSchemaSqlViews(
  db: DatabaseDriver,
  schemas: Iterable<SchemaManifest>,
): Promise<void> {
  const views = [...schemas]
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
    .map(buildSchemaSqlView);
  const desired = new Set(views.map((view) => view.name));
  const tracked = await db.prepare("SELECT name FROM _mantle_schema_views").all<{ name: string }>();

  for (const { name } of tracked) {
    if (desired.has(name)) continue;
    await db.prepare(dropSchemaSqlViewSql(name)).run();
    await db.prepare("DELETE FROM _mantle_schema_views WHERE name = ?").bind(name).run();
  }
  for (const view of views) {
    await db.prepare(view.dropSql).run();
    await db.prepare(view.createSql).run();
    await db.prepare("INSERT OR IGNORE INTO _mantle_schema_views(name) VALUES (?)")
      .bind(view.name)
      .run();
  }
}

export function schemaIndexMigrations(
  schemas: Iterable<SchemaManifest>,
): readonly Migration[] {
  const migrations: Migration[] = [];
  const ordered = [...schemas].sort((a, b) =>
    a.metadata.name.localeCompare(b.metadata.name));
  for (const schema of ordered) {
    const ddl = buildDdl(schema);
    for (const column of ddl.columns) {
      migrations.push({
        id: `schema-index-v2:column:${column.name}`,
        description: `Generated Schema-index column ${column.name}`,
        sql: column.sql,
      });
    }
    for (const index of ddl.indexes) {
      migrations.push({
        id: `schema-index-v2:index:${index.name}`,
        description: `Manifest Schema index ${index.name}`,
        sql: index.sql,
      });
    }
  }
  return migrations;
}

const SCHEMA_INDEX_V2_PREFIX = "schema-index-v2:index:";
const LEGACY_UNIQUE_INDEX_PREFIX = "schema-unique-index:";
const SAFE_SCHEMA_INDEX_V2 = /^m2[uir]_[0-9a-f]+_[0-9a-f]+_[0-9a-f]+(?:__[0-9a-f]+_[0-9a-f]+)*$/;
const SAFE_LEGACY_UNIQUE_INDEX = /^uq_[a-z0-9_.-]+(?:__[a-z0-9_.-]+)+$/i;

/**
 * Drop generated indexes no longer declared by the current manifests.
 * Keep generated columns: SQLite cannot remove them safely across the
 * D1 versions Mantle supports, and unused virtual columns are harmless.
 */
export async function reconcileSchemaIndexes(
  db: DatabaseDriver,
  current: readonly Migration[],
  schemas: Iterable<SchemaManifest>,
): Promise<void> {
  const desiredV2 = new Set(
    current
      .map((migration) => migration.id)
      .filter((id) => id.startsWith(SCHEMA_INDEX_V2_PREFIX)),
  );
  const legacyExpectations = legacyUniqueIndexExpectations(schemas);
  const appliedV2 = await db
    .prepare(`SELECT id FROM _migrations WHERE id LIKE 'schema-index-v2:index:%'`)
    .all<{ id: string }>();
  const appliedLegacy = await db
    .prepare(`SELECT id FROM _migrations WHERE id LIKE 'schema-unique-index:%'`)
    .all<{ id: string }>();
  const desiredLegacy = await matchingLegacyUniqueIndexes(
    db,
    appliedLegacy,
    legacyExpectations,
  );

  await dropStaleIndexes(
    db,
    appliedV2,
    desiredV2,
    SCHEMA_INDEX_V2_PREFIX,
    SAFE_SCHEMA_INDEX_V2,
  );
  await dropStaleIndexes(
    db,
    appliedLegacy,
    desiredLegacy,
    LEGACY_UNIQUE_INDEX_PREFIX,
    SAFE_LEGACY_UNIQUE_INDEX,
  );
}

function legacyUniqueIndexExpectations(
  schemas: Iterable<SchemaManifest>,
): ReadonlyMap<string, readonly string[] | null> {
  const expectations = new Map<string, readonly string[] | null>();
  for (const schema of schemas) {
    for (const fields of schema.spec.uniqueIndexes ?? []) {
      if (fields.length === 0) continue;
      const flattened = fields.map((field) => field.replace(/\./g, "_"));
      const id =
        `${LEGACY_UNIQUE_INDEX_PREFIX}uq_${schema.metadata.name}__${flattened.join("__")}`;
      const columns = flattened.map((field) => `${schema.metadata.name}__${field}`);
      const ambiguous = schema.metadata.name.includes("__") ||
        fields.some((field) => /[._]/.test(field));
      const previous = expectations.get(id);
      if (
        ambiguous ||
        previous === null ||
        (previous !== undefined && !sameStrings(previous, columns))
      ) {
        expectations.set(id, null);
      } else {
        expectations.set(id, columns);
      }
    }
  }
  return expectations;
}

/**
 * Alpha.59 flattened dots and joined tuples with `__`, so migration ids alone
 * cannot prove that a legacy physical index still represents today's tuple.
 * Retain only unambiguous declarations whose ordered physical columns match.
 */
async function matchingLegacyUniqueIndexes(
  db: DatabaseDriver,
  applied: readonly { readonly id: string }[],
  expectedById: ReadonlyMap<string, readonly string[] | null>,
): Promise<ReadonlySet<string>> {
  const matching = new Set<string>();
  for (const { id } of applied) {
    const expected = expectedById.get(id);
    if (!expected) continue;
    const indexName = id.slice(LEGACY_UNIQUE_INDEX_PREFIX.length);
    if (!SAFE_LEGACY_UNIQUE_INDEX.test(indexName)) continue;
    const actual = await db
      .prepare(`PRAGMA index_info("${indexName}")`)
      .all<{ seqno: number; name: string }>();
    const columns = [...actual]
      .sort((a, b) => a.seqno - b.seqno)
      .map(({ name }) => name);
    if (sameStrings(columns, expected)) matching.add(id);
  }
  return matching;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function dropStaleIndexes(
  db: DatabaseDriver,
  applied: readonly { readonly id: string }[],
  desired: ReadonlySet<string>,
  prefix: string,
  safeName: RegExp,
): Promise<void> {
  for (const { id } of applied) {
    if (desired.has(id)) continue;
    const indexName = id.slice(prefix.length);
    if (!safeName.test(indexName)) {
      throw new Error(`unsafe generated Schema-index identifier: ${indexName}`);
    }
    await db.batch([
      db.prepare(`DROP INDEX IF EXISTS "${indexName}"`),
      db.prepare(`DELETE FROM _migrations WHERE id = ?`).bind(id),
    ]);
  }
}
