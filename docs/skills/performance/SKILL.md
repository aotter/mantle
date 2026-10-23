---
name: performance
description: Make an accepted Mantle 0.2 application fast — Lighthouse for app-authored pages, Worker cold start and first-load budgets, and backend reads and writes under realistic data volume with indexes and internal Views. Use right after independent acceptance converges, or when a user reports a slow page, first request or query.
metadata:
  source: "@aotter/mantle"
  sourcePath: docs/skills/performance/SKILL.md
  applies_to: mantle 0.2
  projection: package
---

# Mantle Performance

This skill sets direction: when to run, what to aim for, in what order and when
to stop. It names no tools or commands. Choose the measurement and repair
methods that fit the application, its host and the tools available to you; the
targets and rules below are what stay fixed.

## When to run

- **After acceptance.** Once [independent acceptance](../../handbook/guides/agent-workflow-acceptance.md)
  reports CONVERGED for a new application or a feature, continue here before
  reporting done. Never optimize behavior that has not been accepted: after
  BLOCKED or UNVERIFIED, report that and stop.
- **On request.** When a user reports a slow page, slow first request or slow
  query, run only the part that covers it, then check the others it could affect.

## Choose what to run

Decide from the manifests, the service entry and the changed files, not from
guesses about future use. Run every part whose condition holds; record each
skipped part with its reason.

| Run | When the application or change has | Skip when |
|---|---|---|
| Front end | Pages a browser opens directly that the application authors: public pages, member pages, a custom frontend, Admin customisations | The only browser UI is SDK-built Admin, unchanged; MCP and REST alone have no page to measure |
| Cold start | A deployed Worker or service entry: always for a new application; for a change, any added or moved import in the entry, its startup graph, a page's or an MCP App entry's first-load code | The change touched no import, entry, page or MCP App bundle |
| Backend reads | Views, or Store reads in handlers, whose rows grow with data: lists, search, paging, joins, aggregates, totals, reports | Only id lookups and small, bounded configuration tables |
| Backend writes | Procedures or Store writes that run often or concurrently: stock, counters, approvals, checkout, imports | Rare single-row administrative writes |

A change in one part can move another: an added index slows writes, a shared
stylesheet or entry import affects every page. Re-measure what a repair can reach.

## Front end

**Target:** the highest Lighthouse performance score the page allows, with a
floor of 90 on mobile and 95 on desktop for every distinct page template, and
no regression in accessibility, SEO or best practices.

- Measure a production build, several runs on mobile and desktop, and report the
  range. Separate what is real from what only the local environment causes
  (no compression or HTTP/2, a cold cache) and say which is which.
