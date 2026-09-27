// Test helpers for mantle-host: a git project and a loopback stand-in for Cloud
// that answers like Control's host endpoints and records exact bytes and headers.
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { main } from '../src/host/main.mjs'
import { corePin } from '../src/version.mjs'
import { sourceArchiveLimit } from '../src/source-zip.mjs'

export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export const organizationId = '0199aaaa-0000-7000-8000-000000000001'
export const projectId = '0199aaaa-0000-7000-8000-000000000002'
export const yaml = 'apiVersion: cms.mantle.aotter.net/v1\nkind: Schema\nmetadata:\n  name: items\nspec:\n  title: Items\n  schema:\n    type: object\n'
const esbuildDir = dirname(createRequire(import.meta.url).resolve('esbuild/package.json'))

export const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })

export const link = (extra = {}) => JSON.stringify({ schemaVersion: 1, targets: { production: { runtime: 'mantle-cloud', organizationId, projectId, slug: 'shop-app', ...extra } } }, null, 2) + '\n'

export const baseFiles = () => ({
  '.gitignore': 'node_modules\ndist\n.mantle/host/\n.dev.vars\n',
  '.mantle/hosting.json': link(),
  'package.json': '{"name":"app","private":true,"type":"module"}\n',
  'manifests/site.yaml': yaml,
  'handlers/index.ts': 'import { pong } from "./lib"\nexport const handlers = { ping: () => pong }\n',
  'handlers/lib.ts': 'export const pong: string = "pong"\n',
  'src/main.ts': 'console.log("app")\n',
  'README.md': 'Line one\nLine two\n',
})

export async function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

