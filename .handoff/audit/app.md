## Ponytail-review audit: packages/mantle src/{usecase,infrastructure,domain,auth,removed,bun,testing} and package.json

This was read-only. I changed no files and touched nothing on GitHub.

Method:
- I listed every exported symbol in the area and grepped for it across `packages/*/src`, `packages/*/tests`, `packages/*/scripts`, `docs`, `skills` and `scripts`, in .ts/.tsx/.mjs/.md/.json files and excluding dist.
- I grepped every `exports` key as an `@aotter/mantle/<key>` specifier in docs, skills, Admin src, READMEs and the generator templates.
- For each dependency I listed every import site.
- I checked the seam registry in `tests/application-seams.ts` and the classifications in `tests/public-surface.test.ts`.

No exported symbol in the area is dead outright. The cuts below are duplication, dead branches, helpers used only by tests, and one unused internal export key.

### SAFE (sorted by lines saved)

1. domain/describe/targets.ts:L357-378: delete: for the generic Admin routes (entries, statistics, bootstrap), the `operation` ladder and the `inspectBehavior(...)` call yield only `opaque` (always `false`, because `deps` is `[]`) and `dependencies` (always `[]`). `d.schemas` overwrites the schemas the call computed. Replacement: `d.schemas = …; d.readSchemas = d.schemas; d.behavior = { schemas: plan.schemas, dependencies: [] }`.
   evidence: `inspectBehavior` hard-codes `dependencies: [] as unknown[]` (L127); `addRoute` already sets `opaque: deps.some(...)`, which is false for `[]`. The hashed `behavior` is byte-identical, so no targetHash changes. Not exported.
   class: SAFE, ~18 lines

2. domain/adminOrder.ts:L13-29, usecase/paging.ts:L64-78, usecase/adminBindings.ts:L345-361: reuse: the same type-to-`CursorKind` ternary ladder appears three times. Replacement: one `cursorKind(type)` in domain/columns.ts. paging and adminBindings use `?? "text"`; adminOrder drops `numeric` to keep its current output.
   evidence: grep `"float8"` / `"timestamp"` shows the three ladders. All three are internal; generated output is unchanged.
   class: SAFE, ~30 lines

3. infrastructure/generate.ts:L42-51 and L64-73, adminPaging.ts:L87-94, adminEntries.ts:L58-64 and L306: reuse: the "print a node as an SQL expression" pattern (`print({SelectStmt:{targetList:[{ResTarget:{val}}],…}}).replace(/^SELECT /,"")`) appears five times. Replacement: one `printExpression(dialect, node, schemas)` helper.
   evidence: `grep -rn 'replace(/^SELECT /' src` returns exactly these five sites. All internal.
   class: SAFE, ~25 lines

4. domain/describe/target-hash.ts:L30-34 and domain/describe/index.ts:L7: delete: `targetHash()` and its re-export. It was removed from the public API (releases/index.md L429: "use `_meta.targetHash` instead of `targetHash()`") and is now only a test helper. Replacement: the tests read `describeApp(plan)…_meta.targetHash`.
   evidence: the only importers are tests/describe.test.ts, describe-diff.test.ts and mcp-localized-schema.test.ts. `./describe` (public.ts) exports only `matchTarget`. No seam uses it.
   class: SAFE, ~7 lines

5. domain/describe/targets.ts:L43,47,59-63,109: delete: `inspectSql`'s `writes` array and the create/update/delete mapping are never read. Its `export` is also unused outside the file.
   evidence: `grep -rn "\.writes\b" src` hits only L109, which is an assignment.
   class: SAFE, ~9 lines

6. infrastructure/artifacts.ts:L7,38,53,64: shrink: the ENOENT catch (`if (error.code === "ENOENT") return undefined; throw error;`) is written out four times. Replacement: one `const absent = (e) => …` helper. Separately, `ownedFiles` (L6-29) hand-rolls recursion; `readdir(dir, { recursive: true, withFileTypes: true })` (stdlib, already used in bundle.ts L392) covers it.
   evidence: read of the file. Internal.
   class: SAFE, ~12 lines

