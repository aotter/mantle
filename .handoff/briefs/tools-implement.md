The coordinator sent a message while you were working:
Now implement your SAFE findings. The maintainer asked to slim Core in the ponytail spirit; only SAFE items go in this pass.

Workspace: do NOT edit /home/user/mantle itself (other agents work in parallel). Create your own worktree: `cd /home/user/mantle && git fetch origin develop && git worktree add /home/user/wt-slim-tools -b slim/tools origin/develop` (develop is 9977936f), `cd /home/user/wt-slim-tools && pnpm install --frozen-lockfile`. Commit there; do not push, do not touch GitHub.

Do:
- Part A: SAFE items 1-6.
- Part B: items 1 (delete `scripts/alpha-matrix/`; re-point the link in docs/verification/20261004-alpha-host-matrix.md at the tested commit as you proposed; grep the whole repo incl. docs, CONTRIBUTING, release-process, skills, package.json for any other reference and fix it), 2 (the alpha.6-only audit exception) and 3 (`test:browser` list). SKIP item 4 (the composite setup action): workflow edits before a release are out of this pass.
- Part C: items 1 (the one-off classifier), 2 (share the local-D1 harness across the 9 files: coverage must be unchanged, and you must actually RUN those tests with their env vars set as `.github/workflows/full-checks.yml` does — `MANTLE_NEXT_*_D1=1`, `MANTLE_NATIVE_TESTS=1`, `MANTLE_ADMIN_LOCAL_D1=1` — before and after, same pass counts; if Wrangler cannot run here, do not do this item and say so) and 3 (`dryRun false` duplicates: keep exactly one `false` assertion in one place that proves the value does not matter, so the ADR-0046 sentence "true or false" stays tested; regenerate the golden with its own switch, never by hand). SKIP item 6 (env knobs). Do NOT do the DECISION items (4, 5) or any BREAKING item.

Other agents are editing `packages/mantle/src/{kernel,build,usecase,infrastructure,domain,auth}` in parallel: do not edit files there.

Verify: `pnpm format`, typecheck, `pnpm check:pg` (keep the worktree clean while it runs), `pnpm check:init-audit` (needs network) after B2, the Admin browser tests after B3 (`pnpm --filter @aotter/mantle-admin test:browser` with Chrome at /usr/bin/google-chrome via MANTLE_TEST_CHROMIUM — same 13 files and test count as before: 13 files, 50 tests), `pnpm check:ui-size` (Admin sizes must not grow), startup budgets unchanged, and touched test files on Bun 1.3.14 (`npx -y bun@1.3.14 test <files>` from the package directory).

Also: confirm or refute, with evidence and WITHOUT fixing in this branch, the two things you noticed: (a) `/bootstrap` returning `allCollections` undefined on the path without `authorize`; (b) `options.identity.directory(c)` resolved twice per request in server/site.ts.

Commits: small and conventional (`chore: …`, `test: …`, `refactor(admin): …`), each ending with

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JiQg1hWZuEYJtAUeG1yKdJ

Report: per item done/dropped (with reason), net lines (`git diff --shortstat origin/develop`), test counts before/after for the D1 files, check results, the two confirmations, branch name and commit list.

Address this before completing your current task.