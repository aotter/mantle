# Architecture Decision Records

Records of *why* mantle ended up shaped this way. The numbering preserves POC ADR numbers where carried over (so cross-references in code comments and external docs stay valid); new ADRs continue from the highest used number.

## v0.1.0 ADRs

| # | Title | Status |
|---|---|---|
| [0001](0001-four-atom-manifest-model.md) | Four-atom manifest model (Schema / View / Procedure / Trigger). Folds POC ADR-0005 (grammar discipline) and POC ADR-0006 (multi-doc YAML). | Accepted (refreshed) |
| [0002](0002-closed-enums-for-bindings.md) | Closed enums for `x-mantle-bind` and `ctx.*` predicates. | Accepted (refreshed) |
| [0007](0007-ai-as-primary-author.md) | AI is the primary author of consumer projects; SDK contract is the three feedback loops + structured diagnostics. Folds POC ADR-0013 (role-split surfaces). | Accepted (refreshed) |
| [0008](0008-structured-diagnostic-shape.md) | Diagnostic shape: code, phase, severity, path, value, expected, message, candidates, suggestion. zod-translation per PR #81. | Accepted (refreshed) |
| [0009](0009-consumer-supplied-manifests.md) | Consumers ship their own manifest YAML. SDK parses + caches; never embeds. | Accepted (refreshed) |
| [0010](0010-locale-and-translates.md) | Locale 3-layer (manifest / D1 site_config / data field) + translates pattern. Boot decoupled from `site_config` (issue #60 fix). | Accepted (refreshed) |
| [0011](0011-adapter-port-spec.md) | Adapter port spec. Required runtime ports plus optional feature ports. CF impl + Netlify stub. | Accepted (new) |
| [0012](0012-views-as-public-rest.md) | Views auto-expose `GET /api/views/<name>` as the public REST read surface. Schemas never get a public REST endpoint. Filter comparison values accept `{ $param: <name> }`; `?page=&show=` reserved for pagination. | Accepted (new) |
| [0013](0013-agent-provisioned-consumer-projects.md) | Historical agent-provisioned consumer projects path. Superseded for first launch by landing provision bundles. | Superseded |
| [0014](0014-auth-better-auth-and-multi-tenant-mcp.md) | Better Auth for staff sign-in (D1 session); the MCP OAuth surface carves out to `@cloudflare/workers-oauth-provider` (KV grant store) at top level. The two meet at `/oauth/authorize` where the consent handler reads the Better Auth session. MCP splits into `/mcp/staff` (write, admin-role) and `/mcp` (read, any signed-in). Scope advertised as `["mcp"]` (single non-colon) because claude.ai rejects colon-shaped scopes. Auth port disappears; runtime takes Better Auth instance directly. See § "Amendment 2026-05-15". | Accepted + amended |
| [0016](0016-site-semantic-layer.md) | Site semantic layer: `AGENTS.md` (cross-tool entry) + `.mantle/launch-state.json` (deterministic install context). The older `mantle/site.md` letter surface is suspended from first-run scaffolds. | Accepted (slimmed) |

## Reading order

If you're new to the codebase:

1. **0001** — what the 4 atoms are.
2. **0009** — how consumers wire them in.
3. **0007** — what running the SDK feels like as an AI author (and as the operator agent).
4. **0011** — the boundary between the runtime and the adapter (most load-bearing for the rebuild).
5. **0010** — how locale flows through the system.
6. **0013** — historical install-session context; current first launch is landing provision bundles plus repo-local handoff.
7. **0002, 0008** — the two ADRs that touch every diagnostic and every binding.

## What's NOT here (and why)

POC had 16 ADRs. The rebuild ports the durable ones, writes fresh ADRs
for new v0.1.0 boundaries, and folds / drops the rest:

- **POC ADR-0003** OpenAPI emission → folded into `mantle-spec` README (the *what* is implementation; the *why* was already captured by ADR-0001's grammar lock).
- **POC ADR-0004** D1 today, Hyperdrive PG tomorrow → folded into `mantle-cloudflare` README (now a v0.2 roadmap item, not an architectural decision).
- **POC ADR-0005** v0.1 minimum vs DRAFT discipline → folded into ADR-0001 §"Future grammar discipline."
- **POC ADR-0006** multi-doc YAML → folded into ADR-0001 §"Authoring shape: multi-doc YAML."
- **POC ADR-0011** lifecycle binary opt-in → distilled to a §"Lifecycle" subsection in `docs/design-atoms.md`. v0.1.0 ships `simple` only; `editorial` is a v0.1.x feature.
- **POC ADR-0012** strategic posture vs adjacent CMS designs → strategic / marketing material, lives in `README.md` if anywhere.
- **POC ADR-0013** role-split surfaces (coder agent vs operator agent) → folded into ADR-0007 (Part B).
- **POC ADR-0014** builtin handlers and lifecycle Triggers → promoted to v0.1.0 and implemented in the rebuild via `LifecycleHookingEntryRepository` and `InvokeBuiltinUseCase`. Editorial lifecycle remains v0.1.x-gated. Full shape spec lives in `docs/design-atoms.md`.
- **POC ADR-0015** cms-astro internal seam discipline → POC-specific to a package that no longer exists; replaced by ADR-0011 (adapter port spec).
- **POC ADR-0029** drop Astro from cms-cloudflare → POC-specific historical record; the rebuild starts post-Astro.

The rebuild's ADR-0011 (new) is the most load-bearing addition — the POC accumulated multiple *aspirational* boundaries (POC ADR-0015 was one; references in CLAUDE.md were another) without a single normative spec. ADR-0011 makes the boundary explicit and reviewable. ADR-0012 and ADR-0013 capture newer v0.1.0 product/runtime seams that were not present in the POC.

## Contributing a new ADR

1. Pick the next number (currently 0017).
2. File: `docs/adr/<NNNN>-<kebab-title>.md`.
3. Sections: Status, Date, Context, Decision, Consequences, Alternatives, How to apply, Implementation status.
4. Link from this README's table.
5. Land it in a PR alongside (or before) the implementation it documents — ADR-as-design-artifact, not ADR-as-archaeology.
