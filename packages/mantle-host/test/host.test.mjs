import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { chmod, utimes, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate'
import { buildHost } from '../scripts/build-host.mjs'
import { inspectSourceArchive, omittablePath } from '../src/source-zip.mjs'
import { headTsconfig, parseJsonc } from '../src/host/backend.mjs'
import { hostProtocol } from '../src/protocol.mjs'
import { addEsbuild, baseFiles, corePin, fakeCloud, git, link, project, projectId, runner, sha, writeDist, writeFiles, yaml } from './host-fixture.mjs'

const scratch = await mkdtemp(join(tmpdir(), 'mantle-host-bundle-'))
let bundle
before(async () => { bundle = (await buildHost(scratch)).path })
after(() => rm(scratch, { recursive: true, force: true }))

const last = result => result.lines.at(-1)
const envelope = value => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: value }) }] })
const noSecrets = (cloud, ...texts) => { for (const secret of cloud.secrets()) for (const text of texts) assert.ok(!text.includes(secret), 'a grant value was printed') }

test('the bundle build is deterministic, self-contained and resolves esbuild only at runtime', async () => {
  const again = await mkdtemp(join(tmpdir(), 'mantle-host-bundle-'))
  try {
    const [first, second] = [await buildHost(scratch), await buildHost(again)]
    assert.equal(first.sha256, second.sha256)
    const text = await readFile(first.path, 'utf8')
    assert.equal(sha(Buffer.from(text)), first.sha256)
    assert.equal(await readFile(join(scratch, 'mantle-host.mjs.sha256'), 'utf8'), `${first.sha256}  mantle-host.mjs\n`)
    assert.doesNotMatch(text, /from ["']esbuild["']|from ["'](?:fflate|es-module-lexer)/)
    assert.ok(!text.includes(process.cwd()) && !text.includes(tmpdir()), 'no absolute build paths')
  } finally { await rm(again, { recursive: true, force: true }) }
})

