# Mantle Cloud workflow

Use the user's application directory and its installed Core documentation.
`helper` below means the absolute path to this skill's
`scripts/mantle-cloud.mjs`; run `node <helper> ...` from that directory. The
plugin ships one `mantle` skill, not a separate host skill or npm host package.

## Select and open

Connect the configured Cloud MCP using member OAuth. For an existing project,
keep its organization, project ID, hosting link, source and access grants.
List organizations/projects through the discovered tools before selecting one;
create a project only for a new application. Tool names on MCP use underscores
(for example `cloud_create_project`, `cloud_host_contract` and
`query_view_member_project`). Read each discovered tool's input schema.

Call `cloud_host_contract` with that project ID before installing Core or
packing an application. It returns the exact Core version/revision and host
protocol. Install that Core version exactly, including optional UI packages.
Do not substitute the newest npm tag for Cloud's pin. Use the installed
package's new-project/develop instructions, then run generate and checks.
For an existing application, a version mismatch is an explicit upgrade task;
preserve its source and data until the user authorizes the upgrade.

For an existing Cloud project without a local checkout, call
`cloud_project_source` to inspect its repository and saved source history.
Obtain a five-minute read credential with `cloud_source_read_credential`, then
pipe that result to this command in an empty application directory:

```text
node <helper> open --project <id> --grant - --json
```

`open` clones the existing main branch and validates its hosting target; it
never overwrites a non-empty directory. Keep the project ID and hosting link,
inspect package/lockfiles, and install only the pinned dependencies. For an
older project without a Git repository, `cloud_static_source_discover` can
recover a retained source ZIP: verify SHA-256, extract into an empty directory,
retain its project identity, initialize Git and commit it before source admission.
If neither source exists, report the limitation instead of rebuilding over it.
A fresh application directory is not a new Cloud project.

## Prepare and save

Link once (retain an existing link):

```text
node <helper> link --organization <id> --project <id> --slug <slug> --dist dist
```

Use `--handlers <file>` for the application's custom handler module, or
`--service <file>` for a Cloud-compatible service with GET mounts declared by
`--mount GET:/path`. Read the installed SDK's service contract first: Cloud
provides its pinned Core, identity and storage; do not upload a self-hosted
Worker's platform wiring. The helper validates imports/mounts and generated
plans before upload. Its initial link requires the destination names to be
confirmed; use an already confirmed destination from this conversation when
available, and resolve any ambiguity before sending bytes.

Commit the hosting link, generated plan and application source. Keep local
secrets untracked. The frontend build output and `.mantle/host/` are ignored.
The helper never installs dependencies or executes build commands; review and
run the project's own checks/build. `esbuild` is a project dev dependency when
bundling handlers/services.

```text
node <helper> source --json
node <helper> save --json
```

Follow every literal `nextAction`. `source` requests
`cloud_source_write_credential`: supply `expectedVersion` from the project query
and confirm the destination using the existing authorization. Pipe the result
to `source --resume --grant -`. The helper performs an ordinary push of clean
HEAD and verifies the remote main hash; it never force-pushes, resets or merges
local work. It then requests `cloud_save_source_version` with the full commit,
target and persisted operation ID. Pipe that receipt to its printed command.
The sourceVersionId, commit and Core pin are persisted together; credentials
stay in memory. The entire repo is pushed, so `--omit` cannot hide tracked secrets.
A saved source is not a built artifact or a running preview.

`save` refuses a missing/stale source receipt and `--no-git`. Protocol 4 first
requests `cloud_host_contract`; pipe its result to `save --resume --grant -`.
The helper compiles/packs the committed backend and requests
`cloud_backend_upload` with sourceVersionId. Cloud checks the plan/YAML against
that fixed commit. Supply `expectedVersion` and pipe the result to its command.
It uploads, polls readiness and verifies the frontend kit SHA-256. It clears the
configured ignored build directory, refusing tracked source or symlink paths;
follow kit `AGENT.md`, build fresh static files and resume. The helper never runs
build commands itself. `cloud_static_frontend_upload` binds the source commit
and retained ZIP to the same Git tree, minus explicitly recorded omissions.
Pipe that result to the next command. Pairing finishes with `{versionId, commit}`.
Source is verified; client-built handlers/static output are not server build
attestation. Keep that distinction in the deploy review.

On interruption, use `status` and the existing source/save resume action. Reuse
the recorded operation ID and exact arguments; never create a new project or
invent a replacement upload on retry. Changed source requires a new commit,
`source`, then `save`. A competing push requires reviewing and merging locally;
there is no force-push fallback. A Cloud Core pin change requires a new source
receipt (`source --restart`) before saving again; an SDK upgrade also requires
regenerating and committing the plan. Version conflicts mean refresh and review
the project, never remove the expected-version check. Grants stay on stdin,
never shell arguments, source files or logs.

## Preview and publish

`paired` means saved, not published. Use the printed
`cloud_backend_preview_grant` action to test the paired frontend/backend
through its authorized entrance. The Builder's design graph proves manifest
structure only; it does not prove runtime behavior or tenant staff access.

For a requested hosted application, continue after checks and preview:

```text
node <helper> deploy <versionId> --json
```

It requests `cloud_paired_review`. Pipe that result to the printed command;
review the uploaders, source hashes, omitted paths, YAML/storage changes and
probe evidence. Make the resulting `cloud_publish_paired_release` call under
the user's existing authorization. A user with only edit access can save the
frontend but cannot upload a backend or publish; preserve that distinction.
Repeat only the same operation/arguments while the release is pending. Report
the returned release URL only when Cloud confirms it is serving. Keep `built`,
`uploaded`, `ready`, `paired`, `active` and `serving` distinct.

Save-only work stops at the saved version. A failed or interrupted publish is
resumed from Cloud state; do not claim it is live or mint a second release.
Preserve the existing audience, grants and domain. Mantle Cloud does not promise
Sites' owner-private defaults, SIWC, arbitrary Worker builds or connector APIs.

## Continue or roll back

Keep the same checkout/project ID. Edit the source, generate, check, commit and
save a new version; preview it before publishing. For an authorized rollback,
run `rollback` and follow its deployment-query/MCP next actions with the current
revision. Rollback is a release change, not a database restore.

Finish with the project path, exact Core version, saved version, observed
release state/URL, checks and verification limits. A local fixture is not a
successful authenticated Cloud deployment.
