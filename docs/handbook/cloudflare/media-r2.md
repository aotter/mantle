# Optional site settings and media

Declare a TypeScript `siteDefaults` object using the 0.2 `SiteDefaults` shape and
pass it to generation, or use `mantle generate ... --site ./site-config.ts`.
Apply the emitted `schema.sql` to a new database; apply idempotent `site-seed.sql`
on subsequent deployments to seed only absent operator fields. Import `site` from the generated
`site` module; call `site(db, verifiedCaller).read()`, `.updateSettings({brand,title,
description})`, or `.media(storage)` to access the library. Construction runs no
queries, migrations, seeds, or storage work. The library accepts verified admin
Callers of any credential kind; the Admin handler must additionally keep its
cookie-session-only gate and the shared session-mutation origin check. The optional module is absent from
a Worker that does not import it.

Each media purpose in `siteDefaults.media.purposes` lists mime **slots** and a byte cap per full mime type:

```ts
{ name: "cover", required: ["image/jpeg,image/png,image/webp"], maxBytes: { "image/jpeg": 5_000_000, "image/png": 5_000_000, "image/webp": 5_000_000 } }
```

`required` entries use `<input accept>` grammar (full mime, comma list, or a subtype shorthand such as `webp`);
`maxBytes` must cover every mime the slots allow, keyed by the full mime type.

A slot may name a wildcard: `type/*` takes any type of that top-level type, `*/*` any type. A variant fills the slot
naming its own type first, then its `type/*`, then `*/*`, and its cap is that token's `maxBytes` entry:

```ts
{ name: "attachments", required: ["*/*"], maxBytes: { "*/*": 50_000_000 } }
```

Every type is a lowercase `type/subtype` without parameters, at most 127 characters on each side; generation refuses
another (`invalid-mime`) and an upload gets `MEDIA_MIME_REJECTED`. Images keep their checks (an AVIF or WebP larger
than its JPEG, PNG or GIF fallback is `MEDIA_VARIANTS_SUSPICIOUS_SIZE`); alt text is for images.

### Safe delivery

Object storage serves the stored bytes as they are, and Mantle checks an upload's type against what was declared, not
against the bytes. By default (`safeDelivery`, on unless the storage sets it to `false`):

- HTML, any XML type (SVG, XHTML and XSLT among them), JavaScript and `multipart/x-mixed-replace` are refused:
  `MEDIA_SVG_REJECTED` for SVG, `MEDIA_ACTIVE_CONTENT_REJECTED` for the rest.
- A type that is not shown inline is committed with `Content-Disposition: attachment` and the file's name, and a
  private read is signed with `response-content-disposition` set to the same value. Inline types are PNG, JPEG, GIF,
  WebP, AVIF, `application/pdf`, `audio/*` and `video/*`. The uploader's filename is therefore public in the stored
  header of a public asset of another type.

An attachment disposition only stops a browser from rendering a file it navigates to: a `<script src>` or stylesheet
link to the file ignores it, and without `nosniff` a browser runs a script served as `text/plain`, `application/json`
or `application/octet-stream`. So for any purpose with a wildcard or a type that is not an image:

- `X-Content-Type-Options: nosniff` on every response of the media origin is required (see below).
- Never list the media origin in a Content Security Policy `script-src` or `style-src`, and never serve media from a
  path on the application's own origin.