- Measure pages behind sign-in (member pages, Admin) through the role's session
  URL that `pnpm accept` prints
  ([hand each role](../../handbook/guides/agent-workflow-acceptance.md#hand-each-role-to-its-evaluator)),
  never by weakening sign-in.
- Find the actual bottleneck before changing anything; a trace beats a guess.
- Repair in this order: what blocks the first paint (render-blocking styles and
  font stylesheets, request chains, unused bytes), then main-thread work (heavy
  scripts, animations, layout of off-screen content), then repeat visits
  (content-hashed assets cached long, HTML revalidated).
- When a bottleneck appears only because the measuring environment lacks
  something (a GPU, a fast CPU), fix it only in a way that also helps real users
  without it. Never detect the measuring tool to serve it a different page.
- After every change, prove nothing else moved: the page looks the same, links,
  forms and in-page anchors still work, and the
  [public-page checks](../../handbook/guides/public-pages.md#check-before-you-report-done)
  still pass without JavaScript.

## Cold start

**Target:** budgets that force code to load when it is needed, not before.

- **Worker:** its startup graph imports only what every request needs; auth, MCP,
  Admin and rarely used routes load on the request that uses them
  ([size and startup](../../handbook/guides/size-and-startup.md)). On Workers the
  startup graph is the entry chunk `mantle bundle` writes under `<outdir>/worker`
  plus the chunks it imports statically ([outputs](../../handbook/start/project-and-cli.md#outputs));
  anything behind a dynamic import is outside it. Report its compressed size
  locally; measure the host's startup time only on
  a deployment the user has authorized, and keep it well under the host's limit
  (aim below 50 ms on Cloudflare).
- **Pages:** each page's first load carries at most 100 KB of compressed
  JavaScript, and only what the first paint and first interaction need. Move the
  rest behind dynamic imports, on use or when the browser is idle. MCP App
  entries are held to the same budget; they render inside a host, so Lighthouse
  does not measure them.
- An overrun is a finding to repair by splitting, not a budget to raise. Raise a
  budget only with the user's agreement and record why.

## Backend

**Target:** every read and write the application's surfaces actually make stays
fast at a realistic volume, and no hot path scans a table that grows.

- **Data:** seed an isolated local database, never a shared or production one,
  with data shaped like real use: several owners and roles, every state, long
  text where fields allow it, and more than one page of results everywhere. Size
  the largest tables at 100,000 rows or 10 times the expected first-year volume,
  whichever is larger. Seed with SQL straight into that database, setting the
  native columns as [reserved entry columns](../../handbook/reference/schema.md#reserved-entry-columns)
  describes: it is test data, not an application write.
- **Load:** call every View and Procedure through the same callers and surfaces
  the application uses, as each role. The app's local test harness already
  starts it on a fresh database, signs each role in and calls routes and MCP
  tools as that role ([local HTTP checks](../../handbook/guides/local-testing.md#what-smoke-covers)).
  Record typical and slow-tail latency and
  rows read, then run concurrent writers wherever contention matters. A business
  rule that breaks under concurrency (oversell, double approval, lost update) is
  a correctness defect, not a performance finding: fix it first.
- **Aim:** hot reads stay in the tens of milliseconds locally at seeded volume,
  and their cost does not grow with table size.
- **Repair in this order:**
  1. Read the native query plan of each hot path, using the SQL in its generated
     query module under `generated/` against the seeded database; a full scan of a
     growing table is a finding.
  2. Add the index that serves it in the Schema's `indexes`
     ([indexes](../../handbook/reference/schema.md#indexes-checks-and-search))
     together with a native migration ([database changes](../develop/SKILL.md#database-changes)).
     Index only what a measured query uses; every index costs writes.
  3. Move complex reads (joins, aggregates, OR, reuse) into an
     [internal View](../../handbook/guides/typed-queries.md#declare-an-internal-view),
     page with keysets ([results and paging](../../handbook/reference/view.md#results-and-paging)),
     and replace exact totals on hot paths ([search and totals](../../handbook/reference/view.md#search-and-totals)).
  4. Re-measure reads and writes after each repair.

## Rules

- Speed never buys a lower standard: scope, authorization, OCC, atomicity,
  accessibility, the public-page requirements and every explicit user
  requirement stay intact. The application's writes still go through Store and
  Procedures; only seed data for the isolated test database is inserted directly.
- Do not lower a target, shrink the seeded data or drop a slow case to pass.
  Report what is left instead.
- Work locally. Deploying or measuring a deployment follows the
  [provision skill](../provision/SKILL.md) and needs the user's authorization.
- After any repair, rerun the [local HTTP checks](../../handbook/guides/local-testing.md).
  A repair that changes what a user sees or can do is no longer only a
  performance change: run acceptance again for that surface.
- Stop when every target is met, after three rounds, or when two rounds in a row
  bring no measurable gain.

## Report

For each part: run or skipped (with the reason), the environment, before and
after numbers as ranges, what changed and what is left. Close with one verdict
beside the acceptance verdict: **PASS** (every target that applies is met),
**PARTIAL** (improved, with the targets still missed and why) or **SKIPPED**
(nothing applied).
