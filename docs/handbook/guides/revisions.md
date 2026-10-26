---
description: Correct published content without taking it offline - a publishing parent that points at one of its operational revisions, an atomic switch Procedure, a preview route, rollback and pruning.
---
# Edit published content without downtime

Admin's record form edits a `publishing` row only while it is a draft, so correcting a published post through it means
unpublish, edit, republish, and the page is gone in between. This page splits the post into a stable parent and its
revisions, so the public page keeps showing one revision while an editor prepares the next, previews it, and switches
to it in one atomic write. A [Schema lock](../reference/schema.md#locks) freezes the revision that is live, for every
caller. Everything is manifests, one ref handler and one app route; nothing depends on generated storage internals.

`packages/mantle/tests/revisions.test.ts` runs these manifests, the handler and the route on bun:sqlite and PostgreSQL
(the yaml blocks below are its fixture, and the docs check generates them and typechecks the TypeScript), and
`packages/mantle-admin/tests/native/revisions.test.ts` drives the same app through Admin's routes.

## When to use it

Use it when a published page must stay up while its replacement is written and reviewed: articles, product copy, legal
text, anything with inbound links or search traffic. It also gives a preview link of exactly what will go live, and
rollback.

Without revisions, keep one `publishing` Schema. A personal blog whose admins correct typos can opt into
`publishing: { liveEdits: true }`: Admin's record form then edits a published post in place, every save goes live on
commit with no preview, and the post must still pass `publish`'s required-field checks
([lifecycle](../concepts/lifecycle-and-locales.md)). Without `liveEdits`, unpublish, edit and republish; that is fine for
content nobody minds being offline for a minute. Both are less to build than this page.

## The shape

- **`posts`** (`lifecycle: publishing`) is the stable identity: the `slug`, and anything else that makes up the URL,
  plus `current_revision`, a reference to the revision the page shows. Its publishing status alone decides whether the
  URL is live.
- **`post_revisions`** (operational) holds the content (`title`, `summary`, `body`) and a `post` reference.
  `nav.parentField: post` folds them under their post in Admin. A revision edits in place until a post shows it; then
  the `live_revision` lock refuses every update and delete of it, whoever asks (admins included): Admin's routes and the
  MCP clients that use them, Procedures over REST or MCP, and caller-bound Stores. It stays frozen until the post
  switches to another revision.
- **Public Views** read a post joined to its current revision. Public Views only see published rows, so a draft or
  unpublished post shows nothing.
- **`switch-revision`** is an admin-only ref Procedure. It checks the revision belongs to the post and is complete, then
  writes `current_revision` through `ctx.store` with `lock: expectedVersion`. That is one row write: readers see the
  old revision until it commits and the new one after, and a concurrent change is `CONFLICT`. It is a ref handler
  because a SQL Procedure cannot write a `publishing` Schema.
- **`new-revision`** copies the current revision into a new row to edit. **`prune-revision`** deletes a revision that is
  not live. **`revision-preview`** reads any revision for the preview route.

## Schemas

`current_revision` and `post` are `readOnly`: Admin's record form shows them but never writes them, so only
`switch-revision` moves a post to another revision, and a revision never moves to another post. snake_case field names
keep the manifest name and the Store's storage name the same (`current_revision`, not `currentrevision`).

`current_revision` is `required`, so `publish` refuses a post without one (a draft may still lack it). The lock's
`EXISTS` runs on every guarded write and every Admin read of a revision, so generation proves an index serves it:
`indexes: [[current_revision]]` on `posts` (without it, `LOCK_INDEX_MISSING`). Inside the subquery the locked row is
always qualified, `post_revisions.id`; the lock is evaluated against the stored rows, so a post the caller cannot see
still locks its revision.

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  lifecycle: publishing
  uniqueIndexes: [[slug]]
  # Serves post_revisions' live_revision lock (generation proves it).
  indexes: [[current_revision]]
  schema:
    type: object
    additionalProperties: false
    required: [slug, current_revision]
    properties:
      slug: { type: string, pattern: "^[a-z0-9-]+$", maxLength: 100 }
      # Written only by switch-revision: Admin's record form leaves it alone.
      current_revision: { type: string, x-mantle-ref: post_revisions, readOnly: true }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: post_revisions }
spec:
  title: Post revisions
  lifecycle: operational
  indexes: [[post, createdAt, id]]
  lock:
    - name: live_revision
      on: [update, delete]
      when: EXISTS (SELECT 1 FROM posts p WHERE p.current_revision = post_revisions.id)
      message: "This revision is live. Start a New revision from its post, edit and preview it, then Switch revision."
  uiSchema:
    nav: { parentField: post }
    list: { primaryField: title, columns: [note] }
    fields: { body: { widget: textarea } }
  schema:
    type: object
    additionalProperties: false
    required: [post, title, summary, body]
    properties:
      # Set once by new-revision; a revision never moves to another post.
      post: { type: string, x-mantle-ref: posts, readOnly: true }
      title: { type: string }
      summary: { type: string }
      body: { type: string }
      note: { type: string }
