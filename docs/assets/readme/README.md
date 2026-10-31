# README screenshot provenance

The root README uses real English-language Admin screenshots from the official
Purchasing workflow in the [central examples catalog](../../examples/README.md).
The example supplies the manifests, approval/rejection handlers, supplier
integration, and Admin entry. Its application code is not changed for capture.
No screenshot uses an invented interface, intercepted API response, or edited image.

## Reproduce

From the repository root, with Node.js 22.22+, pnpm 9+, and Chromium:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @aotter/mantle-admin exec playwright install chromium
node scripts/capture-readme.ts
```

For an existing Chrome/Chromium executable:

```sh
MANTLE_TEST_CHROMIUM=/path/to/chromium node scripts/capture-readme.ts
```

The script scaffolds a temporary app with the built CLI and overlays the
Purchasing example. It installs the app shell's peers, then links the current
built workspace SDK, Admin, and UI packages. The shell's existing smoke kit
starts a fresh local D1 database, signs in a fictional administrator and
employee through Better Auth, and drives the real application over HTTP.

As in the official smoke test, the external supplier is a local stand-in and
email uses the example's console sender. No real orders or emails are sent.
The app and supplier bind to loopback. The browser, app, supplier, temporary
application, and isolated database are cleaned up after capture. This is a
local screenshot/test harness, not production hosting.

Before capture, the script selects English and a light theme through Admin's
normal preference storage. It navigates the real UI with Playwright, waits for
rendering, and captures the viewport without modifying the DOM or retouching
images. Every captured page is checked for CJK text. Sample records are created
through the application's own REST operation. Generated record IDs and creation
timestamps can change on each run.

| Image | Viewport | Running application view |
|---|---|---|
| `admin-workspace.png` | 1600 × 820 | Purchase-request list with submitted, approved, ordered, and rejected records |
| `request-review.png` | 1600 × 820 | Submitted request with amount, department, version, and approval/rejection actions |
| `system-wiring.png` | 1600 × 1000 | `/admin/dev`, system wiring |
| `entity-relationships.png` | 1600 × 800 | Schema diagram for budgets, requests, and ledger |
| `procedure-chart.png` | 1600 × 1060 | SQL `approve-request-write`, its guards, three writes, rollback and commit |

The harness also verifies an actual approval, supplier order, rejection, and
budget refusal through the application. The budget remains unchanged after
an over-budget approval is rejected. The procedure chart shows the SQL
transaction; the ref handler's supplier/email side effects are not presented
as generated SQL internals.

This example joins department and request identifiers in its SQL without
`x-mantle-ref` fields. Its schema diagram therefore shows no reference edges;
none are invented for the screenshot. Diagrams alone do not establish runtime
health, identity integration, or successful deployment.

## Illustrated hero

The root README also uses `../mantle-hero-v2.png`, an AI-generated refinement of
the original `../mantle-hero.jpg`. The original is retained. The new illustration
preserves the cloaked dungeon master, four golden primitive runes, unused pickaxe,
and luminous labyrinth within a pearlescent nautilus shell. It is conceptual
brand artwork, separate from the five real application screenshots above.
