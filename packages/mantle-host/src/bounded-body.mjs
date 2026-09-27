// Reads a request body into ONE contiguous buffer bounded by `limit` (and by
// Content-Length when declared), hashing the chunks as they arrive so no second
// copy exists for hashing. The buffer starts at 1 MB and doubles as bytes
// arrive; once doubling would pass a sixteenth of the bound it grows straight
// to the bound. A small or trickled body never reserves the bound (a client must
// first send ~1/16 of it), and the peak is at most the bound plus a sixteenth
// (the copy the last growth makes).
// node:crypto reaches Control through nodejs_compat.
import { createHash } from 'node:crypto'
import { CloudRuleError } from './static-artifact.mjs'

export const initialBodyBuffer = 1 << 20

/** Returns `{ bytes, sha256 }` for a body of at most `limit` bytes (exactly `declared` when given). */
export async function readBoundedBody(stream, limit, declared = null) {
  const reader = stream?.getReader()
  if (!reader) throw new CloudRuleError(400, 'body_required')
  const refuse = async code => { await reader.cancel().catch(() => {}); throw new CloudRuleError(400, code) }
  if (declared !== null && (typeof declared !== 'string' || !/^[0-9]{1,12}$/.test(declared))) return refuse('upload_length_invalid')
  const length = declared === null ? null : Number(declared)
  if (length !== null && length > limit) return refuse('upload_too_large')
  const bound = length ?? limit, hash = createHash('sha256')
  let bytes = new Uint8Array(Math.min(bound, initialBodyBuffer)), size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.byteLength > bound) return refuse(length === null ? 'upload_too_large' : 'upload_length_mismatch')
    if (size + value.byteLength > bytes.length) {
      let next = bytes.length * 2
      if (next > bound / 16) next = bound
      while (next < size + value.byteLength) next = Math.min(next * 2, bound)
      const grown = new Uint8Array(next)
      grown.set(bytes.subarray(0, size))
      bytes = grown
    }
    bytes.set(value, size)
    hash.update(value)
    size += value.byteLength
  }
  if (length !== null && size !== length) throw new CloudRuleError(400, 'upload_length_mismatch')
  return { bytes: size === bytes.length ? bytes : bytes.subarray(0, size), sha256: hash.digest('hex') }
}

/** SHA-256 of a byte stream, chunk by chunk: nothing beyond one chunk is held. */
export async function streamSha256(stream) {
  const hash = createHash('sha256'), reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return hash.digest('hex')
    hash.update(value)
  }
}
