# Sealed pipeline ownership ledger

This is the migration evidence for ADR-0019 and epic #656. It records the
`v0.1.0-alpha.7` owners before code moves, the single target owner, and the
issue that must delete or delegate the old path.

## Rule ownership

| Behavior | Current owner(s) | Target owner | Migration |
|---|---|---|---|
| YAML document decode, empty documents, syntax errors, alias cap | `ManifestParser.parseOneStream` | Parse/decode in `mantle-spec` | #663 |
| Four-atom discrimination, envelope keys, primitive/enum shape | `ManifestParser` | Parse/normalize | #663 |
| Source identity and document location | Synthetic parser doc index plus `loadManifests`/`ManifestPathDiagnoser` reconstruction | `ManifestSourceSet` authored metadata | #663 |
| Schema atom-local shape, index/search/UI shape | Parser plus `ValidateManifestsUseCase` checkers | Parse/normalize | #663; old checks deleted in #673 |
| Defaults for localized/lifecycle/indexes/search/order | `IntrospectManifestsUseCase`, runtime lifecycle checks, and callers using `??` | Parse/normalize exactly once | #663, #667 |
| Duplicate names | `ValidateManifestsUseCase` | Link | #664 |
| Schema/View/Procedure/Trigger cross-references | `ValidateManifestsUseCase` and repeated boot checks | Link | #664 |
| Guard existence, self-reference, builtin/chain rules | Validate plus `ValidateBootUseCase` | Link | #664 |
| Locale/translates graph | `checkLocaleAndTranslates` in validate and boot | Link for manifest graph; Prepare for selected deployment locales | #664, #666 |
| Manifest-owned HTTP/MCP collisions | Validate plus boot | Link | #664 |
| Handler source/registry availability | Optional CLI source scan plus boot registry scan | Prepare | #666 |
| Optional Web/Admin/Auth path reservations | Fixed boot/Cloudflare prefix lists | Prepare selected capabilities only | #666, #669, #670 |
| Kind/name lookup maps | `ValidateManifestsUseCase`, `ValidateBootUseCase`, `createCmsRuntime`, adapters | Compile once into `RuntimePlan` | #665 |
| Authorization/guard descriptors | Raw manifests interpreted by validators, runtime use cases, and mounts | Compile plan; evaluate in Core invocation | #665, #667 |
| Trigger indices and Procedure descriptors | Runtime construction/use cases | Compile plan | #665 |
| Semantic fingerprint | Runtime boot from raw manifests | Compile plan | #665 |
| Declarative View resolution | `ViewSqlCompiler` during each `ExecuteViewUseCase` call | Compile logical plan once | #665 |
| SQLite/JSON1 View lowering and native `spec.sql` | `ViewSqlCompiler` plus `DatabaseDriver` invocation | Selected storage preparation | #666 |
| Canonical SQL migrations, indexes, schema SQL Views, readiness | `createCmsRuntime.bootInit` and runtime infrastructure | Prepare | #666 |
| Entry/media/site repositories | Runtime constructs `Database*Repository` from `DatabaseDriver` | Prepared semantic storage ports; media/config move with final owner | #666, #669, #670 |
| Content, View, Procedure, Trigger, lifecycle invocation | Runtime use cases over raw maps/driver | `MantleRuntime` over plan + semantic ports | #667 |
| Target authorization/admin bypass | Runtime plus adapter entry points | One Core invocation policy; adapter resolves caller only | #667 |
| Generated manifest module and TypeScript names | `packages/mantle/src/generate.ts` + `EmitTypesUseCase` | Pure linked/plan projection and `bindMantle` | #668 |
| Admin asset copy during generation | `packages/mantle/src/generate.ts` | Removed; Admin install/composition owns assets | #668, #670 |
| HTML/templates/public paths/Markdown/SEO/preview/`llms.txt`/sitemap | Runtime render services plus Cloudflare public routes | Optional `mantle-web` | #669 |
| Public request mapping and cache policy | `mountPublicRoutes` | Platform adapter using selected Web projection | #669 |
| Admin API/application/static assets | Optional `mantle-admin`; Cloudflare only binds auth/request context/assets | Optional `mantle-admin` + existing UI artifact | #670 |
| View/HTTP Trigger route transport | Combined Cloudflare mounts | Platform adapters over the same Core descriptors | #669–#672 |
| Bun SQLite/process lifecycle | `mantle-bun`; host owns server/database | `mantle-bun`; host owns server/database | #671 |
| Vercel function/durable-storage lifecycle | `mantle-vercel`; host owns handler/client | `mantle-vercel`; host owns handler/client | #672 |
| Legacy overloads, aliases, combined mounts, duplicate tests | Current public API plus temporary migration delegates | Deleted | #673 |
| Contributor/agent/release guidance | `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, two release skill copies | One tool-neutral authority and one release skill | #674 |

## Deletion evidence

All baseline production callers now consume `ParsedManifestSet`,
`LinkedManifestSet`, or `RuntimePlan` according to their pipeline stage.
`scripts/check-boundaries.mjs` fails if the removed runtime facade, generated
site API, raw parser facade, or combined Cloudflare route owner returns.
Parser-focused tests may inspect parser output, but runtime and platform tests
must compile and prepare the same sealed plan used by production.

## Consumer manifest corpus

The Core repository does not vendor every downstream manifest. That would
create a second source of truth. The reusable golden fixture under
`packages/mantle-spec/test/fixtures/pipeline-v0.1/` covers every shipped atom,
auth/guard references, all Trigger surfaces, multi-document YAML, empty
documents, aliases, unknown keys, malformed YAML, and deterministic
diagnostics.

Exact downstream sources and their gate authorities are pinned here. The public
Starter runs in Core CI and release preflight. Private consumers run the same
exact-tarball checker in their own repositories, so public Core PRs never
receive cross-repository credentials:

| Consumer | Revision | Gate authority | Manifest paths |
|---|---|---|---|
| `aotter/mantle-starters` | `c2d7e1fcfe51b6e74bffdaf5c86a4de04b47127d` | Core CI + release | `blank/manifests/site.yaml`; `overlays/{community,intake,presence,publication,reservation,transaction}/manifests/site.yaml`; `recipes/typed-web/manifests/site.yaml` |
| `aotter/mantle-landing` | `81551aecbb088afa9a5c8a6de18892e8438ebc35` | Landing `Check` | `manifests/site.yaml` |
| `aotter/mantle-platform` (Remote Mantle/control plane) | `4fabfd434f8843fcd14e553260c94f39b1633a91` | Platform `exact-packed-core` | `manifests/platform.yaml` |
| Core i18n fixture | this repository | Core CI | `packages/mantle-spec/test/fixtures/i18n-parent-child/manifests/site.yaml` |

## Baseline gates

The alpha.7 baseline was captured from tag `v0.1.0-alpha.7` on 2026-08-16
with Node 22, pnpm 9, Wrangler local mode, and datasets of 100/10,000 rows:

| Route | p95 queries | p95 rows read | local p95 timing |
|---|---:|---:|---:|
| public View, 10k rows | 1 | 20 | 3.01 ms |
| public page miss, 10k rows | 2 | 5 | 3.92 ms |
| Admin list, 10k rows | 1 | 21–22 | 2.49–3.24 ms |
| Admin related detail, dense | 4 | 151 | 5.23 ms |
| public builtin create | 1 | 0 | 2.55 ms |

Wall-clock values are evidence, not a cross-machine budget. The normative
baseline is the existing `pnpm bench:wrangler` query/row gate: every gate must
remain true, unchanged revisions must perform no repeated preparation, and any
intentional budget change needs its own reviewed evidence.

Existing full-facade behavior is covered by Cloudflare authorization, Admin,
public-route/cache, View REST, HTTP Trigger, media, form, and facade tests.
Issues #669–#673 move those assertions to selected modules and exact packed
consumers; they do not duplicate the suite under new names.

Issue #674 leaves `CONTRIBUTING.md` plus accepted ADRs as the contributor
authority. `AGENTS.md`, `CLAUDE.md`, and the Claude release-skill entry are
small routers; `.agent/skills/mantle-release/SKILL.md` is the only maintainer
release procedure. Shipped `skills/*` remain separate consumer artifacts.
