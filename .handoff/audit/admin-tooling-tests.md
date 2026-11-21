Read-only audit of /home/user/mantle. No files were changed and nothing was touched on GitHub.

Totals: about -94 lines possible in part A, about -1,088 in part B and about -762 in part C. Most of the safe savings come from deleting the broken `scripts/alpha-matrix/` (about 1,000 lines), sharing one local-D1 test harness across 9 test files (about 300), and dropping duplicated `dryRun false` test cases (about 150).

Things I kept on purpose, per the native-admin guide and CONTRIBUTING:
- Field projections: `settings`, `adminInfo`, `memberInfo` in `site.ts`.
- Authorization: every `deny`/`checkTarget`/`authorize` call, the logic in `authorization.ts`, and admission.
- Security checks: path-traversal refusals in `shell.ts`, preview request checks, URI and CSP checks.
- The application-seam options.
- Generated-code plumbing in `native.ts`. The generator in `packages/mantle/src/usecase/adminBindings.ts` (L150, L252, L382, L427) imports `nativePage`, `nativeStatistics`, `nativeText`, `entriesQuery` and `scalarNumber`, so these stay.

## A. packages/mantle-admin/src/** and package.json

1. src/types/auth.ts:L1-13: reuse: a copy of `OAuthConsentRequest`/`OAuthConsentInfo`, which `@aotter/mantle/auth/oauth` already exports (packages/mantle/src/auth/oauth.ts:L469-480). Delete the file; change admin/src/features/auth/auth-views.tsx:L2 to `import type … from "@aotter/mantle/auth/oauth"`.
   evidence: grep for both names finds only types/auth.ts, oauth.ts, consent.ts and auth-views.tsx. No `exports` key points at dist/types. check-boundaries.mjs allows non-internal subpaths.
   class: SAFE, ~13 lines

2. src/server/index.ts:L322-353: shrink: the `/collections`, `/views-manifest`, `/operations` and `/webmcp` routes each branch on `options.authorize`. The local `visibleMetadata` (L267-274) already returns the `sees(...)`-filtered metadata plus `catalogue` when there is no `authorize`. Make each route a single `visibleMetadata(c).then(m => …)`.
   evidence: L268-274 non-authorize branch returns `{...metadata, views: sees(...), operations: sees(...), webmcp: catalogue}`, the same values the ternaries return.
   class: SAFE, ~14 lines

3. src/server/index.ts:L392-412: reuse: `/views/{name}/export` repeats `viewPage`'s steps (L304-317): find, `deny`, `checkTarget`, `query`, `convert`, row mapping. Split out a `resolveView(c, name, params)` and call it from both. The authorization steps stay; only the duplicate goes.
   evidence: same order and calls in both blocks; `missing()` and the `views` set are shared.
   class: SAFE, ~8 lines

4. src/server/index.ts:L443-451 and L471-480: shrink: two separate `metadata.developerConsole === undefined ? [] : [...]` spreads become one.
   evidence: the paths `/developer/views/{name}` and `/developer-console` do not overlap each other or `/operations/{name}`, so route order does not matter.
   class: SAFE, ~5 lines

5. src/server/mcp.ts:L137, L165, L331 and L150/L157; src/testing/index.ts:L179-186: reuse:
   - The `^ui:\/\/mantle-admin\/` regex and its error are written three times; make it one const.
   - The catalog `<script id="mantle-catalog">` is built three times, by hand. Use `APP_CATALOG_ID` (src/app/bridge.ts:L8, today used only by bridge.ts) and `insertAppHead` (src/app-head.ts).
   evidence: `grep -rlw APP_CATALOG_ID` finds bridge.ts only; the string literal `mantle-catalog` is repeated in mcp.ts and testing/index.ts.
   class: SAFE, ~6 lines

6. src/build/mcp-check.ts:L450, L493 and src/build/index.ts:L138: yagni: three defaults that no caller relies on: `declared(…, kind = "resource")`, `checkMcpApp({ libraries = [] })`, `buildMcpApp(…, explicitEntry = false)`. Make the parameters required. mcp-check.ts is not re-exported from `./build`.
   evidence: callers are build/index.ts L122, L218, L513 and testing/index.ts L235, and every one passes the argument.
   class: SAFE, ~2 lines

7. src/server/design.ts:L1-39 and package.json `./server/design`: delete: `createAdminDesignSurface`/`DesignOptions` have no importer and no test.
   evidence: a grep of the whole repo (packages, docs, examples, scripts, .github) for `server/design|AdminDesignSurface|DESIGN_ONLY` finds only design.ts and package.json L99-101. The native-admin guide mentions "design preview" only in general terms, so a host outside the repo may be using it.
   Published subpath, so removal is BREAKING: needs a Migration line saying "no replacement", and no stub. If it is kept, it is the only check-free code on a published subpath.
   class: BREAKING, ~43 lines

