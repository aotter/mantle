# Task-specific agent prompts

First install the small bootstrap skill:

```sh
npx skills add aotter/mantle
```

The installed skill locates the target project, resolves its actual SDK
version, and sends the agent to that package's CLI and docs. A GitHub skill
may be newer than npm: published 0.1.4 still uses the direct-authoring path;
0.1.5 adds full generated projects. Never assume a new flag exists without
checking the installed CLI.

## New full Cloudflare app

```text
Build a Mantle app on Cloudflare. Follow the installed mantle skill, pin one
exact stable SDK version, and use its project-generation path if supported.
Select the full default Spec, Runtime, API, MCP, Admin and blank home. Install
the CLI-declared dependencies and rerun generation. Ask for my actual data and
workflow before adding Manifests. For local Admin, copy .dev.vars.example,
set the real owner email and a random secret, and verify OTP, Admin assets,
unauthorized access, public API and MCP. Do not claim production Auth is set
up from a local OTP test.
```

## Small API or Spec-only app

```text
Use the installed Mantle CLI and version-matched docs. For a Cloudflare API,
select --host cf --features spec,api if that CLI supports project generation.
For manifest parsing only, use --features spec without a host. Keep unselected
Admin, Web and MCP packages out. Author the Schema and View I request, then
run generate, validate, typecheck and a real route probe when a host exists.
Preserve an existing direct-authored application instead of regenerating it.
```

## ChatGPT Sites

```text
Build with ChatGPT Sites and Mantle. Start from the installed SDK's generated
blank app when supported; otherwise follow that version's Sites reference.
Pin all selected Mantle packages exactly, install declared dependencies,
review and apply the initial local D1 migration, then add my Manifests and
review each appended migration. Configure OWNER_EMAIL and PUBLIC_ORIGIN. The
local owner smoke simulates Sites identity; deployed ChatGPT sign-in needs a
separate check. Show how I will maintain content through Admin, browser
WebMCP, public MCP and Sites-session staff MCP. Add R2 only if my workflow
requires uploads. Never deploy the Worker directly or claim remote staff OAuth
MCP from a Sites browser session.
```

## Existing project with typed queries

```text
Read this project's package.json, lockfile, installed Mantle package and
projected develop skill. Keep its host and selected surfaces. Use the installed
CLI's help and handbook to add the requested Schema/View/Procedure, then run
its generate/check, validation, TypeScript and host smoke. Do not use another
checkout's SDK docs or overwrite user-owned files.
```

[Back to the Core README](../README.md).