7. domain/describe/index.ts:L63-68/L103-108 and L87-89/L100-102: shrink: the `scope` object builder and the `unscopedReads` predicate are each duplicated for targets and variants. Replacement: two local helpers.
   evidence: read of the file. Output is identical.
   class: SAFE, ~8 lines

8. infrastructure/adminEntries.ts:L46-47,L141-146,L150-152 and adminPaging.ts:L51-52 / adminEntries.ts:L136-138: shrink: the unique-name loop (`while (used.has(name)) name += "_"`) appears three times, and the `marker = 32767; while (…includes(String(marker))) marker++` loop appears twice. Replacement: one `fresh(base)` helper and one `freeMarker(text)` helper.
   evidence: read. Internal.
   class: SAFE, ~7 lines

9. infrastructure/adminPaging.ts:L18,L156-167,L148,L170: yagni: the `project` callback of `adminPaging` has a single caller, so inline it. `ok: true` in `adminBindingsOf`'s return is never read (generate.ts L333 destructures only `adminPages` and `adminEntries`), and `wire as Dialect` casts a value that is already a `Dialect`.
   evidence: `grep adminBindingsOf` returns only generate.ts L332.
   class: SAFE, ~6 lines

10. domain/describe/index.ts:L189-193: shrink: `requiresDirection` builds a one-element array for `combine`. It equals `inclusion(x.all.map(canonical), y.all.map(canonical))` in every case, including equal sets, which return "changed" either way.
    evidence: logic check against `inclusion` and `combine` (L131-144).
    class: SAFE, ~4 lines

11. auth/adapter.ts:L339-441,L451-452,L475-476: shrink: `build(…, options)` returns `(options) => factory(...)`, and both callers immediately call it again with the same `options`. Return the factory result directly.
    evidence: the only two callers are `d1Adapter` and `make` in `postgresAdapter`.
    class: SAFE, ~4 lines

12. usecase/stores.ts:L16, usecase/adminBindings.ts:L14-15, infrastructure/adminEntries.ts:L183, domain/paging.ts:L265: reuse: the scalar column-type list `["text","integer","int4","int8","real","float8","bool","date","timestamptz"]` is spelled four times. Replacement: export `SCALAR` once from domain/columns.ts.
    evidence: grep `"float8"`. Internal.
    class: SAFE, ~4 lines

13. package.json: three cleanups.
    - delete: the exports key `"./internal/authorization"`. No generated code, doc, Admin source or seam imports that specifier; kernel/authorization.js is still reached by relative import. CONTRIBUTING says removing `./internal/*` keys is not breaking.
    - delete: the scripts `check:size`, `check:package` and `generate`. Nothing invokes them by name: the root `check` runs `bun scripts/check-size.ts` and `check-package.ts` directly, and CI calls neither.
    - move `@pgsql/types` from `dependencies` to `devDependencies`. Its only import is type-only (src/build/core/sql/positions.ts L10-20), no file in dist references it, and pgsql-deparser already depends on it.
    evidence: specifier grep (`internal/authorization` docs=0 src=0, Admin 0); grep of package.json, .github and scripts for the script names; `grep -rl @pgsql/types dist` is empty.
    class: SAFE, ~4 lines

14. usecase/publishing.ts:L9-10, usecase/mcp-media.ts:L4-5: delete: pass-through re-exports of `domain/generated-tools` (`publishingAnnotations`, `publishingInput`, `publishingTransitions`, `mediaDefinitions`). Callers (mcp.ts, validation.ts, adminDescriptors.ts) should import from domain/generated-tools.js directly.
    evidence: grep of import sites.
    class: SAFE, ~3 lines

