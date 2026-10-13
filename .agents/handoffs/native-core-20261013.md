# Native Core implementation hand-off — 2026-10-13 (Taipei)

The owner canceled alpha.7 publication, then explicitly requested that every
unpublished source checkpoint be uploaded to GitHub. This is a source hand-off,
not authorization to release, deploy, mark ready, or merge failing code.
`develop` remains `560254bc552c666e0342f53ffef427cf957cff06`; the official tree
still contains Next. No existing maintainer branch was force-updated.

## Review entry points

| PR | Review scope | State |
|---|---|---|
| [#1559](https://github.com/aotter/mantle/pull/1559) | Canonical native Core replaces legacy Core/Next; pure UI plus optional Admin; shared authorized read templates and native Procedures; MCP parity/media/apps; docs/skills and native reference port | Draft, incomplete, do not merge |
| [#1560](https://github.com/aotter/mantle/pull/1560) | Minimal PostgreSQL UUID member search fix | Draft, also incorporated in #1559 |
| [#1561](https://github.com/aotter/mantle/pull/1561) | One primary cookie authority read, explicit official bounded read-cache opt-in | Draft, partial #1552, also incorporated in #1559 |
| [#1550](https://github.com/aotter/mantle/pull/1550) | Clean selected scalar/cursor conversion; bare native contract preserved | Draft, also incorporated in #1559 |
| [home#411](https://github.com/aotter/mantle-home/pull/411) | Neon code-only native deployment/admission pipeline | Existing Draft; live validation deferred |
| [#1555](https://github.com/aotter/mantle/pull/1555) | Release state table only | Publication canceled; not a release PR |

Choose the canonical replacement or sequence the minimal fixes and rebase it;
do not merge duplicate changes twice. Full int64 parity (#1526), offline
cross-dialect transfer (#1553/#1298), and real Neon staging are not complete.
No issue is closed by this hand-off.

## Exact canonical source

- Saved implementation: `bd840e0e374b0c34dad44bd04cb88d2beb74d836`, branch
  `feat/alpha7-functional-preview`.
- Clean one-commit PR view: `d72906b6caed7c843603d6f39dcef7d91de6ce63`, branch
  `feat/native-core-replacement-wip`, parent official develop `560254bc`.
- Both have tree `3154216851080bba0b563a6c193923dafc5e35c1`.
- Next is removed in this proposed source, not yet in official develop.
- SDK owns compiler/generator/CLI/native kernel. UI remains independent;
  Admin server/SPA/MCP App lives in `@aotter/mantle-admin`, using SDK as a peer.
- All 22 languages and developer workspace remain. No split SDK, new
  dependency, added minify, raised fixed ceiling or empty docs workaround.

## Actual verification and unresolved work

Three-package build and Core typecheck pass. Final selected SQLite/real-PG
checks: 53 pass / 548 assertions / 2 explicit D1 skips. Full Bun 1.3.14:
**1219 pass / 16 skip / 3 fail**. Failures remain in the private-build layer
rank check, the refusal mock pointing to removed lowered.js, and a PG
expected generated type missing bigint. The chained compiler suite did not
run after these failures; earlier compiler checks are not final-source proof.

Exact fourth tarballs installed outside workspace and native reference
generation passed. Strict reference types fail: missing generated/mcp-tools
composition export, readonly catalogue DTO mismatch, and D1 narrow Handle
variance. Complete Admin/member OTP browser and final packed Worker smoke
were not run. Fix SDK contract gaps in Core rather than hiding them with
application casts or legacy package aliases. No previous artifact's success
is substituted for this source.

Independent shared-Admin SQLite/PG/local D1 oracles cover scoped parent/TTL
visibility and private-field projection, nullable/microsecond cursor seek,
search binds, exact OCC/no-op writes, committed-write reply loss returning
503 once without retry, native empty drafts, real staff ref ctx.store and
one-query statistics. These are frozen component proofs, not the final
canonical packed/browser proof. A final legal-field probe reproduced bare
success versus selected Admin generation refusal for __proto__/constructor
Schema properties: GENERATE_UNSUPPORTED: {} is not iterable. It was not
fixed; no selected app or runtime SQL exploit was executed for that case.

Selected integer conversion independently passed safe/unsafe PG native
strings/bigints, exact three-page cursors, alias __proto__, direct CTE versus
computed aggregate results, native bare/Store/SQL Procedures, strict types,
one query per page/tool and zero SQL on rejected foreign cursors. The build
column dictionary bug was fixed; alias refusal is not the fix. #1550 final
Core1054 / Next1160, four native targets and true local D1 checks pass, while
packed 103091 B still exceeds its 102400 B ceiling by 691 B.

Cookie author real SQLite/PG/D1 checks observe 2 -> 1 authority reads; explicit
official cache hits use 0 authority reads, with tamper/TTL/version fallback,
primary mutation/KV guards and real legacy300 -> new60 version rollover.
Those counts exclude auth initialization, cookie minting and business SQL.
Automatic read-only MCP classification is absent; #1552 is not closed. The
independent cookie reviewer stopped with its extra fixture errors; no final
independent cache/baseline acceptance is claimed. UUID search's native suite
passes; its supplemental reviewer probe retained a wrong diagnostic
expectation failure rather than reporting the entire supplemental suite green.

MCP author snapshot has genuine scoped native four-target and D1/R2 proofs;
final-source focused tests passed with an explicit D1 skip. Its final
independent full review was not executed before stopping.

## Immutable diagnostic packages, not registry releases

| Package | Packed B | Unpacked B | SHA256 |
|---|---:|---:|---|
| SDK |830210|2580978|fe0252303c3c678ffacbbf26611fc306031971df0a43514d4b15f4c3ce4c8fad|
| UI |69761|315186|7c14d0928b38c24818a5bbc16a97df52acd7e17452a133f75e5bcbb12e42d64f|
| Admin |787266|2699299|b8d809cab701345c7eac5c99b2522053634384cb9b16da98c800455b5b7133b4|

The preview retains version alpha.6, but is not the published alpha.6 package.
SDK runtimeBytes147760. Fixed packed102400 / unpacked393216 and existing
runtime140286 limits **FAIL**. Final full per-surface deployment/startup
measurements were not run, and no matched complete-package before baseline
or actual CF cold-start/DB latency improvement is claimed. Keep failures
visible; do not raise or disable gates. Raw benchmark captures, private
application data, credentials, local databases and tarballs are not Git payload.

## CI/release preparation

The state table was posted in Draft #1555 before workflow preparation.
Local topology source `5f068abdd0c19f644caf6bffbdc2f3dfcf797ac1` is now on
GitHub and included in #1559. Independent package-order and missing source
PG environment negative checks passed. This is not release safety approval:
the existing all-published tagged-recovery rule can skip a previously failed
public consumer on retry and proceed to promotion. That baseline
counterexample is deferred to a separate release decision, not silently
redesigned here. No version, tag, registry/channel, provider or deployment
mutation occurred. Swolhalla is owned by the other session.

## Frozen sources and archive usage

See [the upload inventory](./native-core-upload-inventory-20261013.md).
Feature branches are component provenance. Archive branches preserve older
or superseded snapshots, including uncommitted borrowed-dependency and
port-verification state; they are **not candidates to merge wholesale**.
In particular the old single-SDK/uniform-SQL/combined prototypes must not
replace the clean canonical source.

Author/reviewer temporary Workers, states and own PG schemas were cleaned.
No other session's resources were stopped. All new PRs stay draft; no new
implementation, test suite, rebase, ready/merge or release was performed
while uploading this hand-off.
