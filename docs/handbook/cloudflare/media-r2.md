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

Applications own their R2 binding, public bucket URL and S3 credentials; the SDK
package does not manage them. Import `r2MediaStorage` from `@aotter/mantle/media/r2`:

```ts
const storage = r2MediaStorage({
  bucket: env.MEDIA,
  endpoint: "https://bucket.account.r2.cloudflarestorage.com",
  publicBase: "https://media.example.com",
  signer, // app-owned SigV4 signer: sign(url, {method:"PUT",aws:{signQuery:true,service:"s3"}})
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
the client. Configure bucket CORS to allow PUT from the application's origins
and the returned Content-Type header. Uploads go to `uploads/<purpose>/<group>/<role>.<ext>` and each commit copies them
to `committed/<group>/<attempt>/<role>.<ext>`. Serve the `committed/` prefix on the public domain. Keep `uploads/`
private/unserved on the public domain and add a bucket lifecycle rule for abandoned upload keys. Mantle 0.1.x wrote
`<purpose>/<group>/<role>.<ext>` keys (`<group>/<role>.<ext>` when the purpose was not a plain slug); an asset reads its keys from the stored `storageKey` and `publicUrl` of each
variant, so 0.1.x assets keep working while their prefixes stay served.

Commit checks every object's MIME and size, then rechecks the exact GET
response used for the copy. Public keys cannot be reached by an upload URL. Each commit attempt has a separate
public-key UUID, while the asset id remains the upload-group UUID. A concurrent
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
