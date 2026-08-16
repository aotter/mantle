---
name: media-gc
description: Audit and safely remove stale, uncommitted public media uploads from a Mantle Cloudflare R2 bucket. Use when a Mantle operator asks to inspect or clean orphan media objects left after create_media_upload without commit_media_upload.
---

# Mantle Media GC

Use the connected Cloudflare API. Audit by default; delete only the exact
objects approved by the user.

## Preflight

1. Read the project's Wrangler config and Mantle config. Resolve the R2 bucket
   binding, bucket name, and declared public media purpose names.
2. Confirm the exact Cloudflare account and bucket. If either is ambiguous,
   ask; never choose by name similarity.
3. Use the Cloudflare OpenAPI search before execution to resolve the current
   R2 List Objects and Delete Objects endpoints. If the connected account lacks
   access, stop. Do not create, request, or store credentials.
4. Stop when the project has no public R2 media binding or no declared purpose.

## Audit

For each declared purpose, list up to 1,000 objects per page under the exact
`<purpose>/` prefix. Use the API cursor until `is_truncated` is false.

An object is a deletion candidate only when all conditions hold:

- `last_modified` is more than 24 hours old;
- `custom_metadata.committedAt` is absent or empty;
- the key matches the exact Mantle layout
  `<purpose>/<group>/(primary|alternate|fallback).(png|jpg|webp|avif|gif|svg)`,
  where `<purpose>` is declared by this project and `<group>` contains only
  letters, digits, `_`, or `-`.

Skip committed, unknown-prefix, unprefixed, malformed, or ambiguous objects.
Delete only an uncommitted variant, never its whole group.

Report the account, bucket, purpose prefixes, UTC cutoff, candidate object and
group counts, total bytes, skipped count, and a SHA-256 digest of the sorted
`key + etag` candidate set. Do not print object keys, upload group IDs,
filenames, public URLs, signed URLs, or secrets.

## Apply

1. Show the audit summary and get explicit confirmation for that exact account,
   bucket, cutoff, count, byte total, and candidate-set digest.
2. Re-run the complete audit with the same UTC cutoff. If the candidate count,
   bytes, or digest changed, stop and present the new audit for confirmation.
3. Call Delete Objects with JSON arrays of exact keys, at most 1,000 keys per
   request. Never send the `prefix` query parameter: an empty prefix can empty
   the bucket.
4. Do not automatically retry failed keys. Report safe API error codes and
   counts; a later invocation can audit and retry what remains.
5. Re-list every inspected purpose prefix and report the remaining candidate
   count and bytes.

## Don't

- Don't create a Worker, Cron Trigger, lifecycle rule, D1 table, or local script.
- Don't use prefix deletion or empty-bucket operations.
- Don't delete private-media buckets or objects outside declared purpose
  prefixes.
- Don't treat missing pagination pages, metadata, or permissions as an empty
  result.

## Diagnostics

| Symptom | Action |
|---|---|
| Multiple matching accounts or buckets | Stop and ask the user to select the exact target. |
| A page is truncated without a cursor | Stop; do not delete from a partial audit. |
| A candidate has an unexpected key or metadata shape | Skip it and include it only in the aggregate skipped count. |
| A delete request partially fails | Report safe error codes and leave the remaining objects for a later audit. |

## When You're Done

Return whether the run was audit-only or applied, the aggregate before/after
counts and bytes, and any safely redacted failures.
