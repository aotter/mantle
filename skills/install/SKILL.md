---
name: mantle install
description: Install a mantle consumer project. Preferred path consumes a landing-created launch session and scaffolds immediately via create-mantle. Manual fallback collects the exact create-mantle flags, scaffolds deterministically, then continues to provision. Use when the user pasted a launch command/session URL or when starting from an empty repo.
when_to_invoke: |
  Empty repo + landing-page launch command/session URL, or empty repo + user wants to create a Mantle site without landing.
---

# mantle install

You're installing a mantle site for the user. If the user arrived from
the landing launch flow, a short-lived launch session already carries
the launch-critical values. Treat that session as the source of truth
and scaffold first.

## Ground truth

`@aotter/mantle-*` exposes **exactly four declarative atoms** scoped to `cms.mantle.aotter.net/v1`, mapping 1-to-1 to Postgres primitives:

| Atom | Postgres analog | External surface |
|---|---|---|
| **Schema** | `CREATE TABLE` | none (manipulated via View / Procedure) |
| **View** | `CREATE VIEW` | auto-mounted at `GET /api/views/<name>` |
| **Procedure** | `CREATE FUNCTION` | none directly; needs a Trigger to bind it |
| **Trigger** | `CREATE TRIGGER` + cron + REST route + LISTEN/NOTIFY | binding atom — turns Procedures into HTTP / lifecycle / MCP surfaces |

Anything domain-shaped (Form, Membership, Workflow) is **composed in the consumer project** from these four plus user TypeScript. Full grammar reference: <https://raw.githubusercontent.com/aotter/mantle/develop/docs/design-atoms.md>.

After `create-mantle` runs, the scaffold's ground truth lives in:

| Path | Contents |
|---|---|
| `manifests/*.yaml` | Schemas / Views / Procedures / Triggers this archetype ships |
| `src/mantleConfig.ts` | Site defaults, handler-ref registration, runtime bindings |
| `src/handlers/` | Handler implementations (referenced from Procedures with `handler.kind: ref`) |
| `src/.mantle/generated.*.ts` | Scaffolder-owned feature glue, regenerated from selected feature overlays |
| `.mantle/features.json` | Scaffolder-owned receipt of selected source overlays |
| `mantle/site.md` | Site semantic layer — brand / voice / locales / futures / revisions |
| `AGENTS.md` | Cross-tool agent entry; updates on every Mantle pass |

Live introspection (run from project root):

```bash
pnpm introspect       # current manifest dump (atoms inventory)
pnpm emit-openapi     # generated HTTP surface
pnpm emit-types       # generated TS types
pnpm validate         # grammar + cross-ref check (preview phase by default).
                      # For production-only checks, use
                      # `pnpm validate --phase deploy` or `pnpm validate:deploy`.
```

Diagnostics are structured JSON with `code` + `suggestion` fields — surface both verbatim, don't paraphrase.

## Launch-session fast path

Use this path first when the prompt contains either:

- a command shaped like `npx <tarball> launch --session <url-or-file>`, or
- a launch session URL/file plus instructions to run `create-mantle launch`.

The landing page already collected the launch-critical values and, when the GitHub App flow is present, supplied the GitHub admin/default-owner login. Treat those values as user-authorized for scaffolding. Do **not** run the pre-scaffold interview first.

### Session authority

The launch session is an authorization artifact for initial scaffold values only:

- It may authorize `project_name`, `brand`/site name, `archetype`, `theme`, `features`, `locales`, `github_owner` / `admin_github_login`, and repo intent.
- It must be short-lived. If `create-mantle launch` reports an expired/invalid session, stop and send the user back to the landing page to create a new session.
- It must not be copied into committed files, shell history snippets, issue comments, or handoff text. The scaffolder writes `.mantle/launch-state.json` with non-secret resumable metadata and intentionally redacts the raw session URL.
- It does **not** authorize Cloudflare resources, provider billing, custom domains, or production secrets. Provision still asks the user to complete the Cloudflare Dashboard first deploy and GitHub OAuth App setup in their own accounts.