15. auth/routes.ts:L186-188: native: the `getSetCookie?.() ?? [get("set-cookie")]` fallback. `Headers.prototype.getSetCookie` ships in Node 22, Bun and workerd, so call `response.headers.getSetCookie()`.
    evidence: engines `node >=22.22`; the four targets are Bun and Workers.
    class: SAFE, ~2 lines

16. auth/resource-seeds.ts (whole file, 9 lines): yagni: a module with one caller (auth/adapter.ts L19). Inline it there.
    evidence: `grep resource-seeds` returns only adapter.ts. Not in exports.
    class: SAFE, ~2 lines

17. domain/paging.ts:L133, infrastructure/adminEntries.ts:L71-73 and L182: delete: the `?? (name === "version" ? "integer" : …)` branch is dead. `declaredType` (domain/columns.ts L16-22) already returns "integer" for `version`. Replacement: `?? "text"`.
    evidence: read of `declaredType`.
    class: SAFE, ~2 lines

18. Three small reuse fixes:
    - infrastructure/generateAuth.ts:L24: the literal `"mantle-oauth-grant-revocation" /* oauthGrantRevocation().id */` should import `OAUTH_GRANT_REVOCATION` from auth/oauth.ts. That is also currently the export's only possible consumer.
    - usecase/mcp.ts:L178: `["publish","unpublish","archive"]` should map over `publishingTransitions`.
    - usecase/adminDescriptors.ts:L24/L46: `schemaList` and `schemas` are the same `Object.values(plan.schemas)`.
    evidence: grep for `OAUTH_GRANT_REVOCATION` shows no use outside oauth.ts; read of the other two.
    class: SAFE, ~2 lines

### BREAKING

19. auth/identity.ts:L88,L305-308: delete: the `caller` parameter of the public `d1Identity` and `postgresIdentity` is unused (`directory(auth, _caller, …)`). Authority comes from `headers` only. Removing it is a public signature change; the docs at cloudflare/authentication.md L103-104 and both example service.ts files pass it.
    evidence: `_caller` is never read. Reachable from `./auth/identity`, a developer API. Not a registered seam.
    class: BREAKING, ~2 lines (plus docs and examples)

20. usecase/generate.ts:L144-147: reuse: the `values` loop duplicates what `recipesOf(…, values)` (domain/recipes.ts L20-23) already collects. Pass `values` to `recipesOf` instead. This changes generated output: for a JSON input bind today's loop adds a spurious `timestamp: DIALECT.timestamp` to `D`, and that entry would disappear.
    evidence: read of both files.
    class: BREAKING (generated output), ~4 lines

21. domain/describe/targets.ts:L127,225,304,378: delete: `dependencies` is always `[]` but is hashed into `behavior`. Dropping it changes every `_meta.targetHash` and every generated `access-targets.ts`.
    evidence: the only assignment is `[] as unknown[]`.
    class: BREAKING (describe and generated output), ~4 lines

### DECISION

22. package.json exports: `"."` and `"./generate"` both resolve to `./dist/infrastructure/generate.js`. Neither specifier appears in docs, examples, tests or scripts (programmatic generation is documented only via `./generate/auth`). Keep one of them.
    evidence: specifier grep (`.` docs=0 import sites, `./generate` 0). Both are classified as developer API in public-surface.test.ts L13-14.
    class: DECISION, ~1 line

23. package.json exports `"./host-access"`: nothing outside the package refers to it (docs=0, generated code=0, seams=0). It is classified HOST ("names and paths stay") in public-surface.test.ts L45. Only an ADR can retire it.
    class: DECISION, ~1 line

24. infrastructure/artifacts.ts:L20-25: delete: the regex that recognises "pre-header operation entries", i.e. entry files from before every generated file carried the GENERATED header. Today `generate()` wraps entries with `generatedFiles`. Removing it means `mantle generate` no longer deletes obsolete entries generated by those old versions.
    class: DECISION, ~5 lines

