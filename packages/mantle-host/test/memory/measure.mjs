// The Cloud source-PUT path in one fresh process: the body arrives as 64 KiB
// views of a preloaded wire buffer (standing in for the network, so the
// stand-in allocates nothing), is read into one bounded buffer (hashed as it
// streams) and inspected. Prints the resident-set peak above the baseline taken just
// before the body arrives. Linux only (VmHWM); run with --expose-gc.
import { readFileSync } from 'node:fs'
import { readBoundedBody } from '../../src/bounded-body.mjs'
import { inspectSourceArchive, sourceArchiveLimit } from '../../src/source-zip.mjs'

const status = () => readFileSync('/proc/self/status', 'utf8')
const kib = (text, key) => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(text)[1]) * 1024
const wire = new Uint8Array(readFileSync(process.argv[2]))
globalThis.gc(); globalThis.gc()
const base = kib(status(), 'VmRSS')
// A fresh high-water mark from here on (Linux: writing 5 resets VmHWM).
try { (await import('node:fs')).writeFileSync('/proc/self/clear_refs', '5') } catch { /* older kernels: HWM stays conservative */ }
let at = 0
const stream = new ReadableStream({ pull(controller) {
  if (at >= wire.length) { controller.close(); return }
  controller.enqueue(wire.subarray(at, at + 65_536)); at += 65_536
} })
const { bytes, sha256: digest } = await readBoundedBody(stream, sourceArchiveLimit, process.argv[3] === 'undeclared' ? null : String(wire.length))
const afterBody = kib(status(), 'VmHWM') - base
const result = inspectSourceArchive(bytes, [{ sourceId: 'manifests/site.yaml', text: 'a: 1\n' }])
const peak = kib(status(), 'VmHWM') - base
process.stdout.write(JSON.stringify({ body: bytes.byteLength, digest, files: result.files.length, afterBody, peak }) + '\n')