test('a bare --help prints the usage and exits 0; an unknown verb exits 2', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mantle-host-help-'))
  try {
    for (const run of [runner(null), runner(bundle)]) {
      for (const args of [['--help'], ['save', '--help'], []]) {
        const result = await run(root, args)
        assert.equal(result.code, 0, `${args.join(' ')}: ${result.text}`)
        assert.match(result.text, /^mantle-host <command>/)
      }
      const unknown = await run(root, ['publish'])
      assert.equal(unknown.code, 2)
      assert.match(unknown.text, /^mantle-host <command>/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const mode of ['sources', 'bundle']) test(`Cloud supplies the Core pin before backend hashing (${mode})`, async () => {
  const run = runner(mode === 'bundle' ? bundle : null, { autoContract: false })
  const root = await project()
  const resume = value => run(root, ['save', '--resume', '--grant', '-', '--json'], { stdin: JSON.stringify(value) })
  try {
    const first = await run(root, ['save', '--json'])
    assert.equal(first.code, 0, first.text)
    assert.equal(last(first).nextAction.tool, 'cloud_host_contract')
    assert.deepEqual(last(first).nextAction.arguments, { projectId })
    assert.equal(last(await run(root, ['status', '--json'])).nextAction.tool, 'cloud_host_contract')
    const contract = { projectId, core: corePin, protocol: { current: 2, minimum: 2 } }
    assert.equal(last(await resume({ ...contract, projectId: '0199aaaa-0000-7000-8000-000000000009' })).error, 'grant_project_mismatch')
    const invalidPin = last(await resume({ ...contract, core: { version: corePin.version, revision: 'bad' } }))
    assert.equal(invalidPin.error, 'core_pin_invalid')
    assert.equal(invalidPin.nextAction.tool, 'cloud_host_contract')
    assert.equal(last(await resume({ ...contract, core: { version: [corePin.version], revision: [corePin.revision] } })).error, 'core_pin_invalid')
    assert.equal(last(await resume({ ...contract, protocol: { current: 3, minimum: 3 } })).error, 'client_outdated')
    assert.equal(last(await resume({ ...contract, protocol: { current: 3, minimum: 3 }, core: { version: 'future-format' } })).error, 'client_outdated')
    const built = await resume(contract)
    assert.equal(built.code, 0, built.text)
    assert.equal(last(built).nextAction.tool, 'cloud_backend_upload')
    const artifact = JSON.parse(await readFile(join(root, '.mantle/host/out/production/backend.json'), 'utf8'))
    assert.equal(artifact.sdkVersion, corePin.version)
    assert.equal(artifact.sdkRevision, corePin.revision)
    const statePath = join(root, '.mantle/host/state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    delete state.targets.production.pending.core
    await writeFile(statePath, JSON.stringify(state))
    assert.match(last(await run(root, ['status', '--json'])).nextAction.command, /--restart/)
    const old = last(await resume({}))
    assert.equal(old.error, 'cli_core_mismatch')
    assert.match(old.nextAction.command, /--restart/)
    state.targets.production.pending.core = corePin
    await writeFile(statePath, JSON.stringify(state))
    const cloud = await fakeCloud()
    try {
      const grant = cloud.mcp.backendUpload({ ...last(built).nextAction.arguments, expectedVersion: 1 })
      assert.equal(last(await resume({ ...grant, core: { ...corePin, revision: 'b'.repeat(40) } })).error, 'cli_core_mismatch')
      assert.equal(cloud.seen.length, 0, 'a changed pin is refused before upload')
    } finally { await cloud.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const mode of ['sources', 'bundle']) describe(`save flow (${mode})`, () => {
  test('reaches a paired saved version with two Cloud MCP calls, resuming after an interruption', async () => {
    const run = runner(mode === 'bundle' ? bundle : null)
    const root = await project(), cloud = await fakeCloud()
    const script = mode === 'bundle' ? realpathSync(bundle) : '/opt/mantle plugin/mantle-host.mjs'
    const node = `node '${script}'`.replace(/^node '([A-Za-z0-9@%+=:,./_-]+)'$/, 'node $1')
    const printed = []
    const go = async (args, options) => { const result = await run(root, [...args, '--json'], options); printed.push(result.text); return result }
    try {
      const first = await go(['save'])
      assert.equal(first.code, 0, first.text)
      assert.deepEqual(first.lines.map(line => `${line.stage}:${line.state}`), ['preflight:clean', 'backend:built'])
      const commit = git(root, 'rev-parse', 'HEAD').trim()
      const backend = last(first)
      assert.equal(backend.commit, commit)
      assert.deepEqual(Object.keys(backend.nextAction), ['kind', 'tool', 'arguments', 'requires', 'command', 'confirm', 'reason'])
      assert.deepEqual(backend.nextAction.arguments, { projectId, operationId: backend.nextAction.arguments.operationId, contentHash: backend.verified.contentHash })
      assert.deepEqual(backend.nextAction.requires, [{ argument: 'expectedVersion', tool: 'query_view_member_project', arguments: { projectId }, field: 'version' }])
      assert.equal(backend.nextAction.command, `${node} save --target production --resume --grant - --json`)
      assert.deepEqual(backend.nextAction.confirm, [{ tool: 'query_view_member_organization', arguments: { organizationId: '0199aaaa-0000-7000-8000-000000000001' }, field: 'name' },
        { tool: 'query_view_member_project', arguments: { projectId }, field: 'name' }])
      // status repeats the same literal call while the backend upload is pending.
      assert.deepEqual(last(await go(['status'])).nextAction, backend.nextAction)
      // The operationId is persisted before it is printed, and a re-run reuses it.
      const state = JSON.parse(await readFile(join(root, '.mantle/host/state.json'), 'utf8'))
      assert.equal(state.targets.production.pending.backend.operationId, backend.nextAction.arguments.operationId)
      assert.equal(last(await go(['save'])).nextAction.arguments.operationId, backend.nextAction.arguments.operationId)
      const backendBytes = await readFile(join(root, '.mantle/host/out/production/backend.json'))
      assert.equal(sha(backendBytes), backend.verified.contentHash)

      // Cloud MCP call 1; the first PUT is cut off, the resume with the same grant succeeds.
      const grant = cloud.mcp.backendUpload({ ...backend.nextAction.arguments, expectedVersion: 1 })
      // A dropped PUT is retried in the same run; a dropped kit download interrupts it.
      cloud.hooks.drop.add('PUT /api/cloud/backend-uploads').add('GET /api/cloud/frontend-kits')
      const cut = await go(['save', '--resume', '--grant', '-'], { stdin: JSON.stringify(envelope(grant)) })
      assert.equal(cloud.seen.filter(request => request.method === 'PUT').length, 2)
      assert.equal(cut.code, 1)
      assert.equal(last(cut).error, 'cloud_unreachable')
      assert.equal(last(cut).nextAction.kind, 'wait')
      assert.equal(last(cut).nextAction.command, backend.nextAction.command)
      const ready = await go(['save', '--resume', '--grant', '-'], { stdin: JSON.stringify(envelope(grant)) })
      assert.equal(ready.code, 0, ready.text)
      assert.deepEqual(ready.lines.map(line => `${line.stage}:${line.state}`), ['backend:uploaded', 'kit:ready'])
      assert.equal(JSON.parse(await readFile(join(root, '.mantle/host/state.json'), 'utf8')).targets.production.pending.backend.operationId, backend.nextAction.arguments.operationId)
      assert.equal(cloud.candidates.size, 1)
      assert.deepEqual([...cloud.candidates.values()][0].bytes, backendBytes)
      assert.deepEqual((await readdir(join(root, '.mantle/host/out/production/kit'))).sort(), ['AGENT.md', 'frontend-contract.json', 'kit.json', 'mantle-client.ts', 'openapi.json'])
      assert.equal(last(ready).nextAction.kind, 'build')
      assert.match(last(ready).nextAction.reason, /AGENT\.md/)
      // Every Cloud request carries the protocol and client headers.
      for (const request of cloud.seen) assert.equal(request.headers['x-mantle-host-protocol'], String(hostProtocol.current))
      assert.match(cloud.seen[0].headers['x-mantle-host-client'], /^mantle-host\/\S+ sha256=(?:[a-f0-9]{64}|unknown)$/)

      const unbuilt = await go(['save', '--resume'])
      assert.equal(last(unbuilt).error, 'dist_missing')
      assert.equal(last(unbuilt).nextAction.kind, 'build')
      await writeDist(root)
      const built = await go(['save', '--resume'])
      assert.equal(built.code, 0, built.text)
      const reserve = last(built).nextAction
      assert.equal(reserve.tool, 'cloud_static_frontend_upload')
      assert.deepEqual(Object.keys(reserve.arguments), ['projectId', 'candidateId', 'operationId', 'contractHash', 'contentHash', 'sourceHash', 'sourceRef'])
      assert.deepEqual(reserve.arguments.sourceRef, { commit })
      const zip = new Uint8Array(await readFile(join(root, '.mantle/host/out/production/source.zip')))
      assert.equal(sha(zip), reserve.arguments.sourceHash)
      assert.deepEqual(Object.keys(unzipSync(zip)).sort(), ['.gitignore', '.mantle/hosting.json', 'README.md', 'handlers/index.ts', 'handlers/lib.ts', 'manifests/site.yaml', 'package.json', 'src/main.ts'])
      inspectSourceArchive(zip, JSON.parse(backendBytes).sources)
      assert.deepEqual(last(await go(['status'])).nextAction, reserve)

      // Cloud MCP call 2, handed over as a BOM-prefixed grant file (Windows PowerShell).
      const staticGrant = cloud.mcp.staticUpload({ ...reserve.arguments, expectedVersion: 1 })
      const otherProject = await go(['save', '--resume', '--grant', '-'], { stdin: JSON.stringify({ ...staticGrant, projectId: '0199aaaa-0000-7000-8000-000000000009' }) })
      assert.equal(last(otherProject).error, 'grant_project_mismatch')
      assert.equal(cloud.statics.get(reserve.arguments.operationId).bytes.frontend, undefined)
      await writeFile(join(root, '.mantle/host/grant.json'), '﻿' + JSON.stringify(staticGrant))
      const saved = await go(['save', '--resume', '--grant-file', '.mantle/host/grant.json'])
      assert.equal(saved.code, 0, saved.text)
      const done = last(saved)
      assert.deepEqual({ stage: done.stage, state: done.state, commit: done.commit }, { stage: 'saved', state: 'paired', commit })
      assert.equal(done.versionId, `${reserve.arguments.candidateId}.${reserve.arguments.operationId}`)
      assert.equal(done.nextAction.tool, 'cloud_paired_review')
      assert.match(done.nextAction.command, /deploy \S+ --target production --review - --json$/)
      const row = cloud.statics.get(reserve.arguments.operationId)
      assert.equal(sha(row.bytes.frontend), reserve.arguments.contentHash)
      assert.deepEqual(new Uint8Array(row.bytes.source), zip)

      const status = await go(['status'])
      assert.equal(last(status).state, 'saved')
      assert.deepEqual(last(status).nextAction.arguments, { projectId, staticUploadId: reserve.arguments.operationId })
      noSecrets(cloud, ...printed, await readFile(join(root, '.mantle/host/state.json'), 'utf8'))
    } finally { await cloud.close(); await rm(root, { recursive: true, force: true }) }
  })
})

/** Runs save up to the static reservation against `cloud`; returns the packed bytes. */
async function saveToStatic(run, root, cloud) {
  const first = await run(root, ['save', '--json'])
  assert.equal(first.code, 0, first.text)
  const grant = cloud.mcp.backendUpload({ ...last(first).nextAction.arguments, expectedVersion: 1 })
  const ready = await run(root, ['save', '--resume', '--grant', '-', '--json'], { stdin: JSON.stringify(grant) })
  assert.equal(ready.code, 0, ready.text)
  await writeDist(root)
  const built = await run(root, ['save', '--resume', '--json'])
  assert.equal(built.code, 0, built.text)
  const out = join(root, '.mantle/host/out/production')
  return { backend: await readFile(join(out, 'backend.json')), zip: new Uint8Array(await readFile(join(out, 'source.zip'))), reserve: last(built).nextAction }
}

for (const mode of ['sources', 'bundle']) test(`CRLF checkouts pack the same backend and source bytes as LF checkouts (${mode})`, async () => {
  const lf = await project({ ...baseFiles(), 'src/multi.txt': 'a\nb\nc\n' })
  const crlf = await mkdtemp(join(tmpdir(), 'mantle-host-crlf-'))
  const run = runner(mode === 'bundle' ? bundle : null), cloud = await fakeCloud()
  try {
    git(crlf, '-c', 'core.autocrlf=true', 'clone', '-q', lf, 'app')
    const clone = join(crlf, 'app')
    await addEsbuild(clone)
    assert.match(await readFile(join(clone, 'manifests/site.yaml'), 'utf8'), /\r\n/)
    const [plain, converted] = [await saveToStatic(run, lf, cloud), await saveToStatic(run, clone, cloud)]
    assert.deepEqual(plain.backend, converted.backend)
    assert.deepEqual(plain.zip, converted.zip)
    assert.equal(plain.reserve.arguments.sourceHash, converted.reserve.arguments.sourceHash)
    assert.equal(strFromU8(unzipSync(converted.zip)['manifests/site.yaml']), yaml)
  } finally { await cloud.close(); await rm(lf, { recursive: true, force: true }); await rm(crlf, { recursive: true, force: true }) }
})

for (const mode of ['sources', 'bundle']) describe(`refusals (${mode})`, () => {
  const run = runner(mode === 'bundle' ? bundle : null)
  const refuse = async (root, args, code, options) => {
    const result = await run(root, [...args, '--json'], options)
    assert.equal(result.code === 0 ? 'passed' : last(result).error, code, result.text)
    return last(result)
  }

  test('dirty trees: modified, staged and untracked files; no --allow-dirty', async () => {
    const root = await project()
    try {
      await writeFile(join(root, 'src/main.ts'), 'changed\n')
      const dirty = await refuse(root, ['save'], 'worktree_dirty')
      assert.equal(dirty.detail, 'src/main.ts')
      assert.equal(dirty.nextAction.kind, 'fix')
      git(root, 'checkout', '--', 'src/main.ts')
      await writeFile(join(root, 'notes.txt'), 'untracked\n')
      assert.equal((await refuse(root, ['save'], 'worktree_dirty')).detail, 'notes.txt')
      assert.equal((await refuse(root, ['save', '--allow-dirty'], 'usage')).detail, 'unknown or invalid option')
      await rm(join(root, 'notes.txt'))
      // Ignored files are not dirty and never uploaded.
      await writeFile(join(root, '.dev.vars'), 'TOKEN=local')
      assert.equal((await run(root, ['save', '--json'])).code, 0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('submodules and tracked symlinks; a submodule\'s own filter never runs', async () => {
    const root = await project()
    const marker = join(tmpdir(), `mantle-host-submodule-filter-${process.pid}-${Date.now()}`)
    try {
      const lib = await project({ 'lib.ts': 'export {}\n', '.gitattributes': '* filter=sm\n' })
      git(root, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', lib, 'vendor/lib')
      git(root, 'commit', '-q', '-m', 'submodule')
      // The reviewer's super/ case: the filter lives in .git/modules/<name>/config, not the superproject's.
      git(join(root, 'vendor/lib'), 'config', 'filter.sm.clean', `sh -c 'touch ${marker}; cat'`)
      const later = new Date(Date.now() + 60_000)
      await utimes(join(root, 'vendor/lib/lib.ts'), later, later)
      assert.equal((await refuse(root, ['save'], 'submodule_unsupported')).detail, 'vendor/lib')
      assert.equal(existsSync(marker), false, 'the submodule filter ran')
      git(root, 'rm', '-q', '-r', '--cached', 'vendor/lib', '.gitmodules'); await rm(join(root, 'vendor'), { recursive: true }); await rm(join(root, '.gitmodules'))
      git(root, 'commit', '-q', '-m', 'drop')
      await rm(lib, { recursive: true, force: true })
      await symlink('/etc/passwd', join(root, 'src/passwd'))
      git(root, 'add', 'src/passwd'); git(root, 'commit', '-q', '-m', 'link')
      assert.equal((await refuse(root, ['save'], 'symlink_unsupported')).detail, 'src/passwd')
    } finally { await rm(marker, { force: true }); await rm(root, { recursive: true, force: true }) }
  })

  test('committed .env and .dev.vars are rejected, never stripped; --omit is explicit and recorded', async () => {
    const root = await project({ ...baseFiles(), '.gitignore': 'node_modules\n.mantle/host/\n', '.env': 'TOKEN=secret', 'config/.dev.vars': 'TOKEN=secret', '.env.example': 'TOKEN=' })
    try {
      const secret = await refuse(root, ['save'], 'source_archive_secret_path')
      assert.equal(secret.detail, '.env, config/.dev.vars')
      assert.match(secret.nextAction.reason, /by name.*not by content/)
      assert.match(secret.nextAction.reason, /--omit/)
      assert.equal((await refuse(root, ['save', '--omit', 'nope'], 'omit_unmatched')).detail, 'nope')
      assert.equal((await refuse(root, ['save', '--omit', '../x'], 'omit_invalid')).error, 'omit_invalid')
      const omitted = await run(root, ['save', '--omit', '.env', '--omit', './config/', '--json'])
      assert.equal(omitted.code, 0, omitted.text)
      assert.deepEqual(JSON.parse(await readFile(join(root, '.mantle/host/state.json'), 'utf8')).targets.production.pending.omitted, ['.env', 'config'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('--no-git reads the working tree with the same secret rules and saves unversioned', async () => {
    const root = await project({ ...baseFiles(), '.gitignore': 'node_modules\n' }, { commit: false })
    try {
      await writeFile(join(root, '.dev.vars'), 'TOKEN=secret')
      assert.equal((await refuse(root, ['save', '--no-git'], 'source_archive_secret_path')).detail, '.dev.vars')
      await rm(join(root, '.dev.vars'))
      assert.equal((await refuse(root, ['save'], 'git_head_missing')).nextAction.kind, 'fix')
      const saved = await run(root, ['save', '--no-git', '--json'])
      assert.equal(saved.code, 0, saved.text)
      assert.equal(last(saved).commit, 'unversioned')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('hostile link files: endpoint and origin keys, secret-shaped keys, token values, unknown keys, escaping roots', async () => {
    const cases = [
      [{ origin: 'https://evil.example' }, '/targets/production/origin: unknown key (the link file has no endpoint, origin or credential settings)'],
      [{ endpoint: 'https://evil.example' }, '/targets/production/endpoint: unknown key (the link file has no endpoint, origin or credential settings)'],
      [{ apiToken: 'x' }, '/targets/production/apiToken: secret-shaped key; the link file never holds credentials'],
      [{ frontend: { build: 'curl -H "Authorization: Bearer abc" x' } }, '/targets/production/frontend/build: token-shaped value; the link file never holds credentials'],
      [{ frontend: { build: 'deploy aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z' } }, '/targets/production/frontend/build: token-shaped value; the link file never holds credentials'],
      [{ region: 'eu' }, '/targets/production/region: unknown key (the link file has no endpoint, origin or credential settings)'],
      [{ root: '../elsewhere' }, '/targets/production/root: invalid value'],
      [{ root: '/etc' }, '/targets/production/root: invalid value'],
      [{ slug: 'Bad_Slug' }, '/targets/production/slug: invalid value'],
    ]
    for (const [extra, detail] of cases) {
      const root = await project({ ...baseFiles(), '.mantle/hosting.json': link(extra) })
      try { assert.equal((await refuse(root, ['save'], 'link_file_invalid')).detail, detail) }
      finally { await rm(root, { recursive: true, force: true }) }
    }
    const root = await project({ ...baseFiles(), '.mantle/hosting.json': link({ root: 'app' }) })
    const outside = await mkdtemp(join(tmpdir(), 'mantle-host-outside-'))
    try {
      await symlink(outside, join(root, 'app'))
      assert.equal((await refuse(root, ['save'], 'link_root_outside_project')).error, 'link_root_outside_project')
      await rm(join(root, 'app'))
      // A committed .mantle/host symlink cannot redirect state writes.
      await rm(join(root, '.mantle/hosting.json'))
      await writeFiles(root, { '.mantle/hosting.json': link() })
      await symlink(outside, join(root, '.mantle/host'))
      await refuse(root, ['save'], 'host_path_unsafe')
      assert.deepEqual(await readdir(outside), [])
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
  })

  test('handler inputs must be committed; esbuild must come from the project', async () => {
    const root = await project({ ...baseFiles(), '.gitignore': 'node_modules\ndist\n.mantle/host/\nhandlers/gen.ts\n',
      'handlers/index.ts': 'import { value } from "./gen"\nexport const handlers = { ping: () => value }\n' })
    try {
      await writeFile(join(root, 'handlers/gen.ts'), 'export const value = "generated"\n')
      assert.equal((await refuse(root, ['save'], 'handler_input_untracked')).detail, 'handlers/gen.ts')
    } finally { await rm(root, { recursive: true, force: true }) }
    // A fresh project path: in-process resolution would otherwise be cached.
    const bare = await project()
    try {
      await rm(join(bare, 'node_modules'), { recursive: true })
      const missing = await refuse(bare, ['save'], 'esbuild_missing')
      assert.match(missing.nextAction.reason, /devDependency/)
    } finally { await rm(bare, { recursive: true, force: true }) }
  })

  test('stale protocol, grant projects, inline grants and grant printing', async () => {
    const root = await project(), cloud = await fakeCloud()
    const printed = []
    const go = async (args, options) => { const result = await run(root, [...args, '--json'], options); printed.push(result.text); return result }
    try {
      const reserve = last(await go(['save'])).nextAction
      const grant = cloud.mcp.backendUpload({ ...reserve.arguments, expectedVersion: 1 })
      // A grant for another project is refused before any byte is sent.
      const other = await go(['save', '--resume', '--grant', '-'], { stdin: JSON.stringify({ ...grant, projectId: '0199aaaa-0000-7000-8000-000000000009' }) })
      assert.equal(last(other).error, 'grant_project_mismatch')
      // A result of the wrong tool is refused, and the reservation is printed again unchanged.
      const wrong = await go(['save', '--resume', '--grant', '-'], { stdin: JSON.stringify({ ...grant, staticUploadId: grant.candidateId }) })
      assert.equal(last(wrong).error, 'grant_invalid')
      assert.deepEqual(last(wrong).nextAction.arguments, reserve.arguments)
      // Inline grants are refused without echoing them.
      const inline = await go(['save', '--resume', '--grant', JSON.stringify(grant)])
      assert.equal(last(inline).error, 'grant_inline_refused')
      const inlineEquals = await go(['save', '--resume', `--grant=${JSON.stringify(grant)}`])
      assert.equal(last(inlineEquals).error, 'grant_inline_refused')
      assert.equal(cloud.seen.length, 0)
      // A grant that already requires a newer protocol fails closed.
      const future = await go(['save', '--resume', '--grant', '-'], { stdin: JSON.stringify({ ...grant, protocol: { current: 3, minimum: 3 } }) })
      assert.equal(last(future).error, 'client_outdated')
      assert.match(last(future).nextAction.reason, /Update the mantle plugin, or re-run `npx skills add aotter\/mantle --skill mantle-host`\./)
      cloud.hooks.outdated = true
      const stale = await go(['save', '--resume'], { env: { MANTLE_CLOUD_GRANT: JSON.stringify(grant) } })
      assert.equal(last(stale).error, 'client_outdated')
      assert.equal(cloud.seen.at(-1).headers['x-mantle-host-protocol'], '2')
      cloud.hooks.outdated = false
      // A rejected hash says so without printing the grant.
      const mismatch = await go(['save', '--resume', '--grant', '-'], { stdin: JSON.stringify({ ...grant, contentHash: 'd'.repeat(64) }) })
      assert.equal(last(mismatch).error, 'local_hash_mismatch')
      noSecrets(cloud, ...printed)
      for (const text of printed) assert.doesNotMatch(text, /Bearer [A-Za-z0-9]|SECRETTOKEN|KITSECRET/)
    } finally { await cloud.close(); await rm(root, { recursive: true, force: true }) }
  })

  test('.mantle/host is never dirt and never committed', async () => {
    // No ignore line for .mantle/host/: save still does not see its own state as a change.
    const root = await project({ ...baseFiles(), '.gitignore': 'node_modules\ndist\n' })
    try {
      assert.equal((await run(root, ['save', '--json'])).code, 0)
      const again = await run(root, ['save', '--json'])
      assert.equal(again.code, 0, again.text)
      git(root, 'add', '-f', '.mantle/host/state.json'); git(root, 'commit', '-q', '-m', 'oops')
      const tracked = await refuse(root, ['save'], 'host_state_tracked')
      assert.equal(tracked.detail, '.mantle/host/state.json')
      assert.match(tracked.nextAction.reason, /git rm -r --cached \.mantle\/host/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('git comes from PATH outside the project, never from the project itself', async () => {
    const root = await project({ ...baseFiles(), git: '#!/bin/sh\ntouch "$(dirname "$0")/hijacked"\nexit 1\n' })
    try {
      await chmod(join(root, 'git'), 0o755)
      git(root, 'add', 'git'); git(root, 'commit', '-q', '-m', 'git')
      const path = `${root}${delimiter}${process.env.PATH}`, saved = process.env.PATH
      process.env.PATH = path
      let result
      try { result = await run(root, ['save', '--json'], { env: { PATH: path } }) } finally { process.env.PATH = saved }
      assert.equal(result.code, 0, result.text)
      assert.equal(existsSync(join(root, 'hijacked')), false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('the handler bundle is a function of HEAD: tsconfig from HEAD, committed node_modules files from their blobs', async () => {
    // The reviewer's alias case: an ignored tsconfig must not redirect an import.
    const alias = await project({ ...baseFiles(), '.gitignore': 'node_modules\ndist\n.mantle/host/\ntsconfig.json\n',
      'handlers/index.ts': 'import { pong } from "alias"\nexport const handlers = { ping: () => pong }\n', 'handlers/alt.ts': 'export const pong = "EVIL-ALT"\n' })
    try {
      await writeFile(join(alias, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { alias: ['handlers/alt.ts'] } } }))
      assert.equal((await refuse(alias, ['save'], 'handler_config_untracked')).detail, 'tsconfig.json')
      // Committed, the same alias is HEAD's and resolves.
      git(alias, 'add', '-f', 'tsconfig.json'); await writeFile(join(alias, '.gitignore'), 'node_modules\ndist\n.mantle/host/\n'); git(alias, 'commit', '-qam', 'tsconfig')
      assert.equal((await run(alias, ['save', '--json'])).code, 0)
      assert.match(await readFile(join(alias, '.mantle/host/out/production/backend.json'), 'utf8'), /EVIL-ALT/)
      // An untracked package.json on the way up changes resolution too.
      await writeFile(join(alias, 'handlers/package.json'), '{"imports":{"#x":"./alt.ts"}}')
      await writeFile(join(alias, '.gitignore'), 'node_modules\ndist\n.mantle/host/\nhandlers/package.json\n'); git(alias, 'commit', '-qam', 'ignore')
      assert.equal((await refuse(alias, ['save'], 'handler_config_untracked')).detail, 'handlers/package.json')
    } finally { await rm(alias, { recursive: true, force: true }) }
    // A committed file under node_modules is served from HEAD even when the disk says otherwise.
    const vendored = await project({ ...baseFiles(), 'handlers/index.ts': 'import { pong } from "./node_modules/dep/index.js"\nexport const handlers = { ping: () => pong }\n' })
    try {
      await writeFiles(vendored, { 'handlers/node_modules/dep/index.js': 'export const pong = "FROM-HEAD"\n' })
      git(vendored, 'add', '-f', 'handlers/node_modules/dep/index.js'); git(vendored, 'commit', '-q', '-m', 'vendor')
      git(vendored, 'update-index', '--assume-unchanged', 'handlers/node_modules/dep/index.js')
      await writeFile(join(vendored, 'handlers/node_modules/dep/index.js'), 'export const pong = "FROM-DISK"\n')
      assert.equal((await run(vendored, ['save', '--json'])).code, 0)
      const handlers = JSON.parse(await readFile(join(vendored, '.mantle/host/out/production/backend.json'), 'utf8')).handlers
      assert.match(handlers, /FROM-HEAD/)
      assert.doesNotMatch(handlers, /FROM-DISK/)
    } finally { await rm(vendored, { recursive: true, force: true }) }
    // A project that itself lives under a node_modules directory is still read from HEAD.
    const outer = await mkdtemp(join(tmpdir(), 'mantle-host-outer-'))
    try {
      await mkdir(join(outer, 'node_modules'))
      const nested = await project({ ...baseFiles(), '.gitignore': 'node_modules\ndist\n.mantle/host/\nhandlers/gen.ts\n',
        'handlers/index.ts': 'import { value } from "./gen"\nexport const handlers = { ping: () => value }\n' }, { parent: join(outer, 'node_modules') })
      await writeFile(join(nested, 'handlers/gen.ts'), 'export const value = "generated"\n')
      assert.equal((await refuse(nested, ['save'], 'handler_input_untracked')).detail, 'handlers/gen.ts')
    } finally { await rm(outer, { recursive: true, force: true }) }
  })

  test('paths an archive cannot hold can be omitted with the rule Cloud applies; non-UTF-8 paths are refused', async () => {
    const root = await project({ ...baseFiles(), 'docs/C#/x.md': 'notes\n' })
    try {
      assert.match((await refuse(root, ['save'], 'source_archive_path_invalid')).detail, /^docs\/C#\/x\.md: /)
      const omitted = await run(root, ['save', '--omit', 'docs/C#/x.md', '--json'])
      assert.equal(omitted.code, 0, omitted.text)
      assert.deepEqual(JSON.parse(await readFile(join(root, '.mantle/host/state.json'), 'utf8')).targets.production.pending.omitted, ['docs/C#/x.md'])
      assert.equal(omittablePath('docs/C#/x.md'), true)
      for (const bad of ['../x', '/x', 'a\\b', 'a//b', 'a\u0000b', 'a'.repeat(301)]) assert.equal(omittablePath(bad), false, bad)
    } finally { await rm(root, { recursive: true, force: true }) }
    if (process.platform !== 'darwin') {
      const raw = await project()
      try {
        writeFileSync(Buffer.concat([Buffer.from(join(raw, 'src') + '/'), Buffer.from([0x66, 0xff, 0x2e, 0x74, 0x73])]), 'x')
        git(raw, 'add', '-A'); git(raw, 'commit', '-q', '-m', 'latin1')
        await refuse(raw, ['save'], 'source_path_not_utf8')
      } finally { await rm(raw, { recursive: true, force: true }) }
    }
  })

  test('the dist directory: secret files rejected, never inside .git, .mantle or node_modules', async () => {
    const cloud = await fakeCloud()
    const root = await project({ ...baseFiles(), '.gitignore': 'node_modules\nout\n.mantle/host/\n', '.mantle/hosting.json': link({ frontend: { dist: 'out' } }) })
    try {
      assert.equal((await refuse(root, ['link', '--dist', '.git'], 'link_file_invalid')).detail, '/targets/production/frontend/dist: invalid value')
      const first = await run(root, ['save', '--json'])
      const grant = cloud.mcp.backendUpload({ ...last(first).nextAction.arguments, expectedVersion: 1 })
      assert.equal((await run(root, ['save', '--resume', '--grant', '-', '--json'], { stdin: JSON.stringify(grant) })).code, 0)
      await writeFile(join(root, '.git/index.html'), '<!doctype html>')
      await symlink(join(root, '.git'), join(root, 'out'))
      assert.equal((await refuse(root, ['save', '--resume'], 'dist_path_unsafe')).detail, 'out')
      await rm(join(root, 'out'))
      await writeDist(root, 'out')
      await writeFile(join(root, 'out/.env'), 'TOKEN=secret')
      assert.equal((await refuse(root, ['save', '--resume'], 'static_asset_secret_path')).detail, '.env')
      await rm(join(root, 'out/.env'))
      await writeFiles(root, { 'out/vendor/node_modules/x.js': 'x' })
      assert.equal((await refuse(root, ['save', '--resume'], 'dist_path_unsafe')).detail, 'vendor/node_modules')
      await rm(join(root, 'out/vendor'), { recursive: true })
      assert.equal((await run(root, ['save', '--resume', '--json'])).code, 0)
    } finally { await cloud.close(); await rm(root, { recursive: true, force: true }) }
  })

  test('--no-git rechecks the handler inputs before the static upload', async () => {
    const cloud = await fakeCloud()
    const root = await project({ ...baseFiles(), '.gitignore': 'node_modules\n' }, { commit: false })
    try {
      const first = await run(root, ['save', '--no-git', '--json'])
      const grant = cloud.mcp.backendUpload({ ...last(first).nextAction.arguments, expectedVersion: 1 })
      assert.equal((await run(root, ['save', '--resume', '--grant', '-', '--json'], { stdin: JSON.stringify(grant) })).code, 0)
      await writeDist(root)
      await writeFile(join(root, 'handlers/lib.ts'), 'export const pong: string = "changed"\n')
      assert.equal((await refuse(root, ['save', '--resume'], 'local_hash_mismatch')).nextAction.command.includes('--restart'), true)
    } finally { await cloud.close(); await rm(root, { recursive: true, force: true }) }
  })

  test('a frontend-only commit before the static stage resumes at the new HEAD; a manifest change does not', async () => {
    const cloud = await fakeCloud(), root = await project()
    try {
      const first = await run(root, ['save', '--json'])
      const grant = cloud.mcp.backendUpload({ ...last(first).nextAction.arguments, expectedVersion: 1 })
      assert.equal((await run(root, ['save', '--resume', '--grant', '-', '--json'], { stdin: JSON.stringify(grant) })).code, 0)
      await writeDist(root)
      await writeFile(join(root, 'src/page.txt'), 'frontend\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'frontend')
      const head = git(root, 'rev-parse', 'HEAD').trim()
      const built = await run(root, ['save', '--resume', '--json'])
      assert.equal(built.code, 0, built.text)
      assert.equal(last(built).commit, head)
      assert.equal(new TextDecoder().decode(new Uint8Array(await readFile(join(root, '.mantle/host/out/production/source.zip')))).includes('page.txt'), true)
      await writeFile(join(root, 'manifests/site.yaml'), `${await readFile(join(root, 'manifests/site.yaml'), 'utf8')}# changed\n`)
      git(root, 'commit', '-qam', 'manifest')
      const state = JSON.parse(await readFile(join(root, '.mantle/host/state.json'), 'utf8'))
      state.targets.production.pending.stage = 'build'
      await writeFile(join(root, '.mantle/host/state.json'), JSON.stringify(state))
      assert.equal((await refuse(root, ['save', '--resume'], 'head_changed')).nextAction.command.includes('--restart'), true)
    } finally { await cloud.close(); await rm(root, { recursive: true, force: true }) }
  })

  test('--grant-file is bounded and must be a regular file', async () => {
    const root = await project()
    try {
      assert.equal((await run(root, ['save', '--json'])).code, 0)
      await writeFile(join(root, '.mantle/host/big.json'), Buffer.alloc(8_000_001, 32))
      await refuse(root, ['save', '--resume', '--grant-file', '.mantle/host/big.json'], 'input_too_large')
      await refuse(root, ['save', '--resume', '--grant-file', '.mantle'], 'grant_file_unreadable')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('repository filter drivers never run, even on files git must re-read', async () => {
    const marker = join(tmpdir(), `mantle-host-filter-${process.pid}-${Date.now()}`)
    const root = await project({ ...baseFiles(), '.gitattributes': '* filter=evil\n*.md filter=a.b\n' })
    try {
      // Configured after the commit, as a hostile repository config would be.
      const command = `sh -c 'touch ${marker}; cat'`
      git(root, 'config', 'filter.evil.clean', command); git(root, 'config', 'filter.evil.process', command)
      git(root, 'config', 'filter.a.b.clean', command); git(root, 'config', 'filter.evil.required', 'true')
      const later = new Date(Date.now() + 60_000)
      for (const file of ['README.md', 'src/main.ts', 'manifests/site.yaml']) await utimes(join(root, file), later, later)
      const saved = await run(root, ['save', '--json'])
      assert.equal(saved.code, 0, saved.text)
      assert.equal(existsSync(marker), false, 'a filter driver ran')
      git(root, 'config', 'filter.bad=name.clean', command)
      await refuse(root, ['save'], 'git_filter_unsafe')
    } finally { await rm(marker, { force: true }); await rm(root, { recursive: true, force: true }) }
  })

  test('tsconfig extends only a package; package.json above the app root is a handler input too', async () => {
    const extended = await project({ ...baseFiles(), 'tsconfig.json': '{ // HEAD config\n "extends": "./base.json",\n}\n', 'base.json': '{}' })
    try { assert.match((await refuse(extended, ['save'], 'handler_config_unsupported')).detail, /extends \.\/base\.json/) }
    finally { await rm(extended, { recursive: true, force: true }) }
    // A duplicate key: JSON keeps the last value, esbuild would follow the first; esbuild only ever sees the checked document.
    const duplicate = '{"extends": "./base.json", "extends": "@tsconfig/strictest", "compilerOptions": {"jsx": "a,}", }, /* , */ }'
    assert.equal(headTsconfig({ 'tsconfig.json': new TextEncoder().encode(duplicate) }), '{"extends":"@tsconfig/strictest","compilerOptions":{"jsx":"a,}"}}')
    for (const bad of ['{"a": 1,,}', '{"a": "x', '[1] /*']) assert.throws(() => parseJsonc(bad), SyntaxError, bad)
    const dup = await project({ ...baseFiles(), 'tsconfig.json': '{"extends": "./base.json", "extends": "@scope/missing"}\n', 'base.json': '{"compilerOptions":{"useDefineForClassFields":false}}',
      'handlers/lib.ts': 'export class Box { value = 1 }\nexport const pong = String(new Box().value)\n' })
    try {
      const saved = await run(dup, ['save', '--json'])
      // Either esbuild reports the unknown package or builds without ./base.json; it never applies the local file.
      if (saved.code === 0) assert.doesNotMatch(await readFile(join(dup, '.mantle/host/out/production/backend.json'), 'utf8'), /this\.value = 1/)
      else assert.equal(last(saved).error, 'handler_build_failed', saved.text)
    } finally { await rm(dup, { recursive: true, force: true }) }
    // Outside the repository: a package.json with resolution fields on the way up is refused.
    const outer = await mkdtemp(join(tmpdir(), 'mantle-host-outer-'))
    try {
      await writeFile(join(outer, 'package.json'), JSON.stringify({ browser: { './x.ts': './y.ts' } }))
      const nested = await project(baseFiles(), { parent: outer })
      assert.match((await refuse(nested, ['save'], 'handler_config_outside_project')).detail, /sets browser/)
      // The reviewer's bom/ case: a BOM, or anything unparsable, fails closed.
      await writeFile(join(outer, 'package.json'), '\uFEFF' + JSON.stringify({ browser: { './x.ts': './y.ts' } }))
      assert.match((await refuse(nested, ['save'], 'handler_config_outside_project')).detail, /sets browser/)
      await writeFile(join(outer, 'package.json'), '{ "browser": ')
      assert.match((await refuse(nested, ['save'], 'handler_config_outside_project')).detail, /cannot be checked/)
    } finally { await rm(outer, { recursive: true, force: true }) }
    // Inside the repository but above the project: it must be committed and unchanged.
    const top = await project({ '.gitignore': 'node_modules\n/package.json\n', 'README.md': 'monorepo\n',
      ...Object.fromEntries(Object.entries(baseFiles()).map(([path, text]) => [`apps/site/${path}`, text])) })
    const site = join(top, 'apps/site')
    try {
      await addEsbuild(site)
      await writeFile(join(top, 'package.json'), JSON.stringify({ imports: { '#lib': './apps/site/handlers/lib.ts' } }))
      assert.equal((await refuse(site, ['save'], 'handler_config_untracked')).detail, 'package.json')
      await writeFile(join(top, '.gitignore'), 'node_modules\n'); git(top, 'add', '-A'); git(top, 'commit', '-q', '-m', 'root package')
      assert.equal((await run(site, ['save', '--json'])).code, 0)
      git(top, 'update-index', '--assume-unchanged', 'package.json')
      await writeFile(join(top, 'package.json'), JSON.stringify({ imports: { '#lib': './elsewhere.ts' } }))
      assert.equal((await refuse(site, ['save'], 'worktree_dirty')).detail, 'package.json')
    } finally { await rm(top, { recursive: true, force: true }) }
  })
})

test('link writes a strict link file, ignores .mantle/host/ and native targets print their own step', async () => {
  const root = await project({ 'package.json': '{}\n', '.gitignore': 'node_modules' })
  const run = runner()
  try {
    const linked = await run(root, ['link', '--organization', '0199aaaa-0000-7000-8000-000000000001', '--project', projectId, '--slug', 'shop-app', '--dist', 'web/dist', '--spa', '--json'])
    assert.equal(linked.code, 0, linked.text)
    assert.deepEqual(JSON.parse(await readFile(join(root, '.mantle/hosting.json'), 'utf8')), { schemaVersion: 1, targets: { production: {
      runtime: 'mantle-cloud', organizationId: '0199aaaa-0000-7000-8000-000000000001', projectId, slug: 'shop-app', frontend: { dist: 'web/dist', spa: true } } } })
    assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), 'node_modules\n.mantle/host/\n')
    await run(root, ['link', '--target', 'edge', '--runtime', 'cloudflare', '--json'])
    assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), 'node_modules\n.mantle/host/\n')
    assert.equal(last(await run(root, ['save', '--json'])).error, 'link_target_required')
    assert.deepEqual(last(await run(root, ['save', '--target', 'edge', '--json'])).nextAction, { kind: 'run', command: 'pnpm exec wrangler deploy',
      reason: 'This target deploys with wrangler (wrangler.jsonc); mantle-host does not wrap it.' })
    await run(root, ['link', '--target', 'sites', '--runtime', 'chatgpt-sites', '--json'])
    assert.equal(last(await run(root, ['deploy', 'x', '--target', 'sites', '--json'])).nextAction.kind, 'fix')
    assert.equal(last(await run(root, ['link', '--target', 'bad', '--project', 'Bearer abc', '--json'])).error, 'link_file_invalid')
    assert.equal((await lstat(join(root, '.mantle/hosting.json'))).isFile(), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('open restores the live source into an empty directory only, after the sha256 check', async () => {
  const root = await mkdtemp(join(scratch, 'open-')), zip = zipSync({ 'manifests/site.yaml': strToU8(yaml) })
  const found = sourceHash => ({ downloadUrl: 'http://127.0.0.1:1/api/cloud/static-sources/x?token=T', sourceHash })
  const fetch = async () => new Response(zip)
  const run = runner()
  try {
    const ask = last(await run(root, ['open', '--project', projectId, '--json']))
    assert.deepEqual([ask.nextAction.tool, ask.nextAction.arguments], ['cloud_static_source_discover', { projectId }])
    const bad = await run(root, ['open', '--project', projectId, '--discover', '-', '--json'], { stdin: JSON.stringify(found('0'.repeat(64))), fetch })
    assert.equal(last(bad).error, 'source_checksum_mismatch')
    assert.equal((await readdir(root)).length, 0)
    const ok = await run(root, ['open', '--project', projectId, '--discover', '-', '--json'], { stdin: JSON.stringify(found(sha(zip))), fetch })
    assert.equal(last(ok).state, 'restored', ok.text)
    assert.equal(await readFile(join(root, 'manifests/site.yaml'), 'utf8'), yaml)
    assert.equal(last(await run(root, ['open', '--project', projectId, '--json'])).error, 'directory_not_empty')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('deploy renders the review and prints the literal publish call; rollback prints cloud-rollback-project', async () => {
  const root = await project()
  const run = runner()
  const candidateId = '0199bbbb-0000-7000-8000-000000000001', staticUploadId = '0199bbbb-0000-7000-8000-000000000002'
  const versionId = `${candidateId}.${staticUploadId}`
  const review = (extra = {}) => ({ candidate: { id: candidateId, contentHash: 'a'.repeat(64), uploader: { id: 'u1', email: 'dev@example.com' }, baseRevision: null },
    static: { id: staticUploadId, contentHash: 'b'.repeat(64), sourceHash: 'c'.repeat(64), uploader: { id: 'u2', email: 'fe@example.com' }, sourceRef: { commit: 'e'.repeat(40) },
      spa: false, files: [{ path: '/index.html' }], omitted: ['assets/raw'] }, contractHash: 'd'.repeat(64), handlerRefs: ['ping'],
    yamlDiff: { changed: true, added: 3, removed: 0 }, migration: { supported: true, destructive: false, count: 1 }, live: { kind: 'none', revision: null },
    validation: { status: 'paired', evidence: { probes: { root: { ok: true, status: 200 } } } }, ...extra })
  try {
    const ask = last(await run(root, ['deploy', versionId, '--json']))
    assert.deepEqual(ask.nextAction.arguments, { projectId, staticUploadId })
    assert.equal(ask.nextAction.tool, 'cloud_paired_review')
    assert.match(ask.nextAction.command, /deploy \S+ --target production --review - --json$/)
    const dry = last(await run(root, ['deploy', versionId, '--review', '-', '--dry-run', '--json'], { stdin: JSON.stringify(envelope(review())) }))
    assert.equal(dry.state, 'reviewed')
    assert.equal(dry.review.sourceRef, `${'e'.repeat(40)} (unverified label, not provenance)`)
    assert.deepEqual(dry.review.static.omitted, ['assets/raw'])
    assert.equal(dry.nextAction.kind, 'run')
    assert.ok(last(await run(root, ['deploy', versionId, '--review', '-', '--dry-run', '--json'], { stdin: JSON.stringify(review({ migration: null })) }))
      .notes.includes('migration: unavailable (live schemas failed to compile)'))
    const publish = last(await run(root, ['deploy', versionId, '--review', '-', '--json'], { stdin: JSON.stringify(review()) }))
    assert.equal(publish.nextAction.tool, 'cloud_publish_paired_release')
    const { operationId } = publish.nextAction.arguments
    assert.deepEqual(publish.nextAction.arguments, { projectId, candidateId, staticUploadId, expectedActiveRevision: null, operationId, slug: 'shop-app' })
    assert.equal(last(await run(root, ['deploy', versionId, '--review', '-', '--json'], { stdin: JSON.stringify(review()) })).nextAction.arguments.operationId, operationId)
    // The publish result: only a serving release ends with a URL; otherwise the same operation repeats.
    const release = (value, extra) => run(root, ['deploy', versionId, '--release', '-', '--json'], { stdin: JSON.stringify(envelope({ release: { active: true, ...value }, ...extra })) })
    const live = last(await release({ serving: true, url: 'https://shop-app.mantle.site/' }))
    assert.deepEqual([live.state, live.url, live.nextAction], ['serving', 'https://shop-app.mantle.site/', null])
    const pending = last(await release({ serving: false }))
    assert.deepEqual([pending.nextAction.kind, pending.nextAction.arguments.operationId], ['wait', operationId])
    const domain = last(await run(root, ['deploy', versionId, '--release', '-', '--json'], { stdin: JSON.stringify({ isError: true, content: [{ type: 'text', text: JSON.stringify({ diagnostics: [{ code: 'RESOURCE_UNAVAILABLE', value: { code: 'media_domain_not_ready', retryable: true, retryAfter: 7 } }] }) }] }) }))
    assert.equal(domain.nextAction.kind, 'wait')
    assert.match(domain.nextAction.reason, /7 seconds/)
    assert.equal(last(await run(root, ['deploy', versionId, '--review', '-', '--json'], { stdin: JSON.stringify(review({ validation: { status: 'superseded' } })) })).error, 'version_not_paired')
    assert.equal(last(await run(root, ['deploy', 'nope', '--json'])).error, 'version_invalid')
    // An unsupported storage change is shown and no publish call is printed.
    const blocked = await run(root, ['deploy', versionId, '--review', '-', '--json'], { stdin: JSON.stringify(review({ migration: { supported: false, error: 'column type change on items.title' } })) })
    assert.equal(blocked.code, 1)
    assert.equal(last(blocked).error, 'migration_unsupported')
    assert.match(last(blocked).detail, /migration: unsupported: column type change on items\.title/)
    assert.equal(last(blocked).nextAction.kind, 'fix')
    assert.doesNotMatch(blocked.text, /cloud-publish-paired-release/)
    assert.equal(last(await run(root, ['deploy', versionId, '--review', '-', '--json'], { stdin: JSON.stringify(review({ migration: { supported: true, destructive: true, count: 1 } })) })).error, 'migration_destructive')

    const active = '1'.repeat(64), older = '2'.repeat(64)
    const deployment = { rows: [{ projectId, revision: active, operationId, history: [{ operationId: crypto.randomUUID(), revision: older, status: 'active' }] }] }
    assert.equal(last(await run(root, ['rollback', '--json'])).nextAction.tool, 'cloud_project_deployment')
    const back = last(await run(root, ['rollback', '--deployment', '-', '--json'], { stdin: JSON.stringify(deployment) }))
    assert.equal(back.nextAction.tool, 'cloud_rollback_project')
    assert.deepEqual(back.nextAction.arguments, { projectId, operationId: back.nextAction.arguments.operationId, expectedRevision: active, targetRevision: older })
    assert.equal(last(await run(root, ['rollback', versionId, '--deployment', '-', '--json'], { stdin: JSON.stringify(deployment) })).error, 'version_is_active')
  } finally { await rm(root, { recursive: true, force: true }) }
})
