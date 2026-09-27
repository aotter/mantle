import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { packFrontend, sha256 } from '../src/pack.mjs'
import { packBackend } from '../src/pack-backend.mjs'
import { canonicalSourceZip, inspectSourceArchive, secretSourcePath } from '../src/source-zip.mjs'
import { inspectStaticAssets } from '../src/static-artifact.mjs'
import { assertClosedModule } from '../src/closed-module.mjs'
import { corePin } from '../src/version.mjs'

const yaml = 'apiVersion: cms.mantle.aotter.net/v1\nkind: Schema\nmetadata:\n  name: items\nspec:\n  title: Items\n  schema:\n    type: object\n'

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'mantle-cloud-cli-'))
  const put = async (path, text) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text) }
  await put('manifests/site.yaml', yaml)
  await put('handlers.mjs', 'export const handlers = { ping: () => "pong" }')
  await put('package.json', '{"name":"app","private":true}\n')
  await put('src/main.ts', 'console.log("app")\n')
  await put('dist/index.html', '<!doctype html><h1>App</h1>')
  await put('dist/assets/app.js', 'console.log(1)')
  await put('dist/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await put('.git/config', '[core]\n')
  await put('node_modules/dep/index.js', 'module.exports = 1')
  await put('web/node_modules/dep/index.js', 'module.exports = 1')
  return { root, put }
}

