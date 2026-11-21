## Kernel over-engineering audit: `packages/mantle/src/kernel/**`

The kernel is mostly lean. About 78 lines can go. Most of that is small duplicates, a few dead branches and one compatibility shim whose reason has expired. Nothing big is dead.

I changed no file and touched nothing on GitHub.

**How I checked "unused":**
- I ran `grep -rlw <symbol> packages/*/src packages/*/tests packages/*/scripts docs/examples scripts` (`*.ts|tsx|mjs|js|json|md`, excluding `tests/apps/.generated`) for every `export` in the kernel.
- I checked the `exports` map in `packages/mantle/package.json` and the classes in `public-surface.test.ts` (DEVELOPER, HOST, `./internal/*`).
- I checked the seam registry in `tests/application-seams.ts`.
- I grepped every generator string that imports a kernel module: `rg '@aotter/mantle/internal|internal/dialect' src/usecase src/domain src/infrastructure`.
  - Generated code imports `createStore, handlerStore, resultData, handlerTransaction` from `internal/store`.
  - It imports `page, Paged` from `internal/paging`.
  - It imports `userBinds` and `* as USER` (`scopeInsert, scopedAll, userRefs`) from `internal/user-fields`.
  - It imports the dialect and driver as whole namespaces (`* as DIALECT`, `* as DRIVER`), so I flag no dialect or driver export.

### SAFE (sorted by lines saved)

1. media-fetch.ts:L246-263: reuse: hand-rolled bounded stream read (chunks array, size cap, cancel, concat) duplicates `bytes()` in kernel/json-body.ts:L3-29. Widen `bytes` to take `{ body }` (a `Response` fits), call `bytes(response, maxBytes, () => { throw tooLarge() })`, and keep the try/catch that turns stream errors into `MEDIA_SOURCE_FAILED`.
   evidence: both loops read with a byte cap and `reader.cancel()`. media-fetch is loaded only on request (dynamic import in media-tools.ts:L48), so the startup graph does not change. json-body is a shared kernel file, so check-boundaries allows a media top to import it.
   class: SAFE, ~12 lines

2. web-index.ts:L278-292: reuse: the parameter types restate `PageEntry`/`PageSpec` and four `WebOptions` fields inline. Use `readonly Pick<PageEntry, "path" | "page">[]` and `Pick<WebOptions<unknown, unknown>, "origin" | "title" | "description" | "sitemap">` from web.ts (a type-only import).
   evidence: the only callers are web-serve.ts:L203 and tests/web.test.ts:L697,725. Both pass `{path, page}` objects, which still typecheck.
   class: SAFE, ~8 lines

3. mcp-server.ts:L61-68 + mcp-handler.ts:L33-42 (+ localized-schema.ts:L9-10): reuse: `isRecord` and `observe()` are copied byte for byte in both MCP files, and `isRecord` a third time in localized-schema. Export both from mcp-server.ts, which mcp-handler.ts:L11 already imports.
   evidence: `rg "const isRecord|function observe" src/kernel` finds exactly these three files.
   class: SAFE, ~8 lines

4. paging.ts:L10-21: delete: the `operation` parameter of `decodeCursor` and its 3-element and type branch. It becomes `Array.isArray(c) && c.length === 2`.
   evidence: the only caller is store.ts:L445, which passes no `operation`. Admin imports `decodeNullableCursor`, not `decodeCursor` (mantle-admin/src/server/native.ts:L14-22). No generator string names `decodeCursor` (`rg decodeCursor src/usecase src/domain src/infrastructure src/build` is empty). It is reachable through `./internal/paging`, which carries no promise.
   class: SAFE, ~7 lines

5. mcp-call.ts:L6-15: yagni: the eager `callTool` is a layer with one caller. Its only caller is the lazy forwarder at mcp.ts:L8, and it just wraps `callToolLazy(tool, raw, () => db, …)`. Write that forwarding in mcp.ts (`(await import("./mcp-call.js")).callToolLazy(tool, raw, () => db, caller, handlers, call)`) and delete the wrapper.
   evidence: `rg mcp-call` outside the kernel finds nothing. The public `callTool` (seam "call-tool", `./mcp`) keeps its signature.
   class: SAFE, ~6 lines

6. web-serve.ts:L161-169: delete: `if (segment === "." || segment === "..") return ""` in `segmentFor` is unreachable, because `urlFor`'s only caller, `validUrl` (L166-169), already returns `undefined` for such rows. Inline `urlFor` into `validUrl`.
   evidence: `rg "urlFor|segmentFor" src` finds only web-serve.ts. After the boolean conversion, a value is `"."` only if `row[key] === "."`, which `validUrl` has already refused.
   class: SAFE, ~3 lines

7. store.ts:L13-16: delete: the re-exports of `decodeCursor, encodeCursor, expand, renderTerm, SCOPE, TTL, Fact, Lock, ParentPolicy, Rules, Term`. Keep the imports and the `resultData` re-export. Same for user-fields.ts:L120: drop `rolesFrom`, keep `roleName`.
   evidence: generated code imports only `createStore/handlerStore/resultData/handlerTransaction` from `internal/store` (usecase/generate.ts:L356-360). Every other consumer imports these names from `kernel/store-rules.js` or `kernel/paging.js` directly (adminEntries, publishing, translations, stores, model.ts, tests). Admin imports only `roleName` and `modeOf` from `internal/user-fields` (mantle-admin/src/server/site.ts:L4, native.ts:L1). These are `./internal/*` subpaths with no promise.
   class: SAFE, ~2 lines

