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

OSS applications own their R2 binding, public bucket URL and S3 credentials.
Mantle Cloud supplies that wiring by default; the OSS package has no Cloud API
or credential management. Import `r2MediaStorage` from `@aotter/mantle/media/r2`:

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
and the returned Content-Type header. Serve the `committed/` prefix on the public domain; these keys differ from 0.2's `{purpose}/{group}/{role}` keys. Keep `uploads/` private/unserved on the
public domain and add a bucket lifecycle rule for abandoned upload keys.

Commit checks every object's MIME and size, then rechecks the exact GET
response used for the copy. Public keys cannot be reached by an upload URL. Each commit attempt has a separate
public-key UUID, while the asset id remains the upload-group UUID. A concurrent
loser can neither overwrite nor remove the winner's objects. After SQL selects
the durable asset, the losing attempt removes only its own unselected copies.
Upload sources remain until the database commit succeeds, so an uncertain DB
write can be reconciled/retried with the same UUID. Failed object deletion keeps
the media row; retry the same id. An upload group expires after 15 minutes. Asset `createdAt` is the upload-group creation time (epoch milliseconds), not the later commit time.
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
