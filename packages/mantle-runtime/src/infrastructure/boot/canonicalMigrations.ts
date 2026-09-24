import type { Migration } from "../../domain/port/DatabaseDriver.js";

/**
 * SQLite infrastructure migrations. Schema content tables are compiled from
 * the RuntimePlan and intentionally live outside this list. This is the
 * pre-beta native-table baseline; once released, migration ids are append-only.
 */
export const CANONICAL_MIGRATIONS: readonly Migration[] = [
  {
    id: "0001-init",
    description:
      "v0.1.0 infrastructure: site_config + Better Auth tables (ADR-0014)",
    // SQLite: Better Auth serializes Date → ISO 8601 string and
    // boolean → 0/1, so date columns are TEXT and booleans INTEGER.
    sql: `
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
    id: "0004-native-schema-storage",
    description: "Track the prepared RuntimePlan and native Schema-table storage",
    sql: `
      CREATE TABLE IF NOT EXISTS _mantle_boot_state (
        id          TEXT PRIMARY KEY NOT NULL,
        fingerprint TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _mantle_schema_tables (
        name       TEXT PRIMARY KEY NOT NULL,
        projection TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _mantle_storage_state (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        fingerprint TEXT NOT NULL
      );
    `,
  },
  {
    id: "0005-store-instance-id",
    description: "Bind derivative storage keys to one physical store instance",
    sql: "ALTER TABLE _mantle_boot_state ADD COLUMN store_instance_id TEXT;",
  },
  {
    id: "0006-managed-runtime-version",
    description: "Record canonical migration readiness for managed SQLite hosts",
    sql: `CREATE TABLE IF NOT EXISTS _mantle_managed_runtime_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      canonical_version TEXT NOT NULL
    );`,
  },
  {
    id: "0007-schedule-run-observations",
    description: "Bounded, durable Cloudflare schedule attempt observations",
    sql: `CREATE TABLE IF NOT EXISTS _mantle_schedule_runs (
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
    CREATE INDEX IF NOT EXISTS _mantle_schedule_runs_recent
      ON _mantle_schedule_runs (started_at DESC);
    CREATE INDEX IF NOT EXISTS _mantle_schedule_runs_schedule_recent
      ON _mantle_schedule_runs (schedule_id, started_at DESC);`,
  },
];
