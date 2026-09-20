CREATE TABLE IF NOT EXISTS site_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
--> statement-breakpoint
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
--> statement-breakpoint
-- Partial index keeps ensureBootstrapOwner's role-IN scan off
      -- the pile of role=NULL rows.
      CREATE INDEX IF NOT EXISTS user_role_idx ON user (role) WHERE role IS NOT NULL;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS session_userId_idx ON session (userId);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS account_userId_idx ON account (userId);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS verification (
        id         TEXT PRIMARY KEY NOT NULL,
        identifier TEXT NOT NULL,
        value      TEXT NOT NULL,
        expiresAt  TEXT NOT NULL,
        createdAt  TEXT NOT NULL,
        updatedAt  TEXT NOT NULL
      );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS jwks (
        id         TEXT PRIMARY KEY NOT NULL,
        publicKey  TEXT NOT NULL,
        privateKey TEXT NOT NULL,
        createdAt  TEXT NOT NULL,
        expiresAt  TEXT,
        alg        TEXT,
        crv        TEXT
      );
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauthClient_userId_idx ON oauthClient (userId);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS oauthClientResource (
        id         TEXT PRIMARY KEY NOT NULL,
        clientId   TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
        resourceId TEXT NOT NULL REFERENCES oauthResource(identifier) ON DELETE CASCADE,
        metadata   TEXT,
        createdAt  TEXT,
        UNIQUE (clientId, resourceId)
      );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauthClientResource_clientId_idx
        ON oauthClientResource (clientId);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauthClientResource_resourceId_idx
        ON oauthClientResource (resourceId);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauthRefreshToken_clientId_idx ON oauthRefreshToken (clientId);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauthRefreshToken_sessionId_idx ON oauthRefreshToken (sessionId);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauthRefreshToken_userId_idx ON oauthRefreshToken (userId);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauthRefreshToken_authorizationCodeId_idx
        ON oauthRefreshToken (authorizationCodeId);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauthAccessToken_clientId_idx ON oauthAccessToken (clientId);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauthAccessToken_sessionId_idx ON oauthAccessToken (sessionId);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauthAccessToken_userId_idx ON oauthAccessToken (userId);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauthAccessToken_refreshId_idx ON oauthAccessToken (refreshId);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauthAccessToken_authorizationCodeId_idx
        ON oauthAccessToken (authorizationCodeId);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauthConsent_clientId_idx ON oauthConsent (clientId);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauthConsent_userId_idx ON oauthConsent (userId);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS oauthClientAssertion (
        id        TEXT PRIMARY KEY NOT NULL,
        expiresAt TEXT NOT NULL
      );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS media_assets (
        id          TEXT PRIMARY KEY,
        created_at  INTEGER NOT NULL,
        owner_id    TEXT,
        alt         TEXT,
        caption     TEXT,
        variants    TEXT NOT NULL,
        metadata    TEXT
      );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS media_assets_by_owner_created
        ON media_assets (owner_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pending_media_uploads (
        id          TEXT PRIMARY KEY,
        record      TEXT NOT NULL,
        expires_at  INTEGER NOT NULL
      );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pending_media_uploads_expires_at
        ON pending_media_uploads (expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS _mantle_boot_state (
        id          TEXT PRIMARY KEY NOT NULL,
        fingerprint TEXT NOT NULL
      );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS _mantle_schema_tables (
        name       TEXT PRIMARY KEY NOT NULL,
        projection TEXT NOT NULL
      );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS _mantle_storage_state (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        fingerprint TEXT NOT NULL
      );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "articles" (
        "_mantle_id" TEXT PRIMARY KEY,
        "_mantle_status" TEXT NOT NULL,
        "_mantle_version" INTEGER NOT NULL DEFAULT 1,
        "_mantle_author_id" TEXT,
        "_mantle_created_at" INTEGER NOT NULL,
        "_mantle_updated_at" INTEGER NOT NULL
      );
--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "body" TEXT;
--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "summary" TEXT;
--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "title" TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "m_61727469636c6573_updated" ON "articles"("_mantle_updated_at" DESC, "_mantle_id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "m_61727469636c6573_status_updated" ON "articles"("_mantle_status", "_mantle_updated_at" DESC, "_mantle_id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "m_61727469636c6573_created" ON "articles"("_mantle_created_at");
--> statement-breakpoint
INSERT INTO _mantle_schema_tables(name,projection) VALUES ('articles','{"columns":[["body","TEXT","string",false],["summary","TEXT","string",false],["title","TEXT","string",false]],"indexes":[]}');
--> statement-breakpoint
INSERT INTO _mantle_storage_state(id,fingerprint) VALUES (1,'e3cdedf91dbe27db4b9af7ff7e3512e81ae0b0bd69e5a90bd1c9e0526d86ba6b');
