import type { Migration } from "../../domain/port/DatabaseDriver.js";

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
      "v0.1.0 schema: entries / revisions / approvals / site_config + Better Auth tables (ADR-0014)",
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

      CREATE TABLE IF NOT EXISTS revisions (
        id          TEXT PRIMARY KEY,
        entry_id    TEXT NOT NULL,
        version     INTEGER NOT NULL,
        data        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        author_id   TEXT,
        note        TEXT
      );
      CREATE INDEX IF NOT EXISTS revisions_by_entry_version
        ON revisions (entry_id, version DESC);

      CREATE TABLE IF NOT EXISTS approvals (
        id            TEXT PRIMARY KEY,
        entry_id      TEXT NOT NULL,
        requested_by  TEXT NOT NULL,
        requested_at  INTEGER NOT NULL,
        note          TEXT,
        status        TEXT NOT NULL,
        resolved_by   TEXT,
        resolved_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS approvals_by_entry
        ON approvals (entry_id);

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
        updatedAt                TEXT NOT NULL
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
        expiresAt  TEXT
      );

      CREATE TABLE IF NOT EXISTS oauthClient (
        id                      TEXT PRIMARY KEY NOT NULL,
        clientId                TEXT NOT NULL UNIQUE,
        clientSecret            TEXT,
        disabled                INTEGER DEFAULT 0,
        skipConsent             INTEGER,
        enableEndSession        INTEGER,
        subjectType             TEXT,
        scopes                  TEXT,
        userId                  TEXT REFERENCES user(id) ON DELETE CASCADE,
        createdAt               TEXT,
        updatedAt               TEXT,
        name                    TEXT,
        uri                     TEXT,
        icon                    TEXT,
        contacts                TEXT,
        tos                     TEXT,
        policy                  TEXT,
        softwareId              TEXT,
        softwareVersion         TEXT,
        softwareStatement       TEXT,
        redirectUris            TEXT NOT NULL,
        postLogoutRedirectUris  TEXT,
        tokenEndpointAuthMethod TEXT,
        grantTypes              TEXT,
        responseTypes           TEXT,
        public                  INTEGER,
        type                    TEXT,
        requirePKCE             INTEGER,
        referenceId             TEXT,
        metadata                TEXT
      );
      CREATE INDEX IF NOT EXISTS oauthClient_userId_idx ON oauthClient (userId);

      CREATE TABLE IF NOT EXISTS oauthRefreshToken (
        id          TEXT PRIMARY KEY NOT NULL,
        token       TEXT NOT NULL UNIQUE,
        clientId    TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
        sessionId   TEXT REFERENCES session(id) ON DELETE SET NULL,
        userId      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        referenceId TEXT,
        expiresAt   TEXT NOT NULL,
        createdAt   TEXT NOT NULL,
        revoked     TEXT,
        authTime    TEXT,
        scopes      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS oauthRefreshToken_clientId_idx ON oauthRefreshToken (clientId);
      CREATE INDEX IF NOT EXISTS oauthRefreshToken_sessionId_idx ON oauthRefreshToken (sessionId);
      CREATE INDEX IF NOT EXISTS oauthRefreshToken_userId_idx ON oauthRefreshToken (userId);

      CREATE TABLE IF NOT EXISTS oauthAccessToken (
        id          TEXT PRIMARY KEY NOT NULL,
        token       TEXT NOT NULL UNIQUE,
        clientId    TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
        sessionId   TEXT REFERENCES session(id) ON DELETE SET NULL,
        userId      TEXT REFERENCES user(id) ON DELETE CASCADE,
        referenceId TEXT,
        refreshId   TEXT REFERENCES oauthRefreshToken(id) ON DELETE CASCADE,
        expiresAt   TEXT NOT NULL,
        createdAt   TEXT NOT NULL,
        scopes      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS oauthAccessToken_clientId_idx ON oauthAccessToken (clientId);
      CREATE INDEX IF NOT EXISTS oauthAccessToken_sessionId_idx ON oauthAccessToken (sessionId);
      CREATE INDEX IF NOT EXISTS oauthAccessToken_userId_idx ON oauthAccessToken (userId);
      CREATE INDEX IF NOT EXISTS oauthAccessToken_refreshId_idx ON oauthAccessToken (refreshId);

      CREATE TABLE IF NOT EXISTS oauthConsent (
        id          TEXT PRIMARY KEY NOT NULL,
        clientId    TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
        userId      TEXT REFERENCES user(id) ON DELETE CASCADE,
        referenceId TEXT,
        scopes      TEXT NOT NULL,
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS oauthConsent_clientId_idx ON oauthConsent (clientId);
      CREATE INDEX IF NOT EXISTS oauthConsent_userId_idx ON oauthConsent (userId);
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
];
