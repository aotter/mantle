// Writes a source ZIP at the caps: `incompressible` (random bytes up to the
// archive cap), `compressible` (hex text up to the expanded cap) or `single`
// (one entry holding the archive cap).
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { canonicalSourceZip, sourceArchiveLimit, sourceEntryLimit, sourceExpandedLimit } from '../../src/source-zip.mjs'

const [kind, out] = process.argv.slice(2)
const yaml = new TextEncoder().encode('a: 1\n')
const files = { 'manifests/site.yaml': yaml }
// Stored entries: the archive is the content plus headers.
const room = Math.min(sourceExpandedLimit, sourceArchiveLimit - sourceEntryLimit * 120) - 10_000
if (kind === 'single') files['assets/blob.bin'] = new Uint8Array(randomBytes(room))
else {
  const count = sourceEntryLimit - 1, per = Math.floor((kind === 'incompressible' ? room : sourceExpandedLimit - 10_000) / count)
  for (let i = 0; i < count; i++) files[`src/f${String(i).padStart(4, '0')}.${kind === 'incompressible' ? 'bin' : 'ts'}`] =
    kind === 'incompressible' ? new Uint8Array(randomBytes(per)) : new TextEncoder().encode(randomBytes(Math.ceil(per / 2)).toString('hex').slice(0, per))
}
const zip = canonicalSourceZip(files)
writeFileSync(out, zip)
process.stdout.write(JSON.stringify({ archive: zip.byteLength, expanded: Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0), entries: Object.keys(files).length }) + '\n')