### Fast-path preflight

Still verify the environment and target directory before running the command:

```bash
node --version    # need >= 22
pnpm --version    # need >= 9
git --version
```

Confirm that the current working directory is the parent directory where the new project should appear. If a child directory already exists with the session's project slug, stop; do not merge into an existing directory.

Then run the launch command exactly as supplied, except for replacing an obvious local file path if the user gave you one out of band:

```bash
npx <create-mantle-tarball> launch --session <session-url-or-file>
```

`create-mantle launch` validates the session before filesystem writes, downloads the requested starter ref, scaffolds, runs `git init` and `pnpm install`, and prints RUN_NOTES JSON with a `launch` block.

After it returns:

1. Read RUN_NOTES.
2. Read `.mantle/launch-state.json`.
3. Walk the ground-truth files listed above.
4. Continue from local validation and preview setup below.

Do not ask content/voice questions before scaffold. The natural point for user conversation is after the site exists locally and, preferably, after provision has produced a working URL. If the user explicitly wants to revise content before provision, keep it to the same small adjustment window described later in this Skill.

## Preflight — before manual fallback

Verify the environment can run the flow. Don't waste the user's time interviewing for a site we can't build:

```bash
node --version    # need ≥ 22 (starter `engines.node`)
pnpm --version    # need ≥ 9
git --version     # any recent
```

If any is missing or below the minimum, surface install hints once and stop until the user confirms tools are ready:
- node ≥ 22: nvm (`nvm install 22 && nvm use 22`), Homebrew, or the official installer at nodejs.org
- pnpm ≥ 9: `corepack enable && corepack prepare pnpm@latest --activate`, or `npm install -g pnpm@9`
- git: system package manager (Homebrew on macOS, apt on Debian/Ubuntu, winget on Windows)

Also confirm the current working directory is an appropriate parent directory for the new project, and that no child directory already exists with the authorized `<<PROJECT_NAME>>`. `create-mantle` writes into `./<<PROJECT_NAME>>`; collisions with pre-existing files are surprising and rarely what the user wanted.

Do not proceed to manual fallback until preflight passes.

## Manual fallback

Use this only when there is no valid launch session. The manual path is
for development, recovery, or a user who did not start from landing. It
is not the primary UX.

Ask only for the values that the `create-mantle` command truly needs.
Keep it one question at a time and confirm the exact values before
running the command.

### Goal — what you must land before dispatch

Listed in discovery order — purpose comes first, brand near the end. **Do not read this table as a top-down checklist to ask in order.** The order below mirrors how the interview should flow:

| Value | For |
|---|---|
| **purpose / audience** | one-line description and locale choice |
| **audience scope + locales** | `--locales` (count + first is canonical) |
| **description** | `--description` — one-line site identity, agent-drafted in user's language |
| **summary** | `--summary` — one-line install-moment marker, agent-drafted in user's language |
| **brand** | `--brand` — proposed by you after purpose + audience texture is in; user picks or supplies their own |
| **github identity** | `--github-owner` and optional `--admin-github-login` |

Every value above must be set with the user's explicit confirmation
before you dispatch. Do not guess from email, folder name, or the
language of the conversation.

### Multi-round purpose discovery — start here, not with brand

Open with **what's this site for** — not the brand name. Don't ask cold
for a full brief. Ask one simple question, summarize back, then move to
the next required value.

User answers -> react -> ask the next missing value. One question per
turn. Stop as soon as the command values are known.

### Stances (the few non-archetype rules)

**Audience + locales — ask, don't infer.**

Audience scope drives the locale choice and feeds Mantle. Ask the user explicitly who this site is for — is it a domestic audience (and if so, which country / region), or an international audience? Don't infer audience from the user's own writing language alone; a user writing to you in one language may be building for readers in another.

