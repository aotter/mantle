# Handoff: ponytail slimming pass (2026-11-21)

Temporary directory on a work branch. **Delete `.handoff/` before any PR into `develop`.**

## Where things stand

- `develop` is at `9977936f`. Released: `0.2.2-alpha.8` (tag `v0.2.2-alpha.8`, npm `alpha`).
- Merged into `develop` after alpha.8, unreleased, intended for `0.2.2-alpha.9`: #2065 (pgsql-deparser 18.4.3, generated output byte-identical), #2132 (authorize keeps a 429; describe diff direction; Admin entry read authorized once), #2133 (host contract: `dryRun` removed).
- This branch (`claude/dazzling-goodall-15duxc`) = `develop` + two slimming commits + this directory. Nothing here has been through `pnpm check:pg` or Full checks.

## The task

The maintainer asked to slim Core in the spirit of `.agents/skills/ponytail/SKILL.md` and `.agents/skills/ponytail-review/SKILL.md`. Four read-only audits were completed; implementation had just started when work stopped.

| Area | Audit report | Implementation brief | SAFE lines |
|---|---|---|---|
| `packages/mantle/src/kernel` | `audit/kernel.md` | `briefs/kernel.md` | ~52 |
| `packages/mantle/src/build` | `audit/build.md` | `briefs/build.md` | ~271 |
| `src/{usecase,infrastructure,domain,auth}`, `package.json` | `audit/app.md` | `briefs/app.md` | ~151 |
| Admin src, repo tooling, tests | `audit/admin-tooling-tests.md` | `briefs/tools-implement.md` | ~1,700 |

Each audit classes its findings SAFE, BREAKING or DECISION. **Only SAFE items are approved.** The briefs say which SAFE items to do and which to skip, and why. Paths in the briefs that point at a scratchpad directory no longer exist: the output-dump script they mention is `dump-generated-output.ts` in this directory, and "create your own worktree" just means work on a branch.

## Done so far (both unverified beyond the author's local run)

- `refactor(describe): assign generic Admin route behavior directly` (app item 1).
- `refactor(admin): reuse Core's OAuth consent types` (admin part A item 1).

## Interrupted mid-item

`wip-patches/*.patch` are uncommitted diffs from four agents stopped mid-edit, against `9977936f`. They may not compile. Treat them as hints, not as work to apply:

- `kernel-uncommitted.patch`: kernel items 1 and 2 in progress (`json-body.ts`, `media-fetch.ts`, `web-index.ts`).
- `build-uncommitted.patch`: build item 1 in progress (`ViewAdminUiChecker.ts`, `ProcedureViewSpecChecks.ts`).
- `app-uncommitted.patch`: app item 2 in progress (`cursorKind` in `domain/columns.ts`).
- `tools-uncommitted.patch`: admin part A item 2 in progress (`server/index.ts`).

## The bar for every item

1. Re-verify the audit's claim before editing; drop the item if it does not hold.
2. Generated output byte-identical: run `dump-generated-output.ts` on `origin/develop` and on the branch, `diff -r` (about 6,700 files). For `domain/describe` changes also diff `describeApp` JSON; every `_meta.targetHash` must be unchanged.
3. No diagnostic code or message changes.
4. Startup budgets must not grow: rest 4623/7424, mcp 8701/8704, web 4379/8704, all 14081/14336, d1 14849/20480, cloudflare-postgres 58448/65536. `mcp` has 3 bytes of headroom: drop an item rather than raise a budget.
5. `pnpm format`, typecheck, `pnpm check:pg`. CI pins Bun 1.3.14 and a newer local Bun hides differences: also run touched test files with `npx -y bun@1.3.14 test <files>` from the package directory.
6. One finding per commit, so a bad one can be dropped alone.
7. PR into `develop` with the repository template, milestone 0.2.2; run the manual "Full checks" workflow on the PR head (about 7 minutes). Every Migration line must end by naming a replacement in backticks or with "no replacement", or the "Breaking changes declared" check fails. A pure SAFE pass has Migration "None."

## Explicitly not in this pass

