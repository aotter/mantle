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

Host a Mantle app on Mantle Cloud with the bundled script. It has three
targets: `mantle-cloud`, `cloudflare` and `chatgpt-sites`; only `mantle-cloud`
uploads anything. The other two print their native step (`pnpm exec wrangler
deploy`, or save and deploy in ChatGPT Sites); never wrap them.

Run the single-file script (Node 22+, no login) by absolute path, always with
`--json`: `node <this skill>/scripts/mantle-host.mjs <verb> --json`. Every
`nextAction.command` it prints already names its own path. Run it as printed.
Never edit the script; Core checks its bytes.

## Before you start

- The user asked to host on Mantle Cloud, or the project has `.mantle/hosting.json`.
  Do not link or upload during a local cold start.
- You need a shell, Git, the `mantle-cloud` MCP connection
  (`https://cloud.mantle.tools/mcp`, bundled with the plugin) and `esbuild` as an
  installed devDependency. The script never installs packages.
- Existing app: work from the user's Git checkout, or `open` it into an empty
  directory. Never rebuild an app from its deployed bundle.

## Flow

Publish by default. Stop after save only if the user asked to save without
publishing. Cloud checks deploy access, so there is no extra confirmation.

1. `link` once (`--organization --project --slug`, optional `--root --handlers
   --dist --spa --build`). Commit `.mantle/hosting.json`.
2. Commit your changes; `save` reads HEAD, not the working tree.
3. `save`, then follow each `nextAction` until the version is saved. The frontend
   build step follows the kit's `AGENT.md`.
4. `deploy <versionId>`: pipe `cloud_paired_review` to `--review -`, call
   `cloud_publish_paired_release` as printed, pipe its result to `--release -`.
5. Repeat the identical publish call while the script says `wait`. Only a final
   line with `url` means the site is live.
6. `open --project <id>`: restore the live source into an empty directory.
   Follows `cloud_static_source_discover`; it refuses a non-empty directory.

Also: `status` (local, no network), `rollback [<versionId>]` (code and assets,
never data), `deploy --dry-run`, `save --restart`, `--no-git`, `--omit <path>`.

## The nextAction contract

Each line is `{ok, stage, state, versionId?, url?, nextAction}`; a failure is
`{ok: false, stage, error, detail?, nextAction}`. `nextAction.kind` is:

- `mcp`: call `tool` with `arguments` exactly. Add only the fields `requires`
  names, reading each from the tool it names (`expectedVersion` is `version`
  from `query_view_member_project`). Pipe the result to `command`.
- `confirm`: show the user the organization and project names, then get a yes.
  A committed link file can point at someone else's project. This is the only
  confirmation.
- `run` or `build`: review the command, then run it. `frontend.build` is printed,
  never run by the script.
- `wait` or `fix`: do what `reason` says, then re-run the printed command.

Operation ids are saved before they are printed and reused on retry. Never invent
one. A saved or uploaded state is not published; only `url` means live.

## Safety

- Grants are short-lived bearer capabilities. Pipe them with `--grant -`, or
  `--grant-file` outside the repo. Never put one on the command line, in a file,
  in logs or in chat.
- The script talks only to `https://cloud.mantle.tools`,
  `https://cloud-staging.mantle.tools` and loopback. Nothing can add an origin.
- Secret-named files (`.env*`, `.dev.vars*`, `.npmrc`, `*.pem`, `*.key`) are
  refused by name, not content, and never stripped. Untrack them, or `--omit`
  them. Check credentials inside source files yourself.
- The link file holds ids, slug and paths only. Never add secrets, origins, or
  Cloudflare or Sites ids.
- Never install mantle-host from npm or run install commands it did not print.

## Talking to the user

Say what is happening and the result in plain words: "Saving your app",
"Publishing", "Your site is live: <url>". Leave out ids, hashes, grants,
operation ids and tool names. Speak up only when you need the user to act, or
for a blocker in plain language. Give a URL only from a final line with `url`
(active and serving). Do not fetch or test the live site afterwards. If
publishing needs more time, say so and repeat the call; do not report a URL yet.

## Errors

Every failure carries a `nextAction`. Common ones:

- `esbuild_missing`: add `esbuild` as a devDependency, install, commit the lockfile.
- `worktree_dirty`: commit or ignore the files; `--no-git` only for an unversioned save.
- `source_archive_secret_path`: untrack the file or `--omit <path>`.
- `client_outdated`: update the plugin; do not patch the script.
- `cli_core_mismatch`: run the printed `save --restart`.
- `link_file_invalid`: remove the key the JSON pointer names.
- Version conflict: re-read `query_view_member_project`; never overwrite others' changes.