- Domestic audience → propose monolingual in the audience's primary language. Confirm.
- International audience → propose bilingual, canonical = the user's working language, secondary = the audience's language. Confirm.
- Ambiguous (mixed signals, user not sure) → ask once: monolingual `<primary>` or bilingual `<primary>+<secondary>`?
- Use Mantle's v0.1 locale subset: BCP 47 language + optional 2-letter region. The runtime canonicalizer rejects script subtags even though they are valid BCP 47 — map Traditional Chinese / `zh-Hant` to `zh-TW`, Simplified Chinese / `zh-Hans` to `zh-CN`, and otherwise use bare-language or `<lang>-<2-letter-region>`.

**Description + summary — different roles, both agent-synthesized in the user's language.**

These are CLI flags, not separate interview questions. They land in different places and serve different purposes:

| Field | Lands in | Role |
|---|---|---|
| `description` | `mantle/site.md` frontmatter → `siteDefaults.description` → SEO `<meta description>` on every page | **Site brochure** — what the site *is* (perpetual). |
| `summary` | `mantle/site.md` `revisions[0].summary` | **Changelog entry** — what *this install moment* did. Provision / extend / customize-design append their own later. |

Don't write the same one-liner twice. `description` is a one-sentence site identity. `summary` is a one-line install-moment marker — terse, factual, often as short as "Initial scaffold." or "Site created from publication archetype." The site's actual identity already lives in `description`; `summary` is the timestamp's caption, not a second pitch.

Show both drafts when you synthesize; user confirms or corrects.

**Brand — propose last, never first.** Only after purpose + audience + voice texture has surfaced through the archetype probes. Then offer two paths: "Tell me a name, or I can propose 2-3 based on what you've described." If user picks the second, propose 2-3 with a one-line rationale each tied to what they actually said. Don't make the user invent a name cold; and don't propose a name before you have material to anchor the proposal in.

**GitHub identity — factual, last.** Ask once near the end. Pure config; no elaboration needed.

**Other observations — capture without pushing.** Emotional weight, dates that matter, things-not-to-touch, futures — let them surface naturally during the archetype probes. Don't checklist them. Mantle uses whatever you noticed; she doesn't need everything.

### Synthesize and confirm

Before running `create-mantle`, rehearse the install back to the user in their language. Translate technical tokens to something a non-engineer reads naturally — BCP 47 codes become the language's natural name in the user's language, config keys like `github_owner` become their everyday phrasing, archetype codenames become the site type's everyday meaning rather than the codeword.

Surface `description` and `summary` as separate one-line drafts for the user to nod or tweak, since they land in different places (SEO meta vs. revisions log).

## If the archetype is roadmap

If the archetype hint says `status: roadmap`, follow its **Refuse path** — the hint specifies the framing (honest "not yet" → two holding paths → write intent into `mantle/site.md` `futures:`). Move to the holding path the user picks. Skip the rest of the interview steps below.

## When to act

### Why running `create-mantle` is a destructive action under Auto Mode

Invoking the `create-mantle` release tarball is **not low-risk work**. The command writes the user's site identity — brand, audience, locale, description — into `mantle/site.md` and `src/mantleConfig.ts` `siteDefaults`, then runs `git init` and `pnpm install`. Those values drive, perpetually:

- every page's SEO `<meta description>`
- locale routing for the entire site (canonical + redirects)
- the persistent site notes in `mantle/site.md`
- 22 starter files' `{{PLACEHOLDER}}` substitution
- `revisions[0]` — the permanent install-moment entry in the changelog

Wrong values ship into the user's first-load impression and cannot be cleanly walked back without wiping the scaffold and re-scaffolding from empty.

**Auto Mode's contract has four clauses. Clauses 1–3 say "execute immediately / minimize interruptions / prefer action". Clause 4 is the carve-out: do not take overly destructive actions without authorization.** This Skill classifies the scaffolder invocation under clause 4. Each create-time value must be either carried by a valid landing session or explicitly confirmed by the user. Auto-derivation — from the user's email, the current working directory's name, the archetype query, the theme query, or "the locale of the message the user wrote to me" — is **not** authorization. That kind of inference is what Auto Mode's clauses 1–3 want for low-risk work. This Skill specifically does not accept it for scaffolding values.

If you have not had a turn where the user looked at the exact value and replied affirmatively (or supplied a replacement), the value is unauthorized.

