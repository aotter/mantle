// mantle-host: link, save, deploy, rollback and status for a Mantle app.
// Bundled into ONE file (dist/mantle-host.mjs) that the mantle-host plugin in Mantle Core vendors;
// esbuild is resolved from the project at runtime.
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { hostProtocol } from '../protocol.mjs'
import { cliVersion, corePin, hostName } from '../version.mjs'
import { cloudClient, decodeInput, rememberCredentials } from './cloud.mjs'
import { createOutput, failureLine, fail, shellWord } from './output.mjs'
import { linkFile, pickTarget, readLink } from './link.mjs'
import { loadState, targetState } from './state.mjs'
import { resumeSave, saveFailureNext, startSave } from './save.mjs'
import { deploy, link, nativeNext, rollback, status } from './release.mjs'
import { appRootOf } from './snapshot.mjs'

const usage = `${hostName} <command> [--target <name>] [--json]

  link    [--target <name>] [--runtime mantle-cloud|cloudflare|chatgpt-sites] [--organization <id>] [--project <id>]
          [--slug <slug>] [--root <dir>] [--handlers <file>] [--dist <dir>] [--spa] [--build <command>] [--config <file>]
  save    [--omit <path>]... [--no-git] [--restart]      pack HEAD and print the cloud-backend-upload call
  save    --resume [--grant - | --grant-file <path>]     continue with the piped Cloud MCP tool result
  status                                                 local state and the next step, no network
  deploy  <versionId> [--review -] [--dry-run]           review, then print the cloud-publish-paired-release call
  rollback [<versionId>] [--revision <hex>] [--deployment -]   print the cloud-rollback-project call
  version

Every step prints its nextAction: a literal {kind, tool?, arguments?, command?, reason?, requires?, confirm?}.
Grants come from Cloud MCP tool results on stdin (--grant -), --grant-file or MANTLE_CLOUD_GRANT and are never printed.`

const options = { json: { type: 'boolean' }, target: { type: 'string' }, 'no-git': { type: 'boolean' }, resume: { type: 'boolean' }, restart: { type: 'boolean' },
  grant: { type: 'string' }, 'grant-file': { type: 'string' }, omit: { type: 'string', multiple: true }, runtime: { type: 'string' },
  organization: { type: 'string' }, project: { type: 'string' }, slug: { type: 'string' }, root: { type: 'string' }, handlers: { type: 'string' },
  dist: { type: 'string' }, spa: { type: 'boolean' }, build: { type: 'string' }, config: { type: 'string' }, review: { type: 'string' },
  'dry-run': { type: 'boolean' }, deployment: { type: 'string' }, revision: { type: 'string' }, help: { type: 'boolean' } }
const verbs = new Set(['link', 'save', 'status', 'deploy', 'rollback', 'version'])
const inputLimit = 8_000_000

async function readStdin() {
  const chunks = []
  let length = 0
  for await (const chunk of process.stdin) { length += chunk.length; if (length > inputLimit) throw fail('input_too_large'); chunks.push(chunk) }
  return new Uint8Array(Buffer.concat(chunks))
}

