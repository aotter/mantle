# README screenshot provenance

The root README uses real English-language Admin screenshots from the official
[posts and revisions guide](../../handbook/guides/revisions.md). The guide's
checked fixture supplies the manifests, generated bindings, `switch-revision`
handler, and custom Admin entries. No screenshot uses an invented interface,
intercepted API response, or edited image.

## Reproduce

From the repository root, with Node.js 22.22+, pnpm 9+, Bun, and Chromium:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @aotter/mantle-admin exec playwright install chromium
bun scripts/capture-readme.ts
```

For an existing Chrome/Chromium executable:

```sh
MANTLE_TEST_CHROMIUM=/path/to/chromium bun scripts/capture-readme.ts
```

The script reuses `prepareRevisionsExample` and the official revision browser-test
server. It uses the built workspace packages, a local test administrator,
an in-memory SQLite database, and fictional English sample content. The
pagination test's filler posts are omitted. The server binds only to loopback
and is stopped after capture; the temporary application is deleted. This is a
screenshot/test harness, not production authentication or hosting.

Before capture, the script selects English and a light theme through Admin's
normal preference storage. It navigates the real UI with Playwright, waits for
rendering, and captures the viewport without modifying the DOM or retouching
images. Every captured page is checked for CJK text. Sample copy is edited in
the fixture before it starts. Generated record IDs and creation timestamps can
change on each run.

| Image | Viewport | Running application view |
|---|---|---|
| `admin-workspace.png` | 1600 × 680 | Post workspace with a sealed current revision and editable candidate |
| `revision-editor.png` | 1600 × 1000 | Candidate's native record editor |
| `system-wiring.png` | 1600 × 800 | `/admin/dev`, system wiring |
| `entity-relationships.png` | 1600 × 800 | `/admin/dev/overview/relationships`, fields and references |
| `procedure-chart.png` | 1600 × 1060 | `/admin/dev/logic/procedures`, `new-revision` selected |

The harness also previews and switches the candidate through the documented
custom page, then reads stored state to verify that the selected revision is
sealed and the post points at it. The procedure screenshot intentionally shows
the SQL `new-revision` operation. `switch-revision` is an application ref handler;
its internal TypeScript is not presented as a generated SQL procedure chart.

The diagram's references are declared model relationships, not a claim that the
database installed foreign-key constraints. Diagrams alone do not establish
runtime health, identity integration, or successful deployment.

## Illustrated hero

The root README also uses `../mantle-hero-v2.png`, an AI-generated refinement of
the original `../mantle-hero.jpg`. The original is retained. The new illustration
preserves the cloaked dungeon master, four golden primitive runes, unused pickaxe,
and luminous labyrinth within a pearlescent nautilus shell. It is conceptual
brand artwork, separate from the five real application screenshots above.