Launch-session exception: when the user hands you a landing-created
`create-mantle launch --session ...` command, the landing session is the
explicit authorization for those scaffold values. Your job is to
validate/run it, not to repeat manual fallback before scaffold. If the
session is invalid or expired, stop and ask the user to regenerate it
from the landing page; do not infer replacement values.

### Prerequisites — each parameter must be user-authorized before invocation

Same discovery order as the Goal table above — purpose first, brand later. The order matters because it reflects the interview shape, not arbitrary alphabetization.

| Value | Authorized when |
|---|---|
| **purpose / audience** | enough texture to summarize the site intent, not inferred |
| **audience scope** | user explicitly stated domestic/international audience and languages |
| **locales** | derived from audience scope; user nodded on the resulting BCP 47 list |
| **description** | agent-drafted in user's language; user nodded on the exact one-liner |
| **summary** | agent-drafted in user's language; user nodded on the exact one-liner |
| **brand** | user picked one, supplied one, or accepted your proposal |
| **project-name** | lowercase-hyphenated slug shown to user and confirmed |
| **github owner** | user explicitly stated their GitHub login/org, not derived from email |

If any value is unauthorized — including auto-derivation that "looks reasonable" — the work is still in the interview. Return there. Step 1 below IS the rehearsal back to the user in their language; it is not the moment you collect authorization for unfilled values.

1. **Confirm the synthesized draft.** User accepts or corrects.

2. **Run `create-mantle`.** Use the release tarball URL supplied by the
   landing page, release notes, or Mantle starter docs. Fill flags only
   from confirmed values:

   ```bash
   npx <create-mantle-tarball> <archetype> \
     --project-name <project-name> \
     --brand "<brand>" \
     --description "<description>" \
     --locales "<locale[,locale]>" \
     --github-owner <github-owner> \
     --admin-github-login <admin-login> \
     --summary "<summary>" \
     [--theme <theme>] \
     [--feature <feature>]
   ```

   Do not invent `--theme` or `--feature` flags. They must come from
   landing, a starter doc, or an explicit user request.

   The CLI fetches `sources.json` at runtime from the requested starter ref (`--ref` / `--starter-ref`; release commands should pin a tag or explicit ref), downloads the starters tarball, merges `_common/` + `<archetype>/` + selected feature overlays + (optional) `themes/<theme>/`, fills `{{PLACEHOLDER}}` macros, renames `.template` files, runs `git init` and `pnpm install`. RUN_NOTES JSON arrives on stdout, including `features` when overlays were selected.

3. **Read the RUN_NOTES.** The `files_written` list is your scaffold inventory. If `features` is non-empty, read `.mantle/features.json` and the generated `src/.mantle/generated.*.ts` glue before deciding anything else. Walk the ground-truth files — at minimum `manifests/`, `src/mantleConfig.ts`, `mantle/site.md` — before deciding anything else.

4. **Adjustment window** (optional, see § below). Only if the interview surfaced a concrete deletion or single-field gap. Always `pnpm validate` after edit.