```

The required reference does not fold `posts` under `post_revisions`: the revisions' explicit `nav.parentField` decides
the direction. An editor's checklist is "switch a revision in, then publish": Admin refuses publishing first with
`INPUT_VALIDATION_FAILED` naming `current_revision`, and the generated `posts.publish` Procedure with `CONFLICT`.

## Views

The join also requires `r.post = p.id`, so a post never shows another post's revision even if its reference was
written by other code. A lookup by a unique field ends its `ORDER BY` with the Schema's `id`, which generation needs to
prove it returns one row. `published_at` is the first publication; `switched_at` (the post's `updated_at`, which the
switch moves) and `edited_at` give the page's last-modified date.

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: post-page }
spec:
  description: A published post with its current revision, by slug.
  surface: public
  input:
    type: object
    additionalProperties: false
    required: [slug]
    properties:
      slug: { type: string }
  sql: |
    SELECT p.slug, r.title, r.summary, r.body, p.published_at, p.updated_at AS switched_at, r.updated_at AS edited_at
    FROM posts p JOIN post_revisions r ON r.id = p.current_revision AND r.post = p.id
    WHERE p.slug = input.slug
    ORDER BY p.id
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: published-posts }
spec:
  description: Every published post with the title of its current revision, for the list page and the sitemap.
  surface: public
  sql: |
    SELECT p.id, p.slug, r.title, r.summary
    FROM posts p JOIN post_revisions r ON r.id = p.current_revision AND r.post = p.id
    ORDER BY p.id
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: revision-preview }
spec:
  description: Any revision as its post's page would show it, for the preview route.
  surface: admin
  requires: { auth: { all: [ctx.admin] } }
  uiSchema: { nav: { hidden: true } }
  input:
    type: object
    additionalProperties: false
    required: [revision]
    properties:
      revision: { type: string }
  sql: |
    SELECT r.id, p.slug, r.title, r.summary, r.body, r.updated_at AS edited_at
    FROM post_revisions r JOIN posts p ON p.id = r.post
    WHERE r.id = input.revision
    ORDER BY r.id
```

`revision-preview` reads drafts and unpublished posts too, because its caller is an admin. It is hidden from the
sidebar, since it needs an input; the admin MCP endpoint and the preview route still reach it.

## Start a new revision

One SQL statement copies the current revision (or starts empty when the post has none). `target` puts a "New revision"
button on the post's page in Admin with the post filled in; `collectionAction` also puts it in the revisions list
header: in the post's Post revisions tab the post is filled in (the input is named like `nav.parentField`), and in the
standalone list the editor picks it. It runs as one statement on every target, D1 included.

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: new-revision }
spec:
  title: New revision
  description: Start a new revision of this post from its current one; a post without one starts empty.
  requires: { auth: { all: [ctx.admin] } }
  target: { schema: posts, id: post }
  uiSchema: { collectionAction: post_revisions }
  input:
    type: object
    additionalProperties: false
    required: [post]
    properties:
      post: { type: string }
  output: { type: object }
  handler:
    sql: |
      INSERT INTO post_revisions (post, title, summary, body, note)
        SELECT p.id, COALESCE(r.title, ''), COALESCE(r.summary, ''), COALESCE(r.body, ''), CASE WHEN r.id IS NULL THEN 'First revision' ELSE 'Copied from the current revision' END
        FROM posts p LEFT JOIN post_revisions r ON r.id = p.current_revision AND r.post = p.id
        WHERE p.id = input.post
        RETURNING id, version
```

`INSERT … SELECT` is a set write: an unknown post inserts nothing and returns `results: [[]]` rather than an error.

## Switch, and roll back

The Procedure is bound to the post (`target` with `version: expectedVersion`), so Admin shows "Switch revision" on the
post's page with the version the editor reviewed; `revision` is a picker over that post's revisions (it folds
under the post, so Admin lists only the bound post's children).

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: switch-revision }
spec:
  title: Switch revision
  description: Make one of this post's complete revisions the one its page shows. Also rolls back to an earlier revision.
  requires: { auth: { all: [ctx.admin] } }
  target: { schema: posts, id: post, version: expectedVersion }
  input:
    type: object
    additionalProperties: false
    required: [post, revision, expectedVersion]
    properties:
      post: { type: string }
      revision: { type: string, x-mantle-ref: post_revisions }
      expectedVersion: { type: integer }
  output: { type: object }
  handler: { ref: switch-revision }
```