- Composite setup action for the workflows (touches `release.yml`).
- `defaultLifecycle` parameter (rewrites 24 test fixtures; see the bug below).
- De-exporting about 95 file-local symbols (no lines saved).
- `fieldsOf` in `kernel/caller-identity.ts` was skipped only to avoid a parallel-edit clash with the test changes; it can be done once the test items land.

## Waiting for the maintainer (do not do without a decision)

BREAKING:
- `./server/design` in `@aotter/mantle-admin` (43 lines, no importer or test in the repo; published subpath).
- Admin `Route.preserveCacheControl`, the `body` re-export from `./server`, the `export` on `nativeEntryData`.
- Unused `caller` parameter of `d1Identity` / `postgresIdentity`.
- `draining` re-export from `./host-caller`; merging REST path-parameter parsers with `validation.ts` (changes a wire message).
- `dependencies` (always `[]`) in the hashed describe `behavior` (changes every `targetHash`).
- Spurious `timestamp` in generated `D` for a JSON input bind (changes generated output).
- Sharing the nullability reader between `core/sql/run.ts` and `compilePlan.ts` (changes paged View SQL).
- Constant developer-console fields left from schedule Triggers and `requires.guard` (Core and Admin must change together).

DECISION:
- Seven local-D1 test files never run in CI (`global-unique`, `live-edits`, `multi-item-procedure`, `procedure-steps`, `revisions`, `schema-lock`, `sql-patterns`): add them to the Full checks D1 step, or record them as manual. Recommended: add them.
- The remaining `dryRun true` test cells (about 195 lines) versus the generic unknown-key cells.
- The second allowlist pass `MantleDialect.check` (about 55 lines).
- Special refusal messages for removed features, including `AUTH_ROLE_REMOVED` (about 30 lines). Recommended: keep; #2131 goes the other way.
- `handlerTransaction`'s warning-phase overload (pinned by a test); the Bun-before-1.4 fallback in `dialect/sqlite.ts` (means declaring a Bun floor).
- Duplicate `"."` / `"./generate"` exports; `"./host-access"`; legacy recognition in `infrastructure/artifacts.ts` and `bundle.ts`.

## Bugs found during the audit (not slimming; no issue filed yet)

1. **Lifecycle default mismatch.** `SchemaAdminUiChecker.ts` (~L88, ~L306) and `SchemaIndexChecker.ts` (~L172) treat a missing `lifecycle` as `publishing`; production parsing defaults to `operational`. A Schema without `lifecycle` has valid list settings refused, and an index on a non-existent `status` column accepted. Not yet reproduced with a manifest.
2. **`tests/auth-identity.test.ts` ~L245-248** does not test what it suggests: `d1Identity` ignores `caller`, authorization comes from the session cookie in `headers`, and the test passes empty headers. "A non-admin is refused" has no test. Confirmed by reading.
3. **JSON input bind** adds an unused `timestamp` to generated `const D` (`usecase/generate.ts` ~L146). Confirmed by generating a minimal manifest. Harmless.
4. **Admin `/bootstrap`** returns `allCollections` without the fallback `/collections` applies (`server/index.ts` ~L381 vs ~L328). Not confirmed.
5. **Admin** resolves `options.identity.directory(c)` twice per request (`server/site.ts` ~L485, ~L511). Not confirmed.

## Other open threads

- #2129 App-only tools listed to a 2025-era client (needs discussion). #2130 verify `issue-status.yml` and the Full checks path for PRs into `main` at the next promotion. #2131 refusal messages should name what to use instead.
- `issue-status.yml` has never fired; issues are closed by hand with `pending-release` and a comment "Merged into develop by #N; it ships in the next release."
- Releasing: only when the maintainer asks; follow `.agents/skills/mantle-release/SKILL.md`. The startup and request-cost checkpoint is required before an alpha. The alpha.8 version PR is #2125 and its checkpoint comment is the baseline.
- Removed-subpath stubs (`src/removed/*`, `removeAfter` 0.2.2) are deleted by the first version PR after 0.2.2, not before.
