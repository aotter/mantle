import { r2MediaStorage, type S3Signer } from "@aotter/mantle/media/r2";

/**
 * Cover-image storage on the MEDIA R2 binding (docs/handbook/cloudflare/media-r2.md). Pass the result as Admin's
 * `media` option (with `site` from generated/site.ts); the Admin media library then creates an upload, the browser
 * PUTs the bytes straight to R2 with a presigned URL, and commit copies them under `committed/`.
 * Copy the committed asset's public URL into a recipe's `cover_url`.
 * AGENT: supply a SigV4 signer that returns query-signed PUT URLs, e.g. `new AwsClient({ accessKeyId, secretAccessKey })`
 * from aws4fetch with R2 S3 credentials kept as secrets. Configure bucket CORS for PUT from your origin.
 */
export function coverStorage(env: Env, signer: S3Signer) {
  return r2MediaStorage({ bucket: env.MEDIA, signer, endpoint: env.MEDIA_S3_ENDPOINT, publicBase: env.MEDIA_PUBLIC_BASE });
}