test('packs a static artifact and canonical source ZIP that pass the shared Cloud rules', async () => {
  const { root } = await project()
  try {
    await packBackend(root, 'handlers.mjs', join(root, 'backend.json'))
    const out = join(root, '.mantle-cloud')
    const first = await packFrontend({ project: root, dist: join(root, 'dist'), out, spa: true, backend: join(root, 'backend.json'), exclude: ['backend.json', 'backend.json.metafile.json'] })
    const text = await readFile(first.frontend.path, 'utf8')
    const artifact = JSON.parse(text)
    assert.deepEqual(Object.keys(artifact), ['version', 'sdkRevision', 'spa', 'assets'])
    assert.equal(artifact.sdkRevision, corePin.revision)
    assert.equal(artifact.spa, true)
    assert.deepEqual(Object.keys(artifact.assets), ['/assets/app.js', '/icon.svg', '/index.html'])
    assert.equal(artifact.assets['/icon.svg'].type, 'image/svg+xml')
    assert.equal(inspectStaticAssets(artifact.assets).bytes, 27 + 14 + 41)
    assert.equal(first.frontend.sha256, sha256(new TextEncoder().encode(text)))
    const zip = new Uint8Array(await readFile(first.source.path))
    assert.equal(first.source.sha256, sha256(zip))
    // dist, the output directory, .git and node_modules at any depth are not source.
    assert.deepEqual(Object.keys(unzipSync(zip)).sort(), ['handlers.mjs', 'manifests/site.yaml', 'package.json', 'src/main.ts'])
    assert.deepEqual(first.source.excluded, ['.git', '.mantle-cloud', 'backend.json', 'backend.json.metafile.json', 'dist', 'node_modules', 'web/node_modules'])
    assert.equal(strFromU8(unzipSync(zip)['manifests/site.yaml']), yaml)
    assert.deepEqual(inspectSourceArchive(zip, JSON.parse(await readFile(join(root, 'backend.json'), 'utf8')).sources).files.length, 4)
    const second = await packFrontend({ project: root, dist: join(root, 'dist'), out, spa: true, backend: join(root, 'backend.json'), exclude: ['backend.json', 'backend.json.metafile.json'] })
    assert.equal(second.frontend.sha256, first.frontend.sha256)
    assert.equal(second.source.sha256, first.source.sha256)
    assert.ok(second.source.excluded.includes('.mantle-cloud'))
    assert.deepEqual(first.warnings, ['kit_not_checked: pass --kit <dir> so the contract hash and Core pin come from the downloaded kit'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('reports Cloud rejections locally instead of stripping or rewriting files', async () => {
  const { root, put } = await project()
  const pack = extra => packFrontend({ project: root, dist: join(root, 'dist'), out: join(root, 'out'), ...extra })
  const rejects = async (code, extra) => { await assert.rejects(pack(extra), error => error.code === code, code) }
  try {
    await packBackend(root, 'handlers.mjs', join(root, 'backend.json'))
    await put('.env', 'TOKEN=secret')
    await put('config/server.PEM', 'secret')
    await assert.rejects(pack(), error => error.code === 'source_archive_secret_path' && error.detail === '.env, config/server.PEM')
    const packed = await pack({ exclude: ['.env', 'config/server.PEM'] })
    assert.ok(packed.source.excluded.includes('.env'))
    await rm(join(root, '.env')); await rm(join(root, 'config'), { recursive: true })
    // Wrangler local secrets are rejected at any depth and case; env templates are packed.
    await put('.dev.vars', 'TOKEN=secret')
    await put('sub/.DEV.VARS.staging', 'TOKEN=secret')
    await put('.env.local', 'TOKEN=secret')
    await put('.env.example', 'TOKEN=')
    await put('web/.env.sample', 'TOKEN=')
    await assert.rejects(pack(), error => error.code === 'source_archive_secret_path' && error.detail === '.dev.vars, .env.local, sub/.DEV.VARS.staging')
    await rm(join(root, '.dev.vars')); await rm(join(root, '.env.local')); await rm(join(root, 'sub'), { recursive: true })
    assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await readFile((await pack()).source.path)))).filter(path => path.includes('.env')).sort(),
      ['.env.example', 'web/.env.sample'])
    await rm(join(root, '.env.example')); await rm(join(root, 'web/.env.sample'))
    // Candidate YAML must match the snapshot exactly.
    await put('manifests/site.yaml', yaml + '# edited after upload\n')
    await rejects('source_manifest_mismatch', { backend: join(root, 'backend.json') })
    await put('manifests/site.yaml', yaml)
    await put('manifests/extra.yml', yaml)
    await rejects('source_manifest_mismatch', { backend: join(root, 'backend.json') })
    await rm(join(root, 'manifests/extra.yml'))
    await put('src/Main.ts', 'duplicate')
    // macOS may use a case-insensitive volume, where Main.ts overwrites main.ts.
    if ((await readdir(join(root, 'src'))).includes('Main.ts')) {
      await rejects('source_archive_duplicate_path')
      await rm(join(root, 'src/Main.ts'))
    } else await put('src/main.ts', 'console.log("app")\n')
    for (const [path, code] of [['dist/robots.txt', 'static_asset_path_invalid'], ['dist/admin/x.js', 'static_asset_path_invalid'],
      ['dist/API/x.js', 'static_asset_path_invalid'], ['dist/notes.md', 'static_asset_mime_invalid'], ['dist/.env', 'static_asset_secret_path'], ['dist/keys/site.pem', 'static_asset_secret_path']]) {
      await put(path, 'x')
      await rejects(code)
      await rm(join(root, path))
    }
    await rm(join(root, 'dist/index.html'))
    await rejects('static_assets_invalid')
    await put('dist/index.html', '<h1>App</h1>')
    await put('dist/bad.js', Buffer.from([0xff, 0xfe]))
    await rejects('static_asset_utf8_invalid')
    await rm(join(root, 'dist/bad.js'))
    await symlink(join(root, 'package.json'), join(root, 'dist/link.js'))
    await rejects('symlink_unsupported')
    await rm(join(root, 'dist/link.js'))
    await mkdir(join(root, 'kit'))
    await writeFile(join(root, 'kit/kit.json'), JSON.stringify({ candidateId: crypto.randomUUID(), contractHash: 'a'.repeat(64), coreRevision: 'f'.repeat(40) }))
    await rejects('cli_core_mismatch', { kit: join(root, 'kit') })
    const contractHash = 'b'.repeat(64), candidateId = crypto.randomUUID()
    await writeFile(join(root, 'kit/kit.json'), JSON.stringify({ candidateId, contractHash, coreRevision: corePin.revision }))
    assert.deepEqual((({ candidateId, contractHash }) => ({ candidateId, contractHash }))(await pack({ kit: join(root, 'kit'), exclude: ['kit'] })), { candidateId, contractHash })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('secret denylist covers .dev.vars and allows only the exact env template basenames', () => {
  for (const path of ['.env', '.ENV.local', 'a/.env.production', '.dev.vars', 'sub/.DEV.VARS.staging', 'k/server.Key',
    '.env.example.local', 'sub/.env.examples', 'id_RSA', 'a/credentials.json', '.netrc', 'home/.Git-Credentials', 'certs/client.P12', 'a/b.pfx',
    // A template name exempts only the file itself, never a directory.
    '.env.example/secrets.txt', 'a/.dev.vars.example/b/token'])
    assert.equal(secretSourcePath(path), true, path)
  for (const path of ['.env.example', 'app/.dev.vars.example', 'web/.ENV.Sample', 'src/env.ts', 'dev.vars.md', 'environment/x.ts'])
    assert.equal(secretSourcePath(path), false, path)
})

test('handles symlinked roots, worktree .git files, OS metadata and the backend artifact without extra flags', async () => {
  const { root, put } = await project()
  const link = root + '-link'
  try {
    await rm(join(root, '.git'), { recursive: true })
    await put('.git', 'gitdir: /elsewhere/.git/worktrees/app\n')
    await put('dist/.DS_Store', 'finder')
    await put('dist/assets/Thumbs.db', 'explorer')
    await symlink(root, link)
    await packBackend(link, 'handlers.mjs', join(link, 'backend.json'))
    const pack = () => packFrontend({ project: link, dist: join(link, 'dist'), out: join(link, 'out'), backend: join(link, 'backend.json') })
    const first = await pack()
    assert.deepEqual(first.frontend.ignored, ['/.DS_Store', '/assets/Thumbs.db'])
    assert.equal(first.frontend.assets, 3)
    // The output directory exists on the second run and is still recognized through the symlink.
    const second = await pack()
    assert.equal(second.source.sha256, first.source.sha256)
    assert.deepEqual(second.source.excluded, ['.git', 'backend.json', 'backend.json.metafile.json', 'dist', 'node_modules', 'out', 'web/node_modules'])
    assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await readFile(second.source.path)))).sort(), ['handlers.mjs', 'manifests/site.yaml', 'package.json', 'src/main.ts'])
  } finally { await rm(link, { force: true }); await rm(root, { recursive: true, force: true }) }
})