8. media-tools.ts:L10-11: reuse: `obj` is identical to media.ts:L101-102, and media-tools already imports media.js. Export `obj` from media.ts.
   evidence: both definitions read `v !== null && typeof v === "object" && !Array.isArray(v) ? v : {}`.
   class: SAFE, ~2 lines

9. web.ts:L259-260: shrink: `onAccess?` and `accessTargets?` restate `GatewayOptions`. Use `WebOptions<…> = {…} & GatewayOptions`.
   evidence: same member types as contracts.ts:L32-35. The type shape of `./web` is unchanged.
   class: SAFE, ~1 line

10. user-caller.ts:L29-30: shrink: `new TextEncoder().encode(value).length` is computed twice for the 1–256 byte check. Compute it once into a local.
    evidence: both lines are in the same condition. The same helper already exists as `bytes` (validation.ts:L14), and again as `size` (web-index.ts:L7) and in `likeTooLong` (where.ts:L10).
    class: SAFE, ~1 line

11. mcp.ts:L100: reuse: the local `type LocalizedText` duplicates localized-schema.ts:L3. Use `import type { LocalizedText }`; a type-only import adds nothing at startup.
    evidence: the two definitions are identical. `localized-schema` is already a dependency of mcp-server.ts:L18.
    class: SAFE, ~1 line

12. caller-identity.ts:L15: delete: `fieldsOf` is used only by tests.
    evidence: `rg -lw fieldsOf` finds caller-identity.ts plus tests (gateway, auth-caller, user-fields, host-contract). No src, admin, generator or docs use. The module has no subpath. Those four tests would need to read `identities` directly.
    class: SAFE, ~1 line

13. cron.ts:L1: delete (comment): "copied verbatim from Core's CloudflareCron … Core is retired with 0.2.0, so this copy becomes the only one". That condition is already true (the package is at 0.2.2, and `rg CloudflareCron packages/*/src` finds only this file). Say what the module does instead.
    evidence: no other cron converter exists in the repo.
    class: SAFE, ~0 lines

### BREAKING

14. host-caller.ts:L2: delete: `export { draining } from "./drain.js"`.
    evidence: nobody imports `draining` from `host-caller`. auth/routes.ts:L4, rest-router.ts:L4 and mcp-handler.ts:L7 import `./drain.js` directly. `rg draining` finds nothing in docs, skills, host-contract.golden.json, admin or examples. It is still a named export of `./host-caller`, which public-surface.test.ts classes as HOST ("names and paths stay"), so the PR needs the label and a Migration line.
    class: BREAKING, ~1 line

15. rest-dispatch.ts:L7-19: reuse: the path-parameter parsers `number`, `boolean` and `typed` duplicate `number` and `boolean` in validation.ts:L53-62. Export those and delete these.
    evidence: same parsing rules. The wire diagnostic would change ("Expected a number." becomes "Expected a valid number.", and path `rest` becomes the operation path), and that is wire behaviour.
    class: BREAKING, ~10 lines

### DECISION

16. store.ts:L170-174, L178-188: delete: `handlerTransaction`'s warning-phase overload. Its third argument is a callback, and its `get db()` runs that callback.
    evidence:
    - The current generator always passes the boolean `native` (usecase/handlers.ts:L52).
    - `NATIVE_DATABASE_UNDECLARED` is emitted nowhere in `src` any more (`rg` is empty), so the warning phase is over.
    - `./internal/store` is "regenerated with the SDK, no compatibility promise" (public-surface.test.ts), and the release notes require regenerating on upgrade.
    - But tests/handlers.test.ts:L582-611 ("warning-phase generated code keeps its transaction callback contract") deliberately pins it, so removing it is a maintainer decision.
    class: DECISION, ~14 lines (+~30 test lines)

17. dialect/sqlite.ts:L18-19: delete: the fallback `e?.name === "SQLiteError"` for "Bun before 1.4 omits `code`".
    evidence: CI uses Bun 1.4.4, but the repo declares no Bun minimum, and docs/handbook/guides/migrations.md:L285 still mentions Bun 1.3.14. Removing it means declaring Bun 1.4 as the floor.
    class: DECISION, ~1 line

**What I left alone:**
- Seam-marked exports (`callTool`, `body`, `convertInput`, `checkOrigin`/`surfaceFailure`, `withResult*`, `ToolCall`, `Tool.meta`, `McpAppResource.meta`, `clientAssets`, the transaction handle).
- Exports that are documented but have no internal caller: `./email` helpers, `hasAdminRole`, `toCloudflareCron`, `siteInfo`.
- Lazy forwarders and the dynamic-import splits. They exist for the startup graph, and rest-hook.test.ts and check-size enforce that.
- The `ponytail:` comments. All five still hold: none of the limits they name has been reached and none of their "upgrade when…" conditions has been met.
- The `now` parameter of `mediaLibrary`. Tests use it to control the clock.
- The fix for "Bun.SQL before 1.4" at driver/postgres.ts:L272. It also covers PostgreSQL's general rule that a failed statement aborts the transaction.

**Noticed in passing (not complexity):**
- store.ts:L455: the comment says "an ORDER BY column is NOT NULL … so no NULL placement", but the code emits `NULLS LAST` and handles a `null` cursor value (L449-452). The comment is stale.

net: -78 lines possible (SAFE: 52, BREAKING: 11, DECISION: 15)