The handler, in `src/handlers.ts`. "Complete" here means every text field is non-blank: an operational `required`
field is NOT NULL but may be `''`, which `new-revision` writes for a post's first revision. Put your own checks (a
minimum length, a reviewed flag) in the same place. A revision of another post, or a missing one, is
`INPUT_VALIDATION_FAILED` (400); a stale `expectedVersion` is `CONFLICT` (409) from the Store's `lock`.

```ts
import { ContractError } from "@aotter/mantle/contracts";
import type { Handlers } from "../generated/generated.js";

export const handlers: Handlers = {
  "switch-revision": async ({ store }, { post, revision, expectedVersion }) => {
    const next = await store.collection("post_revisions").findById(revision);
    if (!next || next.post !== post) throw new ContractError("INPUT_VALIDATION_FAILED", "That revision is not one of this post's revisions.", "procedures/switch-revision");
    if (![next.title, next.summary, next.body].every(text => text.trim())) throw new ContractError("INPUT_VALIDATION_FAILED", "The revision is incomplete: it needs a title, a summary and a body.", "procedures/switch-revision");
    // One row write. A stale expectedVersion is CONFLICT, and status and published_at stay as they are.
    const row = await store.collection("posts").update(post, { current_revision: revision }, { lock: expectedVersion });
    return { id: row.id, version: row.version, current_revision: row.current_revision };
  },
};
```

Once the switch commits, the lock freezes the new current revision: nobody can edit or delete it until the post
switches away again. The handler's checks and its write are still two steps, not one transaction, and the lock only
holds once the write has committed. A delete of the chosen revision, or an edit that blanks it, that commits between
the handler's read and its write is allowed (the revision is not live yet). A deleted revision leaves the post with no
page (404) until the next switch; a blanked one still joins, so the page renders an empty post. The same window runs
the other way: under PostgreSQL READ COMMITTED, an edit of a revision that races the switch to it can still commit just
after the switch, because its lock check did not see the new pointer yet. The switch Procedure is the serialization point; add your own checks there.
Only admins can do any of this, so for most sites it is acceptable: switch again to recover. If several editors work
on the same post at once, check the page after switching.

Rolling back is the same call with an earlier revision. Wire the handlers as every app does
(`adminBindings({ handlers })`, `rest(...)`, `mcp(...)` options; see `mantle help native-admin`).

## Prune

Old revisions are rows; keep them as history or delete them when you like. The Procedure is a plain `DELETE`: the
`live_revision` lock adds its condition to the statement, so deleting the revision a post shows deletes nothing and is
`CONFLICT` with `kind: "lock"` and the lock's message. Admin shows "Delete revision" on each revision. Its own Delete
button on a revision's row (in the Post revisions list and tab) is disabled for the live revision, with the lock's
message, and the server refuses it the same way if it is sent anyway. The Procedure also gives AI clients on
`/mcp/admin` a delete tool (below).

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: prune-revision }
spec:
  title: Delete revision
  description: Delete a revision that is not live.
  requires: { auth: { all: [ctx.admin] } }
  target: { schema: post_revisions, id: id }
  input:
    type: object
    additionalProperties: false
    required: [id]
    properties:
      id: { type: string }
  output: { type: object }
  handler:
    sql: |
      DELETE FROM post_revisions WHERE id = input.id RETURNING id
```

Only a trusted write bypasses the lock: the system caller, a system Store or the TTL sweep, for a migration or a
maintenance script.
That is the escape hatch, visible in code review, not the editor's path.

## Admin operations

Admin lists an operation only when an admin MCP Trigger exposes it; the same Triggers give an AI client on `/mcp/admin`
the same three tools.

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: new-revision-admin }
spec: { source: { kind: mcp, surface: admin }, target: { procedure: new-revision } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: switch-revision-admin }
spec: { source: { kind: mcp, surface: admin }, target: { procedure: switch-revision } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: prune-revision-admin }
spec: { source: { kind: mcp, surface: admin }, target: { procedure: prune-revision } }
```

An editor's flow:

1. Create the post in Posts (a draft with its slug), then **New revision** on its page (or in its Post revisions tab,
   with the post filled in) and write the revision in the record form. **Switch revision** to it, open
   `/preview/<revision id>`, then **Publish** the post. Publishing before the switch is refused, naming
   `current_revision`.
