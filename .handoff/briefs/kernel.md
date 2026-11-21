Repo aotter/mantle, local clone /home/user/mantle (you are in an isolated worktree). `git fetch origin develop`, create branch `slim/kernel` from `origin/develop` (9977936f). Commit there; do NOT push, do not touch GitHub. Read AGENTS.md, CONTRIBUTING.md, packages/mantle/AGENTS.md and `.agents/skills/ponytail/SKILL.md` first.

The maintainer asked to slim Core in the ponytail spirit. A read-only audit of `packages/mantle/src/kernel/**` produced the SAFE findings below (internal only: no public type/export/behaviour/generated-output/startup-graph change). Implement them. Re-verify each claim yourself before editing (grep callers across `packages/*/src`, `packages/*/tests`, `docs/examples`, `scripts`, and generator strings under `src/usecase|domain|infrastructure|build` that import kernel modules by subpath); if a claim does not hold, or the change would alter behaviour, wire output, a public type's shape, a diagnostic or the startup graph, DROP the item and say why.

1. media-fetch.ts ~L246-263: hand-rolled bounded stream read duplicates `bytes()` in kernel/json-body.ts ~L3-29. Widen `bytes` to take `{ body }` (a Response fits) and call it, keeping the try/catch that turns stream errors into `MEDIA_SOURCE_FAILED`. (media-fetch is loaded by dynamic import from media-tools.ts; check-boundaries must still pass.) ~12 lines.
2. web-index.ts ~L278-292: parameter types restate `PageEntry`/`PageSpec` and four `WebOptions` fields inline; use `Pick<…>` from web.ts via a type-only import. ~8 lines.
3. mcp-server.ts ~L61-68, mcp-handler.ts ~L33-42, localized-schema.ts ~L9-10: `isRecord` and `observe()` duplicated; export from mcp-server.ts (mcp-handler already imports it). Check the startup graph is unchanged. ~8 lines.
4. paging.ts ~L10-21: `decodeCursor`'s `operation` parameter and its 3-element branch: the only caller (store.ts ~L445) passes none. ~7 lines.
5. mcp-call.ts ~L6-15: eager `callTool` wrapper has one caller (the lazy forwarder at mcp.ts ~L8); forward to `callToolLazy(tool, raw, () => db, …)` from mcp.ts and delete the wrapper. The public `callTool` (seam "call-tool", `./mcp`) keeps its signature. ~6 lines.
6. web-serve.ts ~L161-169: `if (segment === "." || segment === "..") return ""` in `segmentFor` is unreachable because `validUrl` already refuses such rows; inline `urlFor` into `validUrl`. Prove unreachability carefully (path-traversal adjacent: if in any doubt, drop). ~3 lines.
7. store.ts ~L13-16: re-exports of `decodeCursor, encodeCursor, expand, renderTerm, SCOPE, TTL, Fact, Lock, ParentPolicy, Rules, Term` unused through `internal/store` (generated code imports only `createStore, handlerStore, resultData, handlerTransaction`); keep imports and the `resultData` re-export. user-fields.ts ~L120: drop the `rolesFrom` re-export, keep `roleName`. ~2 lines.
8. media-tools.ts ~L10-11: `obj` identical to media.ts ~L101-102; export it from media.ts. ~2 lines.
9. web.ts ~L259-260: `onAccess?`/`accessTargets?` restate `GatewayOptions`; intersect instead (public type shape must be identical). ~1 line.
10. user-caller.ts ~L29-30: `new TextEncoder().encode(value).length` computed twice; compute once. ~1 line.
11. mcp.ts ~L100: local `type LocalizedText` duplicates localized-schema.ts ~L3; type-only import. ~1 line.
13. cron.ts L1: stale comment ("copied verbatim from Core's CloudflareCron … Core is retired with 0.2.0"); say what the module does.
Also: store.ts ~L455 comment says an ORDER BY column is NOT NULL so no NULL placement, but the code emits `NULLS LAST` and handles a null cursor value; fix the comment to match the code.

Do NOT do: removing `fieldsOf` from caller-identity.ts (another agent edits the tests that use it), the `draining` re-export in host-caller.ts, merging rest-dispatch.ts path-parameter parsers with validation.ts, `handlerTransaction`'s warning-phase overload, or the Bun-before-1.4 fallback in dialect/sqlite.ts. Stay inside `packages/mantle/src/kernel/**` plus minimal call-site edits; other agents edit `src/build`, `src/usecase`, `src/infrastructure`, `src/domain`, `src/auth`, tests and scripts in parallel.

Verify and report evidence:
- Startup budgets must not grow: rest 4623/7424, mcp 8701/8704, web 4379/8704, all 14081/14336, d1 14849/20480, cloudflare-postgres 58448/65536. mcp has 3 bytes of headroom: an item that adds startup bytes is dropped, never the budget raised. Check after each item that touches a module in the startup graph (`pnpm check:startup` and the size checks that print these lines).
- Generated output byte-identical: `/tmp/claude-0/-home-user/2a4793ed-0877-51aa-ab4c-ab47e02367c9/scratchpad/dp2065/dump.ts` (read it for usage) dumps every fixture/example on four targets (~6,700 files). Run it on a clean `origin/develop` checkout (make your own second worktree with `git worktree add`) and on your branch; `diff -r`; report file count and result.
- `pnpm format`, typecheck, `pnpm check:pg` (PostgreSQL included; keep the worktree clean while it runs; rerun once if it stalls in bundle tests), and the kernel-related test files on Bun 1.3.14 (`npx -y bun@1.3.14 test <files>` from packages/mantle; CI pins that version).

Commits: small, conventional (`refactor(kernel): …`), each ending with

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiQg1hWZuEYJtAUeG1yKdJ

Report: per item done/dropped (reason), `git diff --shortstat origin/develop`, budgets, byte-comparison result, check results, commit list.