8. src/server/index.ts:L52 and L538: yagni: `Route.preserveCacheControl` is an option nobody sets. Always force `private, no-store` on Response results.
   evidence: `grep -rn preserveCacheControl` across packages and docs finds only these two lines. No route in src, examples or tests sets it, and docs describe only `rawBody`/`bodyLimit`.
   Field of the public `Route` type on `./server`.
   class: BREAKING, ~2 lines

9. src/server/index.ts:L176: delete: `export { body }` re-exports `@aotter/mantle/rest`'s `body`, and nothing imports it from here. Only `json` (L178) uses it, internally.
   evidence: searching packages, docs and scripts for imports of `body` from `@aotter/mantle-admin/server` finds nothing.
   Named export removed from kept subpath `./server`; the author must declare it by hand.
   class: BREAKING, ~1 line

10. src/server/native.ts:L362: delete `export` on `nativeEntryData`: it is only called at native.ts:L425.
    evidence: the generator imports a fixed list (adminBindings.ts L150/L252) without it; zero hits in tests, docs or examples.
    Named export on `./server/native`.
    class: BREAKING, ~0 lines

The dependencies in package.json are lean. `class-variance-authority`, `input-otp`, `radix-ui` and `react-day-picker` have no import inside Admin, but they are required peers of `@aotter/mantle-ui` (see its package.json `peerDependencies`). `zod` is a required peer of `@modelcontextprotocol/ext-apps@2.0.4`. Every other dependency has an import site in src/, admin/, registry/ or the vite configs.

net: -94 lines possible (SAFE: 6, BREAKING: 4, DECISION: 0)

## B. Repository tooling

1. scripts/alpha-matrix/ (README 104, author.ts 311, e2e.mjs 314, extras.mjs 159, prepare.mjs 114): delete: this "opt-in release gate" no longer runs.
   evidence:
   - prepare.mjs:L73/L86 runs `@aotter/mantle/dist/cli/main.js`, but `bin` is `./dist/infrastructure/cli.js` and there is no `src/cli`.
   - It writes `mantle.config.json` presets and imports `../.mantle/generated/mantle.js` (`MantleHandlers`) and `CallerStore`. Grepping packages/mantle/src for `MantleHandlers|CallerStore` returns nothing.
   - The only things that invoke it are its own README and one dated record, docs/verification/20261004-alpha-host-matrix.md:L6 ("Reproduce with…"). Re-point that link at the tested commit.
   class: SAFE, ~1,002 lines

2. scripts/check-init-audit.mjs:L13-57 and L107-117: delete: an exception for alpha.6 only. `temporaryException = version === "0.2.2-alpha.6"` is never true now that the packages are `0.2.2-alpha.8`, so `onlyAlpha6Advisory` and its branch are dead. Run `npm audit --audit-level=high` unconditionally.
   evidence: package.json `"version": "0.2.2-alpha.8"`; the comment at L13 says "Alpha.6 only".
   class: SAFE, ~50 lines

3. packages/mantle-admin/package.json:L160: shrink: `test:browser` repeats the 13-file list that vitest.config.ts:L7 already selects when `MANTLE_BROWSER_TESTS=1`. Change it to `MANTLE_BROWSER_TESTS=1 vitest run`.
   evidence: both lists hold the same 13 paths; with the variable set, `include` is the `browser` array.
   class: SAFE, ~1 line (13 duplicated paths)

