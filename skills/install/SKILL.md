---
name: install
description: Start a Mantle site from a deterministic starter bundle, or orient an existing generated site without rebuilding SDK boilerplate.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/install/SKILL.md
  applies_to: mantle@v0.1.0
---

# Mantle Install

If the directory already contains `.mantle/launch-state.json` or depends on
`@aotter/mantle`, continue that project. Otherwise materialize a deterministic
bundle into a new directory. Never use the Mantle SDK checkout as the site.

## Choose a bundle

| Intent | Type |
|---|---|
| API/MCP backend or empty base | `blank` |
| Small public/company site | `presence` |
| Form or application flow | `intake` |
| Blog, docs, or editorial site | `publication` |
| Catalog or order intent | `transaction` |
| Booking/request intent | `reservation` |
| Member/participation intent | `community` |

Ask only when two choices would materially change the product. Require Node
22+ and pnpm 9+.

## Materialize

Use the immutable provision bundle, which is also the path Mantle Landing
uses. Match the starter tag to the requested Mantle version; use `develop`
only for explicitly unreleased work.

```bash
git clone --depth 1 --branch <starters-ref> \
  https://github.com/aotter/mantle-starters.git <temporary-starters-dir>
pnpm --dir <temporary-starters-dir> materialize <type> \
  --out <target-dir> \
  --project-name <slug> \
  --brand "<brand>" \
  --description "<one sentence>" \
  --locales <comma-separated-locales>
```

Do not copy `blank/`, manually merge overlays, or edit bundle JSON.

## Orient the engineer

Read only the surfaces relevant to the change:

1. `manifests/` — product/data/API contract.
2. `src/index.ts` — minimal Cloudflare Worker entry.
3. `src/handlers.ts` and nearby services — only when custom business logic
   exists.
4. `public/index.html` or another imported UI path — project-owned visible UI.
5. `wrangler.jsonc` — bindings, public vars, and deploy configuration.

`.mantle/generated/` and projected Mantle skills are reproducible outputs.
Run `mantle generate`; do not hand-edit them.

The minimal tree hides old boilerplate without removing ownership:

| Former generated surface | Supported customization path |
|---|---|
| `src/mantle/config.ts` | Use façade options or typed `extend`; switch the Worker entry to the public low-level Cloudflare composition recipe when full control is required. |
| Full Kiwa tree | Edit the materialized page directly. Copy/eject only a selected component into project-owned source when genuinely needed; `v0.0.11-alpha.63` is the last full historical catalog. |
| Overlay seed files | Edit the materialized UI/content contract. Recover an alpha.63 seed only as reference; create stored content through Admin, Staff MCP, Procedures, or typed runtime use cases. Test fixtures may still seed test databases. |
| Repo-local updater | Prefer or wrap installed `mantle update`. A project may own a deliberate replacement; Core never overwrites authored tooling. |

This follows the shadcn model: the default is maintained and small; selected
source can become project-owned and freely editable. It is not a lint rule or
framework lock. For concrete façade, low-level composition, selected-source,
seed, and updater recipes, read
`node_modules/@aotter/mantle/docs/site-overrides.md`.

## Verify

```bash
cd <target-dir>
git init -b main
pnpm install --frozen-lockfile
pnpm exec mantle generate
pnpm exec mantle generate --check
pnpm validate
pnpm typecheck
pnpm check
pnpm dev
```

For `blank`, request its declared public View and expect an empty successful
result before content exists. For UI archetypes, open `http://localhost:8787`
and verify `/`. Auth-gated routes may return `503 setup_incomplete`.

For an existing project, first read its installed versions, `.mantle` handoff,
local projected skills, and version-matched docs under
`node_modules/@aotter/mantle/docs/`. Use `mantle update` only to produce a
review report; port selected upstream changes while preserving project-owned
manifest, Worker, handler, route, UI, and config edits.

Do not push, deploy, configure providers, or commit secrets during local cold
start. When the user asks to ship, use the provision skill.

Report the project path, selected type, local URL, checks run, and the two or
three real author attention points. Offer visual shaping, the first business
workflow, or deploy/auth as appropriate next steps.
