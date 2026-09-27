// The stored-source paths of Control in one fresh process: publish (and pairing)
// hash the stored archive by streaming it (`hash`), and the source download
// streams it straight into a Response (`download`). The archive arrives as
// 64 KiB views of a preloaded buffer standing in for R2. Prints the peak
// resident set above the baseline. Linux only; run with --expose-gc.
import { readFileSync, writeFileSync } from 'node:fs'
import { streamSha256 } from '../../src/bounded-body.mjs'

const status = () => readFileSync('/proc/self/status', 'utf8')
const kib = (text, key) => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(text)[1]) * 1024
const [file, path] = process.argv.slice(2)
const wire = new Uint8Array(readFileSync(file))
const object = () => { let at = 0; return new ReadableStream({ pull(controller) {
  if (at >= wire.length) { controller.close(); return }
  controller.enqueue(wire.subarray(at, at + 65_536)); at += 65_536
} }) }
globalThis.gc(); globalThis.gc()
const base = kib(status(), 'VmRSS')
try { writeFileSync('/proc/self/clear_refs', '5') } catch { /* HWM stays conservative */ }
let bytes = 0
if (path === 'hash') { await streamSha256(object()); bytes = wire.length }
else {
  // What the Worker returns: new Response(object.body); the client reads it chunk by chunk.
  const reader = new Response(object()).body.getReader()
  for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength }
}
process.stdout.write(JSON.stringify({ path, bytes, peak: kib(status(), 'VmHWM') - base }) + '\n')
