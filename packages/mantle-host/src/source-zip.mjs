// Canonical source snapshot ZIP rules shared by Mantle Cloud and the CLI.
// The CLI builds the archive with canonicalSourceZip and re-reads it with
// inspectSourceArchive, so a local pack fails for the same reason Cloud would.
//
// Canonical form: STORED entries (no compression) sorted by UTF-16 code unit,
// contiguous from offset 0, no extra fields or comments, DOS time 1980-01-01
// 00:00, followed directly by the central directory. Checking an archive then
// allocates nothing proportional to its size: entry bytes are views of the
// upload and only their CRC is computed, so Cloud's peak memory for a source
// PUT is the body itself (see test/memory). Compression would need the whole
// entry, or a re-deflate, in memory to prove the bytes canonical.
import { strToU8 } from 'fflate'
import { CloudRuleError } from './static-artifact.mjs'

// Stored entries: the archive is the expanded bytes plus headers (at most 76 + 2 × 300
// bytes per entry). Cloud holds the whole archive while checking it, so these bound
// the source PUT's memory (test/memory measures it).
export const sourceExpandedLimit = 40_000_000
export const sourceArchiveLimit = 42_000_000
export const sourceEntryLimit = 2_000
export const sourcePathLimit = 300
// Case-insensitive, at any depth. Cloud rejects these instead of stripping them.
export const secretPathNames = Object.freeze(['.env', '.dev.vars', 'id_rsa', 'id_ed25519', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'credentials.json'])
export const secretPathSuffixes = Object.freeze(['.pem', '.key', '.p12', '.pfx'])
// Exact basenames of committed env templates; every other `.env.*` stays secret.
export const secretTemplateNames = Object.freeze(['.env.example', '.env.sample', '.dev.vars.example'])
const u16 = (bytes, at) => bytes[at] | bytes[at + 1] << 8
const u32 = (bytes, at) => (u16(bytes, at) | u16(bytes, at + 2) << 16) >>> 0
const invalid = () => new CloudRuleError(400, 'source_archive_invalid')
const expansion = () => new CloudRuleError(400, 'source_archive_expansion_limit')

/** True when one path segment (any case) is on the v1 secret-path denylist. Templates are exempt only as the file name. */
export function secretSourcePath(path) {
  const parts = path.toLowerCase().split('/')
  return parts.some((part, index) => !(index === parts.length - 1 && secretTemplateNames.includes(part)) && (secretPathNames.includes(part) ||
    part.startsWith('.env.') || part.startsWith('.dev.vars.') || secretPathSuffixes.some(suffix => part.endsWith(suffix))))
}

/**
 * True for a path an uploader may leave out of the snapshot (mantle-host --omit,
 * the static upload's `omitted`): any tracked path that is bounded, NFC, relative
 * and free of traversal and control characters. Unlike an archive path it may
 * hold % # ? : or a secret name, since leaving such a file out is the point.
 */