/** Runs one verb, printing one line per transition. Returns the process exit code. */
export async function main(args, io = {}) {
  const json = args.includes('--json')
  const output = createOutput({ json, write: io.write })
  const [verb] = args
  const stage = verbs.has(verb) ? verb : 'usage'
  let parsed
  try { parsed = parseArgs({ args: args.slice(1), options, allowPositionals: true, strict: true }) }
  catch {
    // Option text is never echoed: it may hold a pasted grant.
    output.emit({ ok: false, stage, error: 'usage', detail: 'unknown or invalid option', nextAction: { kind: 'fix', reason: usage.split('\n')[0] } })
    return 2
  }
  const { values: flags, positionals } = parsed
  // A bare `--help` (or no verb at all) is a help request, not a usage error.
  const help = flags.help || verb === '--help'
  if (!verbs.has(verb) || help) { (io.write ?? (text => process.stdout.write(text)))(usage + '\n'); return verb && !help ? 2 : 0 }
  const scriptPath = io.scriptPath ?? fileURLToPath(import.meta.url)
  const script = `node ${shellWord(scriptPath)}`
  // Success lines always carry commit and verified, null when not known yet.
  const ctx = { output, json, emit: line => output.emit(line.ok ? { ...line, commit: line.commit ?? null,
    verified: line.verified ?? { contentHash: null, sourceHash: null, contractHash: null }, nextAction: line.nextAction ?? null } : line), now: io.now ?? Date.now, sleep: io.sleep ?? (ms => new Promise(done => setTimeout(done, ms))),
    timeouts: { backend: 6 * 60_000, pairing: 10 * 60_000, ...io.timeouts }, linkFile, targetArgs: [] }
  ctx.line = (...words) => [script, ...words.map(shellWord), ...json ? ['--json'] : []].join(' ')
  try {
    if (verb === 'version') {
      ctx.emit({ ok: true, stage, state: 'local', version: cliVersion, protocol: hostProtocol.current, core: corePin, commit: null, nextAction: null })
      return 0
    }
    ctx.project = await realpath(resolve(io.cwd ?? process.cwd()))
    if (verb === 'link') return await link(ctx, flags)
    ctx.link = pickTarget(await readLink(ctx.project), flags.target)
    ctx.target = ctx.link.target
    ctx.targetArgs = ['--target', ctx.target]
    ctx.resume = grant => ctx.line('save', '--target', ctx.target, '--resume', ...grant ? ['--grant', '-'] : [])
    if (ctx.link.entry.runtime !== 'mantle-cloud') {
      ctx.emit({ ok: true, stage, state: 'native', commit: null, nextAction: nativeNext(ctx.link.entry, verb) })
      return 0
    }
    ctx.state = await loadState(ctx.project)
    ctx.targetState = targetState(ctx.state, ctx.target)
    ctx.appRoot = await appRootOf(ctx.project, ctx.link.entry.root)
    // Advisory for Cloud; the script's own bytes, or `unknown` when it cannot read itself.
    const scriptSha = await readFile(scriptPath).then(bytes => createHash('sha256').update(bytes).digest('hex'), () => 'unknown')
    ctx.cloud = cloudClient({ fetch: io.fetch ?? globalThis.fetch, client: `${hostName}/${cliVersion} sha256=${scriptSha}` })
    const readInput = async () => {
      const bytes = await (io.stdin ?? readStdin)()
      try { return JSON.parse(decodeInput(bytes)) } catch { throw fail('input_invalid_json', 'pipe the Cloud MCP tool result as JSON') }
    }
    const readGrant = async () => {
      if (flags.grant !== undefined && flags['grant-file'] !== undefined) throw fail('usage', 'pass either --grant - or --grant-file')
      let bytes
      if (flags.grant !== undefined) {
        if (flags.grant !== '-') throw fail('grant_inline_refused', 'pass --grant - and pipe the tool result on stdin; a grant on the command line reaches shell history')
        bytes = await (io.stdin ?? readStdin)()
      } else if (flags['grant-file'] !== undefined) {
        const path = resolve(ctx.project, flags['grant-file'])
        const unreadable = () => fail('grant_file_unreadable', 'pass --grant - and pipe the Cloud MCP tool result on stdin')
        const info = await stat(path).catch(() => { throw unreadable() })
        if (!info.isFile()) throw unreadable()
        if (info.size > inputLimit) throw fail('input_too_large')
        bytes = await readFile(path).catch(() => { throw unreadable() })
        if (bytes.byteLength > inputLimit) throw fail('input_too_large')
      } else if ((io.env ?? process.env).MANTLE_CLOUD_GRANT) bytes = (io.env ?? process.env).MANTLE_CLOUD_GRANT
      else throw fail('grant_required', 'pass --grant - and pipe the Cloud MCP tool result on stdin')
      let grant
      try { grant = JSON.parse(decodeInput(bytes)) } catch { throw fail('grant_invalid_json') }
      rememberCredentials(grant, output)
      return grant
    }
    switch (verb) {
      case 'save': return flags.resume ? await resumeSave(ctx, readGrant) : await startSave(ctx, flags)
      case 'status': return await status(ctx)
      case 'deploy': return await deploy(ctx, positionals[0], flags, readInput)
      case 'rollback': return await rollback(ctx, positionals[0], flags, readInput)
    }
  } catch (error) {
    const code = error?.code && typeof error.code === 'string' && /^[a-z0-9_]{1,100}$/.test(error.code) ? error.code : 'local_error'
    const nextAction = error?.nextAction ?? (verb === 'save' || !ctx.link ? saveFailureNext(ctx, code) : { kind: 'fix', reason: 'Fix the reported problem and re-run.' })
    ctx.emit(failureLine(stage, error, nextAction))
    return code === 'usage' ? 2 : 1
  }
  return 0
}