/** A committed project with esbuild available from its node_modules. */
export async function project(files = baseFiles(), { commit = true, parent = tmpdir() } = {}) {
  const root = await mkdtemp(join(parent, 'mantle-host-'))
  git(root, 'init', '-q')
  await writeFiles(root, files)
  await addEsbuild(root)
  if (commit) { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init') }
  return root
}

export async function addEsbuild(root) {
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await symlink(esbuildDir, join(root, 'node_modules', 'esbuild'))
}

export async function writeDist(root, dir = 'dist') {
  await writeFiles(root, { [`${dir}/index.html`]: '<!doctype html><h1>App</h1>', [`${dir}/assets/app.js`]: 'console.log(1)' })
}

/** Runs the host from sources in-process, or the built bundle as a child process. */
export function runner(bundle) {
  return async (cwd, args, { stdin = '', env = {}, fetch, timeouts } = {}) => {
    if (!bundle) {
      let text = ''
      const code = await main(args, { cwd, env, write: chunk => { text += chunk }, stdin: async () => typeof stdin === 'string' ? strToU8(stdin) : stdin,
        sleep: async () => {}, fetch, timeouts, scriptPath: '/opt/mantle plugin/mantle-host.mjs' })
      return { code, text, lines: parse(text) }
    }
    const child = spawn(process.execPath, [bundle, ...args], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let text = '', stderr = ''
    child.stdout.on('data', chunk => { text += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.stdin.end(stdin)
    const code = await new Promise(done => child.on('close', done))
    return { code, text: text + stderr, lines: parse(text), stderr }
  }
}
const parse = text => text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))

/** A stand-in Cloud. `mcp.*` return what the Cloud MCP tools would; HTTP endpoints follow Control. */
export async function fakeCloud() {
  const seen = [], candidates = new Map(), statics = new Map()
  const hooks = { drop: new Set(), outdated: false, minimum: 1 }
  const bearer = () => 'Bearer ' + randomUUID().replaceAll('-', '') + 'SECRETTOKEN'
  const kitEntries = candidateId => ({ 'AGENT.md': '# Build\n', 'frontend-contract.json': '{}', 'mantle-client.ts': 'export {}',
    'openapi.json': '{}', 'kit.json': JSON.stringify({ candidateId, contractHash: 'c'.repeat(64), coreRevision: corePin.revision }) })
  let origin
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks), url = new URL(request.url, origin)
    seen.push({ method: request.method, path: url.pathname, search: url.search, headers: request.headers, body })
    const key = `${request.method} ${url.pathname.split('/').slice(0, 4).join('/')}`
    if (hooks.drop.has(key)) { hooks.drop.delete(key); request.socket.destroy(); return }
    const json = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
    if (hooks.outdated) return json(426, { error: 'client_outdated', protocol: { current: 2, minimum: 2 } })
    const [, , , kind, id] = url.pathname.split('/')
    if (kind === 'backend-uploads') {
      const row = candidates.get(id)
      if (!row || request.headers.authorization !== row.authorization) return json(403, {})
      if (request.method === 'PUT') {
        if (sha(body) !== row.contentHash) return json(400, { error: 'backend_checksum_mismatch' })
        row.bytes = body; row.status = 'ready'
        return json(200, { candidateId: id, projectId, contentHash: row.contentHash, status: 'ready' })
      }
      const zip = zipSync(Object.fromEntries(Object.entries(kitEntries(id)).map(([name, text]) => [name, strToU8(text)])))
      row.kit = zip
      return json(200, { candidateId: id, projectId, contentHash: row.contentHash, status: row.status, protocol: { current: 1, minimum: hooks.minimum },
        ...row.status === 'ready' ? { frontendKit: { url: `${origin}/api/cloud/frontend-kits/${id}?token=KITSECRET${id}`, zipSha256: sha(zip), contractHash: 'c'.repeat(64), expiresAt: Date.now() + 60_000 } } : {} })
    }
    if (kind === 'frontend-kits') {
      const row = candidates.get(id)
      if (!row?.kit || url.searchParams.get('token') !== `KITSECRET${id}`) return json(403, {})
      response.writeHead(200, { 'content-type': 'application/zip' }); response.end(row.kit); return
    }
    if (kind === 'static-uploads' || kind === 'static-sources') {
      const row = statics.get(id), part = kind === 'static-uploads' ? 'frontend' : 'source'
      if (!row) return json(403, {})
      if (request.method === 'GET') return request.headers.authorization === row.frontend.authorization ? json(200, { staticUploadId: id, status: row.paired ? 'paired' : 'busy', protocol: { current: 1, minimum: 1 } }) : json(403, {})
      if (request.headers.authorization !== row[part].authorization) return json(403, {})
      if (sha(body) !== (part === 'frontend' ? row.contentHash : row.sourceHash)) return json(400, { error: 'upload_checksum_mismatch' })
      row.bytes[part] = body
      const done = row.bytes.frontend && row.bytes.source
      if (done) row.paired = true
      return json(200, { staticUploadId: id, kind: part, hash: sha(body), status: done ? 'uploaded' : 'uploading', pairing: done ? { staticUploadId: id, status: 'paired' } : null })
    }
    json(404, {})
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${server.address().port}`
  const mcp = {
    backendUpload(args) {
      let row = [...candidates.values()].find(item => item.operationId === args.operationId)
      if (!row) { row = { id: randomUUID(), ...args, status: 'uploading', authorization: bearer() }; candidates.set(row.id, row) }
      const url = `${origin}/api/cloud/backend-uploads/${row.id}`
      return { candidateId: row.id, projectId: args.projectId, operationId: row.operationId, contentHash: row.contentHash, status: row.status, protocol: { current: 1, minimum: hooks.minimum },
        poll: { url, method: 'GET', authorization: row.authorization }, upload: row.status === 'ready' ? null : { url, method: 'PUT', authorization: row.authorization, maximumBytes: 2_000_000 } }
    },
    staticUpload(args) {
      const row = statics.get(args.operationId) ?? { ...args, bytes: {}, frontend: { authorization: bearer() }, source: { authorization: bearer() } }
      statics.set(args.operationId, row)
      const url = `${origin}/api/cloud/static-uploads/${args.operationId}`
      return { staticUploadId: args.operationId, projectId: args.projectId, candidateId: args.candidateId, contractHash: args.contractHash, contentHash: args.contentHash,
        sourceHash: args.sourceHash, sourceRef: args.sourceRef ?? null, status: 'uploading', protocol: { current: 1, minimum: 1 },
        poll: { url, method: 'GET', authorization: row.frontend.authorization },
        frontend: { url, method: 'PUT', authorization: row.frontend.authorization, maximumBytes: 9_000_000, uploaded: Boolean(row.bytes.frontend) },
        source: { url: `${origin}/api/cloud/static-sources/${args.operationId}`, method: 'PUT', authorization: row.source.authorization, maximumBytes: sourceArchiveLimit, uploaded: Boolean(row.bytes.source) } }
    },
  }
  const secrets = () => [...candidates.values()].flatMap(row => [row.authorization, row.authorization.slice(7), `KITSECRET${row.id}`])
    .concat([...statics.values()].flatMap(row => [row.frontend.authorization, row.source.authorization]))
  return { origin, seen, hooks, mcp, candidates, statics, secrets, close: () => new Promise(done => server.close(done)) }
}
