# @aotter/mantle-host

Core publishes two things here:

- Shared upload rules for Mantle Cloud Control: `closed-module`, `static-artifact`,
  `source-zip`, `backend-artifact`, `pack`, `pack-backend`, `protocol` and `version`.
- The source and tests for the agent-facing `mantle-host` script.
  `pnpm --filter @aotter/mantle-host build` generates
  `skills/mantle-host/scripts/mantle-host.mjs` deterministically. `fflate` and
  `es-module-lexer` are bundled; the user's own esbuild is resolved at runtime.
  `pnpm --filter @aotter/mantle-host check:generated` compares the committed
  script byte for byte against a fresh build.

## mantle-host

```sh
node mantle-host.mjs link --organization <id> --project <id> --slug <slug>
node mantle-host.mjs save --json                   # then: save --resume --grant -  (MCP result on stdin)
node mantle-host.mjs status
node mantle-host.mjs deploy <versionId> [--review -] [--dry-run]
node mantle-host.mjs rollback [<versionId>] [--revision <hex>] [--deployment -]
```

`--json` prints one line per state transition,
`{ok, stage, state, versionId?, commit, verified: {contentHash, sourceHash, contractHash}, nextAction}`;
failures are `{ok: false, stage, error, detail?, nextAction}`. `nextAction` is a literal
`{kind: 'mcp'|'run'|'wait'|'build'|'fix', tool?, arguments?, command?, reason?, requires?, confirm?}`.
operationIds are generated, persisted in `.mantle/host/state.json` and only then printed, and
retries reuse them. The one value the script cannot know, `expectedVersion`, is described in
`requires` (`version` from `member-project`), never left blank. `command` names this script's
own absolute path.

The first `save` requests `cloud-host-contract`. Its `{projectId, core:
{version, revision}, protocol}` result supplies the Core pin before backend
bytes and their hash are made. Backend and static grants, polls, and the kit
must echo that pin. A changed pin requires `save --restart`.

- **Link file** `.mantle/hosting.json` (committed): `{schemaVersion: 1, targets: {<name>:
  {runtime: 'mantle-cloud', organizationId, projectId, slug, root?, handlers?, frontend?:
  {dist, spa?, build?}}}}`, or `{runtime: 'cloudflare' | 'chatgpt-sites', config?}` for targets
  whose native step is printed instead. Unknown keys, secret-shaped keys and token-shaped
  values fail with `link_file_invalid` and a JSON pointer. There is no origin or endpoint
  override anywhere: grant URLs must use `https://cloud.mantle.tools`,
  `https://cloud-staging.mantle.tools` or loopback. The first save after the link file changes
  asks for the organization and project names to be confirmed.
- **State** `.mantle/host/` (gitignored by `link`): ids, hashes, stages and the out
  directory; never a grant.
- **Source** comes from HEAD's Git objects (`git ls-tree -r -z` and one
  `git cat-file --batch`), never the working tree or `git archive`, so CRLF checkouts produce
  the same bytes. The tree must be clean (untracked non-ignored files count); submodules and
  symlinks are refused; secret-named files are rejected, never stripped (`--omit <path>` is
  explicit and recorded on the static receipt). Caps: 2000 files, 40 MB
  expanded, 42 MB archive. The canonical ZIP stores entries uncompressed, so Cloud checks
  it as views of the upload: the source PUT's peak memory is the body plus a few MB
  (`test/memory.test.mjs` measures about 46 MB at the caps). `--no-git` reads the working tree with the same rules and records `unversioned`.
- **Handlers** are bundled with the project's own esbuild as a function of HEAD: every
  project file the bundle reads comes from its committed blob (`handler_input_untracked`
  otherwise), only `node_modules` dependencies resolve from disk, and the app-root
  `tsconfig.json`/`jsconfig.json` is taken from HEAD (it may `extend` a package, not a file;
  nested tsconfig files are ignored). Every `package.json` above the bundled files inside the
  repository must be committed and unchanged; above the repository none may set `browser`,
  `imports` or `exports`. Repository filter drivers are switched off for `git status`.
- **Sandbox:** reads only under the project (plus an explicit `--grant-file`, and, for
  validation only, each `package.json` in the directories above the app root, since esbuild
  would read them), runs only `git rev-parse|status|ls-tree|cat-file` and
  `config --get-regexp ^filter\.` without a shell (no system/global config, hooks, fsmonitor,
  filter drivers or submodule recursion), writes only
  `.mantle/host/**`, `.mantle/hosting.json` and an appended `.gitignore` line, networks only
  to grant URLs, and never installs packages, runs the link file's build command, prints
  grants, reads `$HOME` or dumps the environment.
- **Protocol:** every Cloud request sends `x-mantle-host-protocol` (`src/protocol.mjs`, shared
  with Control) and `x-mantle-host-client: mantle-host/<version> sha256=<script sha>`. A 426
  or a higher `protocol.minimum` fails closed with `client_outdated`.

The Core pin belongs to Cloud's current deployment. A Core upgrade does not
require rebuilding this script while the host protocol and artifact rules stay
compatible.