export const omittablePath = path => typeof path === 'string' && path.length > 0 && path.length <= sourcePathLimit && path === path.normalize('NFC') &&
  path.trim() === path && !path.startsWith('/') && !/[\\\u0000-\u001f\u007f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..')

/** Returns the lowercase collision key of an archive path, or throws its rule code. */
export function sourcePathKey(path) {
  if (!path || path.length > sourcePathLimit || path.startsWith('/') || path.endsWith('/') || path.trim() !== path || path !== path.normalize('NFC') ||
    /[%:#?\\\u0000-\u001f\u007f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..'))
    throw new CloudRuleError(400, 'source_archive_path_invalid', path)
  if (secretSourcePath(path)) throw new CloudRuleError(400, 'source_archive_secret_path', path)
  return path.toLowerCase()
}

const dosDate = 0x21 // 1980-01-01; DOS time 00:00:00 is 0
const encoder = new TextEncoder()
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0 })
const crc32 = bytes => { let c = ~0; for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ c >>> 8; return ~c >>> 0 }
const put16 = (out, at, value) => { out[at] = value & 255; out[at + 1] = value >>> 8 & 255 }
const put32 = (out, at, value) => { put16(out, at, value & 0xffff); put16(out, at + 2, value >>> 16) }
const byName = (a, b) => a < b ? -1 : a > b ? 1 : 0

// A local (30 + name) or central (46 + name) header of the canonical form.
function header({ name, utf8, crc, size, offset }, central) {
  const out = new Uint8Array((central ? 46 : 30) + name.length)
  put32(out, 0, central ? 0x02014b50 : 0x04034b50)
  let at = 4
  if (central) put16(out, at, 20), at += 2
  put16(out, at, 20); put16(out, at + 2, utf8 ? 0x0800 : 0); put16(out, at + 4, 0); put16(out, at + 6, 0); put16(out, at + 8, dosDate)
  put32(out, at + 10, crc); put32(out, at + 14, size); put32(out, at + 18, size); put16(out, at + 22, name.length); put16(out, at + 24, 0)
  at += 26
  if (central) { put16(out, at, 0); put16(out, at + 2, 0); put16(out, at + 4, 0); put32(out, at + 6, 0); put32(out, at + 10, offset); at += 14 }
  out.set(name, at)
  return out
}

/** The canonical source ZIP for `path → bytes`. */
export function canonicalSourceZip(files) {
  let offset = 0
  const entries = Object.keys(files).sort(byName).map(path => {
    const bytes = files[path], name = encoder.encode(path)
    const entry = { name, utf8: name.length !== path.length, crc: crc32(bytes), size: bytes.length, offset, bytes }
    offset += 30 + name.length + bytes.length
    return entry
  })
  const central = entries.reduce((sum, entry) => sum + 46 + entry.name.length, 0)
  const out = new Uint8Array(offset + central + 22)
  let at = 0
  for (const entry of entries) { const local = header(entry, false); out.set(local, at); out.set(entry.bytes, at + local.length); at += local.length + entry.size }
  for (const entry of entries) { const record = header(entry, true); out.set(record, at); at += record.length }
  put32(out, at, 0x06054b50); put16(out, at + 8, entries.length); put16(out, at + 10, entries.length); put32(out, at + 12, central); put32(out, at + 16, offset)
  return out
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false
  for (let i = 0; i < left.byteLength; i++) if (left[i] !== right[i]) return false
  return true
}
const manifestPath = path => /^manifests\/.*\.ya?ml$/i.test(path)

// Central directory entries are bounded before any entry byte is read. The
// records must tile [cdOffset, EOCD) exactly and carry no extra fields or
// comments, and no ZIP64 record, locator or marker value may appear: other
// readers (Python's zipfile) would otherwise find a second, hidden directory.
const zip64Marker = 0xffffffff
function directory(bytes) {
  const end = bytes.byteLength - 22
  if (end < 0 || u32(bytes, end) !== 0x06054b50 || u16(bytes, end + 4) || u16(bytes, end + 6) ||
    u16(bytes, end + 8) !== u16(bytes, end + 10) || u16(bytes, end + 20)) throw invalid()
  if (end >= 20 && u32(bytes, end - 20) === 0x07064b50) throw invalid()
  const count = u16(bytes, end + 10), cdOffset = u32(bytes, end + 16), cdSize = u32(bytes, end + 12)
  if (count === 0xffff || cdOffset === zip64Marker || cdSize === zip64Marker) throw invalid()
  if (!count || count > sourceEntryLimit) throw expansion()
  if (cdOffset + cdSize !== end) throw invalid()
  const seen = new Set(), entries = []
  let expanded = 0, at = cdOffset
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || u32(bytes, at) !== 0x02014b50) throw invalid()
    const record = at, stored = u16(bytes, at + 10) === 0, compressed = u32(bytes, at + 20), size = u32(bytes, at + 24), local = u32(bytes, at + 42)
    if ([compressed, size, local].includes(zip64Marker) || u16(bytes, at + 30) || u16(bytes, at + 32)) throw invalid()
    const nameEnd = at + 46 + u16(bytes, at + 28)
    if (nameEnd > end) throw invalid()
    let name
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(at + 46, nameEnd)) }
    catch { throw invalid() }
    at = nameEnd
    const normalized = sourcePathKey(name)
    if (seen.has(normalized)) throw new CloudRuleError(400, 'source_archive_duplicate_path', name)
    seen.add(normalized)
    expanded += size
    if (size > sourceArchiveLimit || expanded > sourceExpandedLimit) throw expansion()
    // A stored entry's size is its byte count; a disagreement is a lie about one of them.
    if (stored && compressed !== size) throw invalid()
    if (local + 30 > cdOffset || u32(bytes, local) !== 0x04034b50 || u16(bytes, local + 28)) throw invalid()
    const start = local + 30 + u16(bytes, local + 26)
    if (start + compressed > cdOffset) throw invalid()
    entries.push({ name, size, stored, local, record, recordEnd: at, data: bytes.subarray(start, start + compressed) })
  }
  // Nothing may hide between the last record and the end-of-directory record.
  if (at !== end) throw invalid()
  return entries
}

/** True unless the archive holds exactly the candidate's YAML sources, byte for byte, and no other manifests/*.yaml. */
export function sourceManifestMismatch(files, sources) {
  const ids = new Set(sources.map(source => source.sourceId))
  if (Object.keys(files).some(path => manifestPath(path) && !ids.has(path))) return true
  return sources.some(source => !files[source.sourceId] || !equalBytes(files[source.sourceId], strToU8(source.text)))
}

/**
 * Cloud's full source-snapshot check: bounded read, secret denylist, exact YAML
 * and canonical bytes. Entry bytes stay views of `bytes`; nothing proportional
 * to the archive is allocated.
 */
export function inspectSourceArchive(bytes, sources) {
  if (bytes.byteLength > sourceArchiveLimit) throw new CloudRuleError(400, 'source_archive_too_large')
  const entries = directory(bytes)
  // A compressed entry is never canonical; its bytes are not the content either.
  if (entries.some(entry => !entry.stored)) throw new CloudRuleError(400, 'source_archive_noncanonical')
  const ids = new Set(sources.map(source => source.sourceId)), manifests = Object.create(null)
  let expanded = 0, offset = 0, canonical = true
  for (const entry of entries) {
    // Views, not copies: only what the YAML comparison reads.
    if (ids.has(entry.name) || manifestPath(entry.name)) manifests[entry.name] = entry.data
    expanded += entry.size
  }
  if (sourceManifestMismatch(manifests, sources)) throw new CloudRuleError(409, 'source_manifest_mismatch')
  entries.forEach((entry, index) => {
    if (index && byName(entries[index - 1].name, entry.name) >= 0) canonical = false
    if (!canonical || entry.local !== offset) { canonical = false; return }
    const name = encoder.encode(entry.name)
    const shape = { name, utf8: name.length !== entry.name.length, crc: crc32(entry.data), size: entry.size, offset }
    if (!equalBytes(header(shape, false), bytes.subarray(entry.local, entry.local + 30 + name.length)) ||
      !equalBytes(header(shape, true), bytes.subarray(entry.record, entry.recordEnd))) canonical = false
    offset += 30 + name.length + entry.size
  })
  // Entries are contiguous from 0 and the central directory follows them directly.
  if (!canonical || u32(bytes, bytes.byteLength - 22 + 16) !== offset) throw new CloudRuleError(400, 'source_archive_noncanonical')
  return { files: entries.map(entry => entry.name).sort(), expandedBytes: expanded }
}
