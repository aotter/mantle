---
name: mantle-host
description: Link, save, deploy, roll back and check a Mantle app on Mantle Cloud with the bundled mantle-host script. Use when the user picks the mantle-cloud deploy target, or asks for the deploy status of a project that has .mantle/hosting.json. Cloudflare and ChatGPT Sites targets only get their native step printed.
metadata:
  source: aotter/mantle
  sourcePath: skills/mantle-host/SKILL.md
  applies_to: mantle-host protocol 2
  projection: plugin
  projectionReason: Ships only in the root plugin with its deploy script; Cloud deploy is opt-in.
  internal: true
---

# Mantle Host

`mantle-host` is one runtime-neutral deploy tool with three same-level
targets: `cloudflare`, `chatgpt-sites` and `mantle-cloud`. In v1 only
`mantle-cloud` uploads anything. For the other two it prints their native
step: `pnpm exec wrangler deploy`, or save and deploy the version in ChatGPT
Sites. It never wraps `wrangler`.

The script is `scripts/mantle-host.mjs` in this skill's directory. It is a
single file with no dependencies. It is generated from `packages/mantle-host` in Mantle Core and committed
with the plugin. The script has no login. Run it with Node 22 or newer, by absolute path:

```sh
node <absolute path to this skill>/scripts/mantle-host.mjs <verb> --json
```

Every `nextAction.command` the script prints already names its own absolute
path. Run that command as printed.

## Preflight

1. The user asked to ship to Mantle Cloud, or the project already has a
   `.mantle/hosting.json` target. Do not link or upload during a local cold
   start.
2. You have a shell, Git and a Cloud MCP connection with the `member-*` and
   `cloud-*` tools. MCP clients without a shell are not supported in v1.
3. `esbuild` is a devDependency of the project and is installed. Every
   `mantle-cloud` save bundles the handler module with the project's own
   esbuild, and the script never installs packages. If it reports
   `esbuild_missing`, add `esbuild` as a devDependency, install it, and commit
   the lockfile.
4. For an existing app, work from the user's Git checkout. You can also
   restore the source snapshot through Cloud MCP. Do not rebuild an app from
   its deployed bundle.

## The nextAction contract

Pass `--json`. Each line is `{ok, stage, state, versionId?, commit, verified,
nextAction}`, and a failure is `{ok: false, stage, error, detail?,
nextAction}`. `nextAction` is `{kind, tool?, arguments?, command?, reason?,
requires?, confirm?}`, where `kind` is `mcp`, `run`, `wait`, `build` or `fix`.
Follow it literally:

- `mcp`: call `tool` with `arguments` exactly as given. Add only the fields
  that `requires` names, and read each one from the tool it names. For
  example, `expectedVersion` is the `version` from `member-project`. Then pipe
  the tool result on stdin to `command`.
- `confirm`: before you call the tool, show the user the organization and
  project names from `member-organization` and `member-project`, and get a yes.
  A committed link file can point at someone else's project.
- `run` or `build`: review the command, then run it. The script prints the
  link file's `frontend.build` command but never runs it.
- `wait` or `fix`: do what `reason` says, then re-run the printed command.

The script generates operationIds and saves them before it prints them. Never
invent one. After a lost reply, re-run the printed command, because retries
reuse the saved ids. Local `built` or `uploaded` does not mean Cloud `ready`
or `paired`, and neither one means an `active` release.

## Verbs

| Verb | Use |
|---|---|
| `link --organization <id> --project <id> --slug <slug> [--root <dir>] [--handlers <file>] [--dist <dir>] [--spa] [--build "<command>"]` | Once per project. Writes `.mantle/hosting.json` and gitignores `.mantle/host/`. Commit both. `--runtime cloudflare\|chatgpt-sites [--config <file>]` adds a native target. With several targets, pass `--target <name>` to every verb. |
| `save [--omit <path>]... [--no-git] [--restart]` | Checks HEAD and prints the `cloud-host-contract` call. Pipe its result to `save --resume` to pack for Cloud's Core and receive the backend upload call. |
| `save --resume [--grant -]` | Continues with the Cloud MCP result piped on stdin. It uploads, polls until `ready`, gets the frontend kit, pairs, and ends with a saved version `{versionId, commit}`. That version is paired but not published. |
| `status` | Reads local state without network access and prints the next step. |
| `deploy <versionId> [--review -] [--dry-run]` | Reviews the version, then prints the `cloud-publish-paired-release` call. `--dry-run` stops after the review. |
| `rollback [<versionId>] [--revision <hex>] [--deployment -]` | Prints the `cloud-rollback-project` call. This restores code and assets, not data, identity or connection policy. |

`--help` prints the usage and `version` prints the script and protocol
versions.

## Save, then deploy separately