2. To correct it later: open the live revision and Admin shows "This record is locked." with the lock's message, and
   Save is disabled; so is the Delete button on its row in the Post revisions list. So: **New revision** (a copy of what is live), edit the copy, preview it, then **Switch
   revision**, whose picker lists only this post's revisions. The page shows the old text until the switch commits;
   then the copy is the frozen one and the old revision edits again.
3. To roll back: **Switch revision** to the earlier one. **Delete revision** on revisions you no longer want.

A client that skips Admin's form gets the same answer: a patch or delete of the live revision through Admin's routes
(the Admin MCP App and WebMCP use them), a SQL Procedure's `UPDATE` or `DELETE` of it over REST or MCP, or a ref
handler's `ctx.store` update is `CONFLICT` with `kind: "lock"` and the lock's message.

## Preview route and the public page

Both pages go through one template, so the preview is what will go live. The public route reads as an anonymous
visitor even when the request carries an admin session; the preview route needs an admin and answers 404 to everyone
else, so a guessed revision id reveals nothing.

```ts
import { isAdmin, type Caller } from "@aotter/mantle/contracts";
import type { Handle } from "@aotter/mantle/driver/d1";
import postPage from "../generated/views/post-page.js";
import revisionPreview from "../generated/views/revision-preview.js";

const visitor: Caller = { kind: "anonymous" };
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The one template. The canonical URL is always the post's; a preview adds noindex and a banner. */
export function postHtml(origin: string, post: { slug: string | null; title: string; summary: string; body: string }, preview: boolean): string {
  const canonical = `${origin}/posts/${post.slug}`;
  const head = `<title>${escape(post.title)}</title><meta name="description" content="${escape(post.summary)}">`
    + `<link rel="canonical" href="${escape(canonical)}">`
    + (preview ? `<meta name="robots" content="noindex, nofollow">`
      : `<meta property="og:type" content="article"><meta property="og:url" content="${escape(canonical)}">`
        + `<meta property="og:title" content="${escape(post.title)}"><meta property="og:description" content="${escape(post.summary)}">`);
  const body = (preview ? `<p role="status">Preview: this revision is not live.</p>` : "")
    + `<article><h1>${escape(post.title)}</h1>${post.body.split(/\n{2,}/).map(text => `<p>${escape(text)}</p>`).join("")}</article>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}

const html = (status: number, body: string, headers: Record<string, string>) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

/** GET /posts/{slug} for visitors and GET /preview/{revisionId} for admins; any other path falls through. */
export async function postRoutes(request: Request, db: Handle, origin: string, caller: () => Promise<Caller>): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  const page = /^\/posts\/([a-z0-9-]+)$/.exec(path), preview = /^\/preview\/([^/]+)$/.exec(path);
  if (!page && !preview) return undefined;
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
  if (page) {
    const [post] = await postPage(db, visitor, { slug: page[1]! });
    return post ? html(200, postHtml(origin, post, false), { "cache-control": "no-cache" }) : html(404, "Not found", { "cache-control": "no-store" });
  }
  const who = await caller(), hidden = { "cache-control": "private, no-store", "x-robots-tag": "noindex" };
  if (!isAdmin(who)) return html(404, "Not found", hidden);
  const [revision] = await revisionPreview(db, who, { revision: preview![1]! });
  return revision ? html(200, postHtml(origin, revision, true), hidden) : html(404, "Not found", hidden);
}
```

Call it from `src/routes.ts`: `return postRoutes(request, env.DB, env.PUBLIC_ORIGIN, context.caller)`. The app shell's
`/sign-in` page can replace the 404 for signed-out editors if you prefer a redirect.

SEO notes:

- The canonical URL, Open Graph URL, sitemap and `llms.txt` entries name the post (`/posts/{slug}`), never a revision.
  Switching revisions changes the content under the same URL, so links and rankings carry over.
- Preview responses carry `<meta name="robots" content="noindex, nofollow">`, `X-Robots-Tag: noindex` and
  `Cache-Control: private, no-store`, and keep the post's canonical URL. Add `Disallow: /preview/` to `robots.txt`.
- JSON-LD `datePublished` is `published_at`; `dateModified` and the `Last-Modified` header are the later of
  `switched_at` and `edited_at`. A CDN in front of the page needs purging on switch, as on publish.
- Everything else a public page carries is in [public pages](public-pages.md); this example shows only what the
  revisions change.

## History and audit

The revisions are the content history: who may read them, switch and prune is the Procedures' `requires`. A record of
who changed what and when, across the whole app, is an observability concern rather than part of this content model;
it is planned outside the SDK, with Mantle Cloud's observability or the app's own logging when self-hosted, and the
SDK's part is being discussed as a way to observe writes (aotter/mantle#1796). Until then, a revision's `author_id`
and `created_at` say who started it and when, and the switch handler is the place to log a switch.
