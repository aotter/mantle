# Cloud source gate: cloud-session handoff

The user requested stopping the local acceptance run and continuing in a cloud
session. Implementation is pushed; acceptance is incomplete. Do not mark the
original goal complete yet.

## Remote starting points

- Home: `aotter/mantle-home`, `develop` at
  `6f25bb81ef32c961431d694f402bb28fb4de62dc`.
- Home stack #316 → #317 → #318 merged with merge commits. Final staging
  deployment [37456824204](https://github.com/aotter/mantle-home/actions/runs/37456824204)
  succeeded, including deployment preflight and live Builder WebMCP smoke.
- Home source-gate tracking: [#314](https://github.com/aotter/mantle-home/issues/314).
- Core: [#1353](https://github.com/aotter/mantle/pull/1353), branch
  `feat/issue-1351-cloud-source-contract`, base `develop`; not merged.
  Implementation/tested tip before this documentation commit:
  `e7bec36b4f7bfb3ce085734923a130906668b18d`.
- Core tracking [#1351](https://github.com/aotter/mantle/issues/1351) remains open.
  No Core main merge, npm release or production deploy is authorized here.
- Vendored helper protocol 4 is pinned to Home
  `d596588b9d29f1f0b44fa9de84bd8a652274ee3f`, SHA256
  `70597d519e427f0febefc80c94b6c58ce2fb8577f7dade213f4cf02ca31abdc7`.

## What passed

- Home Control check: 173 passed / one existing skip. Host CLI: 68 passed /
  two platform skips. Final UTF-8/BOM and actual MCP pipeline checks passed.
- Core full local check constituents, 775 tests passed / 16 skipped / three
  todo (two workers); UI 214 passed. Core CI excludes plugin-only changes:
  these local results are the evidence, not a claim that CI ran those suites.
- Actual Core tip tarball consumer validation passed. Final doc-only tip
  produced the same package bytes as the fully tested implementation tip.
- Dedicated native Artifacts spike: 18 checks passed; its repository and
  short-lived credentials were deleted.
- Real staging OAuth MCP plus the exact PR helper: ordinary Git push → source
  receipt → fixed-commit admission → source ZIP and static pairing → private
  preview → reviewed publish. Anonymous private preview returned 403; the
  authenticated and public v1 UI both executed a real SQL View with HTTP 200.
- v1 publication reached both `active` and `serving`.
- `open` cloned the same project into a fresh directory at the saved commit.
- New commit without a receipt was refused. A new receipt for old main after
  main advanced was refused with `source_head_changed`; saved v1 review kept
  its original commit, receipt and source ZIP hash.

## Exact remaining acceptance

A dedicated, synthetic member-blog project is retained in staging. Discover
organization `Source gate staging E2E 20261006` and project
`Source gate E2E member blog` through the authenticated member catalog; do not
alter the pre-existing procurement project. The user can supply the private
checkpoint file alongside this handoff when exact IDs are needed.

1. Establish a fresh, staging-only MCP connection and legitimate Cloudflare
   Access transport in the cloud environment. Local tokens/cookies are not
   transferred. Read the cloud-environment skill and repository instructions.
2. Inspect current deployment and candidates before mutation. v1 is public;
   native Git main already contains synthetic v2. v2 was admitted but preview
   provisioning was blocked by `preview_account_capacity`.
3. Existing policy permits one disposable preview per account. A candidate
   expires after 30 minutes; the five-minute cron deletes its native resources
   before releasing the slot. v1 expired at 2026-10-06 20:15:16 Asia/Taipei;
   the next scheduled cleanup is 20:20. Do not bypass this check, edit D1 or
   delete another project's preview. Inspect actual cleanup rather than assume
   it happened. Old candidates may have expired by the next session: restart
   the save against the same verified source receipt when necessary.
4. Use the PR helper and normal MCP next actions to open/save/build/pair v2.
   Build output must be fresh after downloading its frontend kit. No force
   push, workspace SDK substitution or browser runtime recreation.
5. Verify private v2 preview and screenshot it. Review its fixed source receipt,
   then publish the exact saved version; retain identical operation arguments
   until `active` AND `serving`. Screenshot live v2 and execute its SQL View.
6. Review retained v1 in deployment history and roll back through the existing
   helper/MCP flow. Check the rollback operation becomes active and the same
   live URL serves v1. A rollback has a new deployment revision; do not wait
   for its hash to equal the historical target hash. It restores code, not data.
7. Delete only this disposable project using the existing versioned project
   deletion API, repeating the identical operation until `done`. This reclaims
   native Git, preview, Worker/D1/KV/R2 and retained artifacts. Verify absence.
   There is no organization-delete API: leave the empty test organization
   with project/deployment quotas zero using the existing staff operation.
8. Revoke the new test connection and delete transient credentials. Record
   generic evidence in Home #314, then close it only once these checks pass.
   Core #1351 remains open until its PR is integrated. Update the goal only
   after all required acceptance and cleanup is complete.

## Safe stop / limits

The local preview-wait process and OAuth callback server were stopped. The
specific test OAuth consent was removed and verified absent. No offline scope
or refresh token was granted. The already-issued one-hour JWT is self-contained:
consent deletion cannot revoke it immediately; it expires at 2026-10-06 20:28:08
Asia/Taipei. Local credential files are removed before handoff. Do not claim an
instant JWT revocation or copy it into the new session.

Git verification covers committed Manifest, plan and retained source ZIP. Build
outputs are produced by the client; no server build attestation is claimed.
Provider/source/preview lifecycle stays in Home. Core changes are the vendored
plugin helper and handoff contract, not Manifest grammar or Runtime adapters.