1. Edit the manifests and the handler module, then commit. `save` reads HEAD's
   Git objects, never the working tree. It refuses a dirty tree (untracked
   files count), submodules and symlinks. The commit is a label on the version,
   not provenance. `--no-git` saves an unversioned copy, and there is no
   `--allow-dirty`.
2. The script rejects secret-named files such as `.env*`, `.dev.vars*` and
   `*.pem`, and it does not strip them. Untrack them, or pass
   `--omit <path>`. The script records each omitted path and shows it to the
   deployer. Filename rules miss credentials inside source files, so check
   those yourself.
3. Run `save --json` and follow each `nextAction` until you have the saved
   version. For the frontend, follow the kit's `AGENT.md`, build into the link
   file's `dist`, and run the printed `save --resume`. A changed backend needs
   a new save.
4. Publishing is a separate, reviewed step for someone with deploy access.
   Run `deploy <versionId>` and pipe `cloud-paired-review` to
   `--review -`. Show the deployer the rendered review: hashes, uploaders, the
   unverified commit label, file lists, omitted paths, YAML diff, migration
   and probe evidence. Then call `cloud-publish-paired-release` as printed, and
   repeat the same call until `release.active`. There is no one-step
   upload-and-publish.

## Grants

Cloud MCP grants are short-lived bearer capabilities. Pipe them on stdin with
`--grant -`, or pass `--grant-file <path>` with a path outside the
repository. Never put a grant on the command line, in a repository file, or in
logs or chat. The script never prints a grant. It sends requests only to the
Cloud origins built into it (`https://cloud.mantle.tools` and
`https://cloud-staging.mantle.tools`), plus loopback (`localhost`,
`127.0.0.1`, `[::1]`) for a local Control or test server. Nothing in the link
file or the environment can add an origin.

## Link file

`.mantle/hosting.json` is the one committed deploy link file:

```json
{
  "schemaVersion": 1,
  "targets": {
    "production": {
      "runtime": "mantle-cloud",
      "organizationId": "<uuid>",
      "projectId": "<uuid>",
      "slug": "<slug>",
      "handlers": "handlers/index.ts",
      "frontend": { "dist": "dist", "spa": true }
    },
    "self-host": { "runtime": "cloudflare", "config": "wrangler.jsonc" },
    "sites": { "runtime": "chatgpt-sites", "config": ".openai/hosting.json" }
  }
}
```

It holds ids, the slug and paths only. It has no secrets and no endpoint or
origin override. The script rejects unknown keys, secret-shaped keys and
token-shaped values with `link_file_invalid`. `cloudflare` and
`chatgpt-sites` targets only point at their own config, and their ids stay
in that config. Local state lives in `.mantle/host/`. That directory is
gitignored and never holds a grant.

## Diagnostics

| Symptom | Cause | Fix |
|---|---|---|
| `esbuild_missing` | The project does not declare or install esbuild. | Add `esbuild` as a devDependency, install it, and commit the lockfile. |
| `handler_input_untracked` | The handler bundle reads a file that is not committed. | Commit the file, then save again. |
| `worktree_dirty` | There are uncommitted or untracked files. | Commit or ignore them. Use `--no-git` only when the user wants an unversioned save. |
| `source_archive_secret_path` | A secret-named file is committed. | Untrack it, or pass `--omit <path>` so the deployer sees the omission. |
| `link_file_invalid` with a JSON pointer | The link file has an unknown key, a secret or an endpoint. | Remove the key the pointer names. Never add origins. |
| `grant_inline_refused` | A grant was passed as an argument. | Pipe the tool result to `--grant -`. |
| `client_outdated` | Cloud requires a newer host protocol. | Update the `mantle` plugin, or re-run `npx skills add aotter/mantle --skill mantle-host`. Do not patch the script. |
| `cli_core_mismatch` | Cloud changed its Core pin during this save, or the pending save predates Core negotiation. | Run the printed `save --restart` command. |
| `core_pin_invalid` | The Cloud contract did not supply a usable Core version and revision. | Repeat the printed `cloud-host-contract` call and pipe its result. |
| Version conflict | Someone else changed the project. | Re-read `member-project`. Do not overwrite their change. |

## Don't

- Don't run install commands that the script did not print, and don't
  install mantle-host from npm.
- Don't edit `scripts/mantle-host.mjs`. Core verifies its bytes against a fresh build and sends
  its SHA-256 to the Cloud.
- Don't publish during `save`. Deploy is a reviewed step for someone with
  deploy access.
- Don't wrap `wrangler` or ChatGPT Sites. Use their native steps.
- Don't copy Cloudflare or Sites ids into `.mantle/hosting.json`.
- Don't report a live URL before `release.active` and a live check.

## When you're done

Report the target, the saved `versionId` and commit label, any omitted
paths, and whether the version is only saved or published. For a published
release, also report the live URL and the check you ran against it.