test('rejects a manifest with a UTF-8 byte-order mark instead of dropping it', async () => {
  const { root, put } = await project()
  try {
    await put('manifests/site.yaml', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(yaml)]))
    await assert.rejects(packBackend(root, 'handlers.mjs', join(root, 'backend.json')), error => error.code === 'manifest_bom' && error.detail === 'manifests/site.yaml')
    await assert.rejects(packFrontend({ project: root, dist: join(root, 'dist'), out: join(root, 'out') }), error => error.code === 'manifest_bom')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('shares the closed-module rule with Cloud', () => {
  assert.doesNotThrow(() => assertClosedModule('export const handlers = {}'))
  for (const open of ['import x from "y"; export const handlers = {}', 'export const handlers = { a: () => import("x") }', 'export * from "x"', 'const r = require("x")'])
    assert.throws(() => assertClosedModule(open), /backend_handlers_not_closed/, open)
})

test('a source ZIP cannot hide a second directory: records tile the directory, no ZIP64, no gaps', async () => {
  const sources = [{ sourceId: 'manifests/site.yaml', text: 'a: 1\n' }]
  const fixture = async name => new Uint8Array(await readFile(new URL(`fixtures/${name}`, import.meta.url)))
  // diff.zip: a gap before the EOCD holding a ZIP64 directory that Python's zipfile reads (.env and another manifest).
  for (const name of ['zip64-hidden-directory.zip', 'zip-gap.zip']) {
    const bytes = await fixture(name)
    assert.throws(() => inspectSourceArchive(bytes, sources), error => error.code === 'source_archive_invalid', name)
  }
  const zip = canonicalSourceZip({ 'manifests/site.yaml': new TextEncoder().encode('a: 1\n'), 'src/index.ts': new TextEncoder().encode('export {}\n') })
  assert.equal(inspectSourceArchive(zip, sources).files.length, 2)
  const end = zip.length - 22
  // Any bytes between the last central record and the EOCD, even with the directory size adjusted.
  const gap = new Uint8Array(zip.length + 4)
  gap.set(zip.subarray(0, end)); gap.set(zip.subarray(end), end + 4)
  new DataView(gap.buffer).setUint32(gap.length - 22 + 12, new DataView(zip.buffer).getUint32(end + 12, true) + 4, true)
  assert.throws(() => inspectSourceArchive(gap, sources), error => error.code === 'source_archive_invalid')
  // A ZIP64 locator right before the EOCD, or a ZIP64 marker value.
  const locator = zip.slice()
  new DataView(locator.buffer).setUint32(end - 20, 0x07064b50, true)
  assert.throws(() => inspectSourceArchive(locator, sources), error => ['source_archive_invalid', 'source_archive_path_invalid'].includes(error.code))
  // DEL is a control character for archive paths as for omitted paths.
  const del = canonicalSourceZip({ 'manifests/site.yaml': new TextEncoder().encode('a: 1\n'), 'src/a\u007fb.ts': new Uint8Array(1) })
  assert.throws(() => inspectSourceArchive(del, sources), error => error.code === 'source_archive_path_invalid')
})