5. **Validate locally:**

   ```bash
   pnpm validate
   pnpm typecheck
   ```

   `pnpm validate` runs in the **preview phase** by default — grammar + cross-Schema checks only. Anything non-zero → surface `code` + `suggestion` verbatim.

   The deploy-phase variant (`pnpm validate --phase deploy`, or `pnpm validate:deploy` if the starter ships that script) is safe to run on a fresh scaffold. It must not block on unfinished prose in `mantle/site.md`.

   **Then set up `.dev.vars` so `pnpm dev` works.** Starters that ship `.dev.vars.example` (publication / transaction / intake / presence) require a real `BETTER_AUTH_SECRET` before `pnpm dev` — the worker returns `auth_not_configured` on every request until it's filled. Copy the file, generate a value, and write it in:

   ```bash
   [ -f .dev.vars.example ] && cp .dev.vars.example .dev.vars
   # Generate, then paste the output into the BETTER_AUTH_SECRET= line of .dev.vars
   openssl rand -hex 32
   ```

   This secret is **local only** — `.dev.vars` is gitignored and never reaches Cloudflare. Production's secret is minted separately by `provision:up` (see the provision Skill). Tell the user this distinction explicitly so they don't try to reuse the local value or expect it to follow them to prod.

   **Start local preview and explain empty-content states.** Run `pnpm dev` after validation and `.dev.vars` setup, then probe the public home route, `/admin`, and any obvious list/API route the archetype exposes. A fresh scaffold may legitimately return 404 on `/` or locale home routes (`/en`, `/zh-TW`, etc.) because D1/KV has no `home` page yet. Treat that as an empty-site state, not a broken install.

   When the public home route is empty/404, tell the user plainly: "the worker is running; the public homepage has no content yet." Then ask whether they want a **local preview seed** so they can see the homepage and, for post-shaped archetypes, a couple of sample posts in the browser. Do not run generic test fixtures or seed content without explicit consent. If they say yes, keep the seed preview-only and local: use user-approved copy from the interview or step 6 drafting, make it clear it is not production content, and do not commit local DB/KV artifacts or `.dev.vars`. If they say no, continue with the install flow; production content can be created later through `/admin` or MCP.

6. **Keep `mantle/site.md` deterministic.**

   The scaffold already records the launch description and open
   provision items. Do not block first deploy on polishing voice, welcome
   copy, or editor prompts. If the user gave concrete notes, add a short
   `## history` paragraph and validate. Otherwise leave content work for
   the post-deploy coding/content agent.

7. **Run deploy validation.**

   ```bash
   pnpm validate:deploy
   ```

   If the project only exposes the CLI command, run `pnpm validate --phase deploy`. This is the readiness gate before handing off to provision.

8. **Commit.** If step 4 produced an adjustment, that's its own commit. Then the main commit: `mantle: deterministic scaffold`.

9. **Continue to provision — don't push a URL onto the user.** Provision
   is the next phase in the same conversation. Read
   `.mantle/launch-state.json` for GitHub owner/admin metadata when it
   exists, then use the repo-local `mantle:provision` skill generated
   into the scaffold. If it is missing, fetch
   `https://raw.githubusercontent.com/aotter/mantle/develop/skills/provision/SKILL.md`.

   The current provision shape is deterministic first: create/push the private GitHub repo, guide the user through Cloudflare's GitHub-backed first deploy, then use Wrangler to take over follow-up bindings/secrets/migrations. If GitHub CLI auth is invalid, the user's next involvement is re-auth first; after they reply that it is fixed, re-run `gh auth status` and then continue provision. Don't promise production-readiness until provision completes and a second agent connects through MCP.

## Adjustment window — between scaffold and provision

A permitted modification turn after `create-mantle` returns and before provision starts. Small concrete edits to match what the user said.

### In scope

| Action | Why |
|---|---|
| Delete a manifest the user explicitly said they don't need | Honesty over inertia |
| Add a single field to an existing Schema, from a concrete interview signal | Small, validated, recoverable |
| Edit `src/mantleConfig.ts` site defaults beyond what `create-mantle` set | Site-shape, fits Mantle's surface |
| Tweak `src/theme/` tokens if the user gave a strong visual register | Prefer deferring to the customize-design Skill unless explicit |

### Out of scope

| Action | Route to |
|---|---|
| Add a new Schema (beyond single-field tweak), View, Procedure, or Trigger | The extend skill |
| Substantial theme work (template fork, layout reshape) | The customize-design skill, after deploy |
| Anything touching DRAFT grammar keys | Never at install — grammar locked at v0.1 |

### Discipline

- `pnpm validate` after every edit. Non-clean tree never advances to provision.
- Show the diff before applying. A deleted manifest deserves a one-line confirm.
- Don't speculate. "I think you might also want X" is generation, not interview.

## Don't

- Don't write into `src/theme.default/` or any "system-looking" path during install — design changes happen after deploy via the customize-design skill.
- Don't keep speaking after the handoff to provision — the handoff IS the end of this Skill.
- Don't echo the same specific user detail across every generated note — let each section have its own job.