`r2MediaStorage({ ..., safeDelivery: false })` turns off the refusal and the attachment disposition. Do that only for a bucket served from an isolated origin:
its own registrable domain (ideally listed on the [Public Suffix List](https://publicsuffix.org/)) with nothing on it
that sets cookies. A media host that shares a registrable domain with the application, its sign-in or other tenants
lets an uploaded page send same-site requests with their cookies and set cookies on the parent domain. A private
storage's reads are signed S3 endpoint URLs; the account's S3 endpoint serves every bucket of the account path-style on
one origin the host does not control, so `safeDelivery: false` on a private storage serves active content from an
origin no host can isolate. Keep it on for private storage. A custom `MediaStorage` declares the
same with its `safeDelivery` property; when it is not `false`, it must store and serve each object with the
`contentDisposition` that `commitUpload` and `signRead` pass.

R2 cannot store `X-Content-Type-Options: nosniff` per object on a public bucket; add it, for every response of the media
domain, at the edge (a Cloudflare Transform Rule or a Worker in front of the bucket). It is required as soon as a
purpose takes a wildcard or a type that is not an image. On an R2 custom domain, a Response Header Transform Rule
on the zone does it on every plan: **Rules → Transform Rules → Modify Response Header**, match
`http.host eq "media.example.com"`, and **Set static** `X-Content-Type-Options` to `nosniff`. The same rule can
also set `Content-Security-Policy` to `sandbox`, which gives any document served from the media domain an opaque
origin with scripts off; check that the inline types your purposes take (PDF in particular) still display in the
browsers you support before adding it.

The Admin media library item carries `filename`, the uploaded file's name when the storage kept it (the R2 adapter
does), or `null`.

Applications own their R2 binding, public bucket URL and S3 credentials; the SDK
package does not manage them. Import `r2MediaStorage` from `@aotter/mantle/media/r2`:

```ts
const storage = r2MediaStorage({
  bucket: env.MEDIA,
  endpoint: "https://bucket.account.r2.cloudflarestorage.com",
  publicBase: "https://media.example.com",
  signer, // app-owned SigV4 signer: sign(url, {method:"PUT",headers:{"content-type":…},aws:{signQuery:true,service:"s3",allHeaders:true}})
});
const media = site(db, caller).media(storage);
const upload = await media.createUpload({
  filename: "cover.jpg", purpose: "cover",
  variants: [{mimeType:"image/jpeg",byteSize:1234,role:"primary"}]
});
// Client PUTs bytes directly to upload.capabilities[i].uploadUrl,
// with its requiredHeaders. Never send the bytes through Mantle.
const asset = await media.commitUpload(upload.uploadGroupId);
```

An existing S3 signer (for example an application already using aws4fetch) fits
this port. This package adds no AWS SDK. The signer must return a SigV4
query-signed PUT URL and preserve `X-Amz-Expires`; never give its credentials to
the client. A PUT is signed with its `Content-Type` in `headers` (and `allHeaders: true`, which aws4fetch needs to sign
that header), so the upload URL refuses another type; a client PUTs with exactly the `requiredHeaders` it was given. Configure bucket CORS to allow PUT from the application's origins
and the returned Content-Type header (and from each MCP host's App sandbox origin
when you register the [upload card](../guides/mcp-apps.md#the-upload-card); its
CSP names the storage's `uploadOrigin`, the origin of `endpoint`). Uploads go to `uploads/<purpose>/<group>/<role>.<ext>` and each commit copies them
to `committed/<group>/<attempt>/<role>.<ext>`. `<ext>` comes from the type when Mantle knows it (images, PDF, text,
CSV, JSON, ZIP, MP3, MP4, WebM), else from the filename (1 to 10 lowercase letters or digits, never a page or script
extension such as `html`, `svg` or `js`), else `bin`. Delivery uses the stored Content-Type, not the extension. The
commit streams each object from `get` to `put` through the Worker; the R2 binding has no server-side copy. Serve the `committed/` prefix on the public domain. An R2 custom domain serves every key, `uploads/` included, so block
`uploads/` on it at the edge (a WAF custom rule or a Worker route on that path that answers 404), and add a bucket
lifecycle rule for abandoned upload keys. `r2MediaStorage` keeps both prefixes in one bucket; a
custom `MediaStorage` can instead take uploads in a private bucket with no public domain and copy checked objects to the
public bucket in `commitUpload`, so `uploads/` is never on a public origin. Mantle 0.1.x wrote
`<purpose>/<group>/<role>.<ext>` keys (`<group>/<role>.<ext>` when the purpose was not a plain slug); an asset reads its keys from the stored `storageKey` and `publicUrl` of each
variant, so 0.1.x assets keep working while their prefixes stay served.

Commit checks every object's MIME and size, then rechecks the exact GET
response used for the copy. Public keys cannot be reached by an upload URL. Each commit attempt has a separate
public-key UUID, while the asset id remains the upload-group id (`<tag>_<uuid>`; the tag is
this database's `site_config.media_id_tag`, so another server's id is refused as `MEDIA_NOT_OWNED`). A concurrent
loser can neither overwrite nor remove the winner's objects. After SQL selects
the durable asset, the losing attempt removes only its own unselected copies.
Upload sources remain until the database commit succeeds, so an uncertain DB
write can be reconciled/retried with the same UUID. Failed object deletion keeps
the media row; retry the same id. An upload group expires after 15 minutes. Asset `createdAt` (`media_assets.created_at`) is the upload-group creation time in epoch milliseconds, not the later commit time; entry timestamps on D1 are microseconds ([reserved entry columns](../reference/schema.md#reserved-entry-columns)).
No R2 upload or deployment is performed by generation.

A positively identified native rollback deletes only that attempt's copied
objects. Plain/network failures lack rollback evidence, retain copies, and return
`OUTCOME_UNKNOWN`, including a lost D1 batch response.
An uncertain native write preserves copies, because they may belong to the
durable winning row. If SQL durability or unselected-copy cleanup returns `OUTCOME_UNKNOWN`, reconcile
storage with the durable `media_assets.variants` keys. Attempt-isolated copies
may remain after an uncertain outcome; never delete the winning asset's keys or
expire all `committed/` objects indiscriminately. The group UUID remains the
reconciliation and retry id.

Admin's `media` option takes a `MediaStorage` value, so build it where `env` is available (for example once per
Worker in the fetch handler). Uploads use presigned S3 PUT URLs: `wrangler dev --local` has an R2 binding but no S3
endpoint, so test the upload flow against a real bucket; local tests can cover everything up to the signed URL.

## Clean up stale uploads

An upload that was created but never committed leaves objects under `uploads/`. Cleaning them up is an operator task:
audit by default, and delete only the exact objects the user approves for that exact account and bucket. Create no
Worker, Cron Trigger, lifecycle rule, table or script for it, and never create, request or store credentials.

**Layout.** `POST /admin/api/media/uploads` issues presigned PUT URLs (15 minutes) for
`uploads/<purpose>/<group>/<role>.<ext>`. Commit copies each checked object to `committed/<group>/<attempt>/<role>.<ext>`
with `committedAt` metadata and removes the upload keys after the database commit; a rejected group also removes them.
An old upload key may be leftover cleanup from a successful or uncertain commit, so it is not evidence that the media row
is absent. Objects outside `uploads/` are never candidates; attempt copies under `committed/` are reconciled with live
database references separately, under their own authorization.

**Preflight.** Resolve the bucket `r2MediaStorage` uses and the purposes in `siteDefaults.media.purposes` from
`wrangler.jsonc` and the app entry. Confirm the exact account and bucket with the user; when either is ambiguous, ask,
never match by name. Stop when the app passes no `r2MediaStorage`, declares no purpose, or the connected account lacks
List/Delete Objects access.

**Audit.** For each declared purpose, page through `uploads/<purpose>/` until the listing is not truncated. A candidate
is more than 24 hours old, has no `committedAt`, and matches
`uploads/<purpose>/<group>/(primary|alternate|fallback).<ext>` (`<ext>` 1 to 10 lowercase letters or digits) with a declared purpose and a
`<group>` of letters, digits, `_` or `-`. Skip everything else (committed, unknown prefix, malformed, ambiguous) and
delete single variants, never a whole group. Report the account, bucket, prefixes, UTC cutoff, candidate object and
group counts, bytes, skipped count, and a SHA-256 digest of the sorted `key + etag` set; print no keys, group ids,
filenames, URLs or secrets. A page truncated without a cursor stops the run: never delete from a partial audit.

**Apply.** After explicit confirmation of the account, bucket, cutoff, count, bytes and digest, re-run the audit with the
same cutoff and stop if anything changed. Delete exact keys, at most 1,000 per request, and never send a `prefix`: an
empty prefix can empty the bucket. Do not retry failed keys automatically. Re-list each prefix and report whether the run
was audit-only or applied, the before/after counts and bytes, and redacted error codes.