25. infrastructure/bundle.ts:L466: delete: recognising the earlier one-year Admin `_headers` rule (`adminRule.replace("86400","31536000")`, #2088). Without it, an app still holding a pre-#2088 `_headers` would get "add this rule" notes instead of a rewrite.
    class: DECISION, ~1 line

### State reports (not findings)

- **Removed-subpath stubs:** src/removed/json-body.ts, driver-postgres.ts and surface.ts. Each has `removedIn` 0.2.2-alpha.2 and `removeAfter` 0.2.2; the package is at 0.2.2-alpha.8, so all three are inside the window. The first version PR after 0.2.2 deletes the three keys, the three files (~42 lines) and the registry entries.
- **Deprecated media tool aliases:** domain/generated-tools.ts L84, seven aliases marked "removed in 0.3". Not due yet.
- **describe `nativeDatabaseDefaults` shim:** needed while 0.2.1 describe JSON can still be diffed; `nativeDatabase` arrived in 0.2.2.
- **`ponytail:` comments:** auth/adapter.ts L360 (one seed per isolate) and auth/identity.ts L321 (10,000 admins per role) name no condition that has been passed. bundle.ts L97 `shortcut:` likewise.

### Dependencies (every import site)

- **esbuild:** infrastructure/bundle.ts L17, scripts/bundle-compiler.mjs L3.
- **jsonc-parser:** infrastructure/wrangler.ts L5 only. It edits JSONC while keeping comments and formatting, which a few lines would not replace, so keep it.
- **yaml:** build/…/ManifestParser.ts L1, ManifestSourceSpans.ts L2.
- **pgsql-deparser:** build/d1/print.ts L6, build/postgres/print.ts L6.
- **libpg-query:** build/…/PgQueryParser.ts L20.
- **@pgsql/types:** type-only, build/core/sql/positions.ts L10 (see 13).
- **Peers:** every peer has a real import. `@better-auth/core`: authSchema, oauth, adapter, identity, caller. `@better-auth/oauth-provider`: caller L237 (dynamic) plus types. `better-auth`: generateAuth, authSchema, routes, caller. `@modelcontextprotocol/server`: kernel/mcp-handler.ts.

### Sub-areas that are lean

I found nothing to cut, beyond the items above, in:
- infrastructure: cli.ts (every flag is documented and tested), help.ts, init.ts, wrangler.ts, authSchema.ts, inputs.ts, mounts.ts
- bun/assets.ts, testing/index.ts
- auth: hardening.ts, admin.ts, route-http.ts, consent.ts
- usecase: search, ttl, web, handlers, site, refusals, tool-version
- usecase/validation.ts and domain/paging.ts proofs: these are trust-boundary and proof code, which I deliberately left untouched.
- The rest of bundle.ts: each guard backs a documented failure mode.

### Noticed in passing (correctness, out of scope)

1. scripts/alpha-matrix/prepare.mjs L73 and L86 run `@aotter/mantle/dist/cli/main.js`, which does not exist (the bin is `dist/infrastructure/cli.js`). The script also writes a `mantle.config.json` that the CLI never reads, so the whole script looks stale.
2. auth/identity.ts: `d1Identity` and `postgresIdentity` ignore `caller` (see 19). tests/auth-identity.test.ts L245-248 passes non-admin callers as if the caller decided the outcome; whether that test checks what it intends depends on `headers`.
3. usecase/generate.ts L146: a JSON input bind adds `"timestamp"` to the dialect values (`r.type === "date" ? "date" : "timestamp"` with `r.type === "json"`).
4. domain/adminOrder.ts has no `numeric` cursor kind while View paging and adminBindings do, so numeric(p,s) fields are silently not Admin-orderable. This may be intended.

net: -179 lines possible (SAFE: 151, BREAKING: 10, DECISION: 8; the removed-subpath stubs' ~42 lines at 0.2.2 are not counted)