4. .github/workflows/ci.yml:L51-64 and L105-118, full-checks.yml:L74-87 and L114-127, release.yml:L626-645: reuse: the same four setup steps (pnpm/action-setup, setup-node 22 with pnpm cache, setup-bun 1.3.14, `pnpm install --frozen-lockfile`) are copied into 5 jobs. Move them into a local composite action under `.github/actions/setup`, so each pinned SHA is bumped once. This leaves the set of Full checks jobs alone (not a repeat of #2124).
   evidence: grep for `pnpm/action-setup|setup-bun|install --frozen-lockfile` gives the same SHAs at each of these places.
   class: SAFE, ~35 lines

Checked and fine:
- Every other script in scripts/ and packages/*/scripts/ is invoked by a package script, a workflow, a test or release-process.md. `capture-readme.ts` is a documented manual tool and still uses current paths.
- `ponytail:` comments: with-postgres.mjs:L10 and ci.yml:L3 state limits, not expiry conditions. check-packed-consumer.mjs:L310's condition (pnpm 10.16 or newer) has not been met: `packageManager` is `pnpm@9.15.0`.
- No duplicated or always-passing check found in ci.yml or release.yml. `with-postgres --notice` is the documented "SKIPPED" line.

net: -1,088 lines possible (SAFE: 4, BREAKING: 0, DECISION: 0)

## C. Test weight (packages/mantle/tests, packages/mantle-admin/tests)

1. packages/mantle-admin/tests/native/admin-request-matrix-classify.ts:L1-117: delete: a one-off classifier for the #1971 migration that diffs the golden file against `git show 13448146:…`.
   evidence: it does not match `tests/native/*.test.ts`. Grepping packages, scripts, docs and .github for `admin-request-matrix-classify` finds only the file itself. The live `admin-request-matrix.test.ts` reads the golden file directly (L29).
   class: SAFE, ~117 lines

2. 9 test files: reuse: each hand-rolls the same ~40-line local-D1 harness (wrangler.json, `wrangler dev --local` spawn, /health poll, process-group kill) that tests/apps/local-d1.ts already contains: paging-d1.test.ts:L42+, wire.test.ts:L144+, rest-native.test.ts:L73+, site-d1.test.ts:L33+, translations-d1.test.ts:L24+, mcp-media-d1.test.ts:L60+, auth-cookie.test.ts:L86+, admin-bindings.test.ts:L892+, and mantle-admin/tests/native/d1.test.ts:L29+. Change local-d1.ts to return `{ origin, stop }` instead of fixing on GET /verify. Coverage is unchanged.
   evidence: each of the 9 files has one `spawn(`, a `wrangler/bin/wrangler.js` path and `--inspector-port`.
   class: SAFE, ~300 lines

3. packages/mantle/tests/host-contract.golden.json (cells at L564, L1001, L1712, L1745, L2762), host-contract.test.ts:L143, L309, L379, L427, L724 and L735, gateway.test.ts:L72, L411, L610 and L752: delete: the `dryRun false` variants left over from the dry-run removal (#2101). The value cannot matter: kernel/host-caller.ts:L67 refuses by `Object.keys(props)` before reading any value. Keep `true` only.
   evidence: no `dryRun` handling remains in src apart from comments (grep of packages/mantle/src/kernel).
   class: SAFE, ~150 lines (142 golden plus loop edits)

4. The same files: delete: the remaining `dryRun true` cells: "refusal: dryRun true", rest, mcp ×2 and web `dryRun true`, and "web head HOST_CONTRACT dryRun".
   - Each surface already has a generic unknown-key cell that goes through the same refusal: "refusal: unknown key" at golden L544, "rest HOST_CONTRACT unknown key" at L1098, "mcp HOST_CONTRACT unknown key", "web HOST_CONTRACT unknown key" at L2795, and web head with `extra: 1` (test L438).
   - Keep the two "refused before a DB handle on a write" checks (gateway.test.ts:L607-618 `acquired`, and the host-contract.test.ts:L722 acquisitions) but use a generic key.
   It is a DECISION because it drops the explicit pin that a host still sending `dryRun` gets a refusal that names it.
   class: DECISION, ~195 lines

5. global-unique.test.ts:L77, live-edits.test.ts:L64, multi-item-procedure.test.ts:L75, procedure-steps.test.ts:L345, revisions.test.ts:L382, schema-lock.test.ts:L78, sql-patterns.test.ts:L145: seven skipped tests that nothing ever enables. They are gated on `MANTLE_NEXT_REST_D1`, which only full-checks.yml:L132 sets, and that step runs a fixed list of 8 files that includes none of these. Their only helper, tests/apps/local-d1.ts, therefore runs nowhere.
   They are the only local-D1 checks of schema locks, `onNoRows`, global unique, revision sealing and live edits, so do not delete them. Add the 7 files to that `bun test` line, or record them as manual.
   evidence: `grep -l MANTLE_NEXT_REST_D1 tests/*.ts` lists 8 files, of which only rest-native is in the list. No script or workflow sets the variable for these files.
   class: DECISION, ~0 lines (+7 file names)

6. 14 test env knobs: yagni: `MANTLE_NEXT_*_PORT` (12 of them), `MANTLE_ADMIN_D1_PORT` and `MANTLE_ADMIN_SOURCE_REST` have no setter in any workflow, script, package script or doc. Inline the literal values.
   evidence: grep of the variable names across .github, package.json files, scripts, docs and tests shows only the `?? "<port>"` reads.
   class: SAFE, ~0 lines

Checked and fine:
- Every other tracked non-test file is imported or read by a test or by verify-native.ts: the `*-scenarios.ts` files, the seams, the `smoke-kit-0.2.2-alpha.7.mjs` fixture, both other goldens, and all 21 YAML apps.
- The near-duplicate fixture pairs (publishing vs publishing-visibility, seams vs seams-handlers) differ in substance.
- Every other `test.skip` is env-gated on PostgreSQL or D1 variables that CI or Full checks sets.

net: -762 lines possible (SAFE: 4, BREAKING: 0, DECISION: 2)

## Noticed in passing (correctness and performance, out of scope)
1. server/index.ts:L381: `/bootstrap` returns `allCollections: m.allCollections` without the `?? Object.fromEntries(collections)` fallback that `/collections` (L328) applies. On the path without `authorize` it can be undefined.
2. server/site.ts:L485 and L511: `options.identity.directory(c)` is called a second time after `identity()` has already resolved it. With `d1Identity`, that rebuilds the directory, including `auth.get()`, per request.
3. Local-D1 tests share default ports: 8991 (global-unique, multi-item, revisions) and 8994 (admin-bindings, auth-cookie, live-edits). They are safe only because `bun test` runs files one after another.
