import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initialBodyBuffer, readBoundedBody } from '../src/bounded-body.mjs'
import { sourceArchiveLimit, sourceEntryLimit, sourceExpandedLimit } from '../src/source-zip.mjs'

const script = name => fileURLToPath(new URL(`memory/${name}.mjs`, import.meta.url))
// The source PUT must stay comfortably inside a 128 MB Worker: the body at the caps plus checking it.
// Process-level peaks vary by a few MB between machines and Node builds, so the bounds leave that margin.
const budget = 64_000_000
const overhead = 12_000_000

test('a source PUT at the caps peaks at the body plus a few MB', { skip: !existsSync('/proc/self/status') && 'needs /proc (Linux)', timeout: 120_000 }, async () => {
  assert.deepEqual([sourceEntryLimit, sourceExpandedLimit, sourceArchiveLimit], [2_000, 40_000_000, 42_000_000])
  const dir = await mkdtemp(join(tmpdir(), 'mantle-source-memory-'))
  try {
    for (const kind of ['incompressible', 'compressible', 'single']) {
      const file = join(dir, `${kind}.zip`)
      const made = JSON.parse(execFileSync(process.execPath, [script('generate'), kind, file], { encoding: 'utf8' }))
      assert.ok(made.expanded > sourceExpandedLimit - 100_000 && made.archive <= sourceArchiveLimit, kind)
      // A fresh process per measurement, so nothing else is resident.
      for (const declared of ['declared', 'undeclared']) {
        const measured = JSON.parse(execFileSync(process.execPath, ['--expose-gc', script('measure'), file, declared], { encoding: 'utf8' }))
        assert.equal(measured.body, made.archive)
        assert.ok(measured.peak < budget, `${kind}/${declared}: peak ${measured.peak} bytes above baseline (body ${measured.body})`)
        assert.ok(measured.peak - measured.body < overhead, `${kind}/${declared}: checking added ${measured.peak - measured.body} bytes`)
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('stored source paths (publish and download) stream the archive and hold only chunks', { skip: !existsSync('/proc/self/status') && 'needs /proc (Linux)', timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mantle-source-memory-'))
  try {
    const file = join(dir, 'incompressible.zip')
    execFileSync(process.execPath, [script('generate'), 'incompressible', file], { encoding: 'utf8' })
    for (const path of ['hash', 'download']) {
      const measured = JSON.parse(execFileSync(process.execPath, ['--expose-gc', script('measure-stored'), file, path], { encoding: 'utf8' }))
      assert.ok(measured.bytes > sourceArchiveLimit - 2_000_000, path)
      // Chunks and stream bookkeeping only: well under half of the archive, which is never held whole.
      assert.ok(measured.peak < 20_000_000, `${path}: peak ${measured.peak} bytes above baseline for a ${measured.bytes}-byte archive`)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the body reader grows one buffer: a small or trickled body never reserves the bound', async () => {
  const stream = (...chunks) => new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk)); controller.close() } })
  // A few bytes, declared or not, against a 42 MB bound: at most the 1 MB first step.
  assert.equal((await readBoundedBody(stream([1, 2], [3]), sourceArchiveLimit, '3')).bytes.buffer.byteLength, 3)
  assert.equal((await readBoundedBody(stream([1, 2], [3]), sourceArchiveLimit)).bytes.buffer.byteLength, initialBodyBuffer)
  // A trickle of 100 × 20 KB under a declared 42 MB: the buffer tracks what arrived.
  const trickle = Array.from({ length: 100 }, () => new Uint8Array(20_000))
  await assert.rejects(readBoundedBody(stream(...trickle), sourceArchiveLimit, String(sourceArchiveLimit)), error => error.code === 'upload_length_mismatch')
  const grown = await readBoundedBody(stream(...trickle), sourceArchiveLimit)
  assert.equal(grown.bytes.length, 2_000_000)
  assert.ok(grown.bytes.buffer.byteLength <= 4 * initialBodyBuffer, String(grown.bytes.buffer.byteLength))
  // Past a sixteenth of the bound it grows straight to the bound, once.
  const big = await readBoundedBody(stream(...Array.from({ length: 60 }, () => new Uint8Array(65_536))), sourceArchiveLimit)
  assert.equal(big.bytes.buffer.byteLength, sourceArchiveLimit)
  assert.deepEqual(await readBoundedBody(stream([1, 2], [3]), 10, '3'), { bytes: new Uint8Array([1, 2, 3]),
    sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81' })
  assert.equal((await readBoundedBody(stream([1, 2], [3]), 10)).bytes.length, 3)
  await assert.rejects(readBoundedBody(stream([1, 2], [3]), 2), error => error.code === 'upload_too_large')
  for (const [declared, code] of [['x', 'upload_length_invalid'], ['11', 'upload_too_large'], ['2', 'upload_length_mismatch'], ['4', 'upload_length_mismatch']])
    await assert.rejects(readBoundedBody(stream([1, 2], [3]), 10, declared), error => error.code === code, String(declared))
})
