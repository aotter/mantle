# ADR-lite #845: frontend calls use the existing HTTP Trigger contract

Status: Accepted for implementation under #845 and mantle-home #86.

`mantle-web/client` is a browser-safe fetch client for declared public Views and
HTTP Triggers. `mantle-web/client-runtime` projects that contract from the sealed
RuntimePlan and binds the same client to `createMantleRequestHandler`, with a
request-local principal. Local SSR makes no network call and invokes no internal
EntryReader. Calls retain Trigger identity. No manifest grammar changes.

The public contract uses wire names, input/output schemas and the plan fingerprint.
View rows remain records: the existing View API does not promise a generated row
schema. The generic response shape includes rows/page/show/hasMore. This is not a
new generator or validation engine; Runtime still validates and authorizes.

Remote callers inject fetch and a request-local token resolver. Clients never
retry a mutation or follow redirects with credentials. Business diagnostics and
OAuth challenge remain available in MantleClientError; network and abort errors
remain native errors. The browser export imports no runtime or storage module.

Cloudflare's opt-in frontendOrigins accepts exact origins for API CORS, exposes
WWW-Authenticate and permits Authorization/Content-Type preflights. Cross-origin
responses use no-store and do not enable cookie credentials. Cookie CSRF checks
and configured bearer issuer/audience/scope checks remain the same. Host-owned
OAuth/connection policy is independent of application revision. Existing Better
Auth PKCE registration, consent and revocation remain the authority.

In a provider composed with MCP, user grants for additional configured resources
carry the same consent lineage and session binding as MCP grants. Verification
reuses the current-consent/session check for those resources too; API JWTs cannot
outlive revocation or become valid again on reconnect. OAuth discovery responses
also receive the configured exact-origin CORS policy for public browser clients.

Existing native public cache tags and purge handle same-Worker invalidation.
External consumers start with private/no-store, or explicitly bound TTL; durable
remote invalidation delivery remains the parent #792 contract and must be proven
before advertising a stronger freshness guarantee. Cloud's integration includes
the actual external consumer and browser evidence, not only this package change.
