// `save`: preflight → backend (git objects) → cloud-backend-upload → upload and
// poll to ready → kit → build (never run by this script) → static + source ZIP
// (git objects) → cloud-static-frontend-upload → upload → pairing → saved
// version. Every operationId is persisted before it is printed; retries reuse it.
import { randomUUID } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { realpath, stat as statPath, writeFile } from 'node:fs/promises'
import { sha256, readDist } from '../pack.mjs'
import { canonicalSourceZip, inspectSourceArchive, sourceArchiveLimit } from '../source-zip.mjs'
import { serializeStaticArtifact, staticFrontendLimit } from '../static-artifact.mjs'
import { corePin, hostName, cliVersion, updateHost } from '../version.mjs'
import { packBackendSnapshot, projectEsbuild } from './backend.mjs'
import { bearerOf, checkProtocol, extractKit, grantUrl, hex64, kitFiles, kitLimitBytes, unwrapResult, uuid } from './cloud.mjs'
import { ensureDir, inside, joinRelative, readInside, resetDir, writeAtomic } from './files.mjs'
import { fail } from './output.mjs'
import { appRootOf, cleanHead, diskSnapshot, gitSnapshot, normalizeOmit } from './snapshot.mjs'
import { outDir, saveState } from './state.mjs'

// Candidates and static receipts live 30 minutes; reuse an operationId only well inside that.
const reuseMs = 25 * 60_000
const second = 1000
export const unsafeDist = Object.freeze(['.git', '.mantle', 'node_modules'])
const commitOf = pending => pending.mode === 'git' ? pending.commit : 'unversioned'

export const requiresVersion = projectId => [{ argument: 'expectedVersion', tool: 'member-project', arguments: { projectId }, field: 'version' }]

export function backendNext(ctx, pending) {
  const { entry } = ctx.link
  const confirm = ctx.targetState.confirmedLink !== ctx.link.hash
  return { kind: 'mcp', tool: 'cloud-backend-upload',
    arguments: { projectId: entry.projectId, operationId: pending.backend.operationId, contentHash: pending.backend.contentHash },
    requires: requiresVersion(entry.projectId), command: ctx.resume(true),
    // Literal lookups (the view parameters in Control's manifest) whose `name` the user confirms.
    ...confirm ? { confirm: [{ tool: 'member-organization', arguments: { organizationId: entry.organizationId }, field: 'name' },
      { tool: 'member-project', arguments: { projectId: entry.projectId }, field: 'name' }] } : {},
    reason: (confirm ? `${ctx.linkFile} is new or changed: call each confirm tool, show the user the organization and project names (site slug ${entry.slug}) and get confirmation before uploading. ` : '') +
      'Call the tool with these arguments plus expectedVersion from member-project, then pipe its result to the command. A retry reuses this operationId.' }
}

export function staticNext(ctx, pending) {
  const { entry } = ctx.link
  return { kind: 'mcp', tool: 'cloud-static-frontend-upload',
    arguments: { projectId: entry.projectId, candidateId: pending.backend.candidateId, operationId: pending.static.operationId,
      contractHash: pending.contractHash, contentHash: pending.static.contentHash, sourceHash: pending.static.sourceHash,
      ...pending.mode === 'git' ? { sourceRef: { commit: pending.commit } } : {}, ...pending.omitted.length ? { omitted: pending.omitted } : {} },
    requires: requiresVersion(entry.projectId), command: ctx.resume(true),
    reason: 'Call the tool with these arguments plus expectedVersion from member-project, then pipe its result to the command. A retry reuses this operationId.' }
}

function buildNext(ctx, pending) {
  const { entry } = ctx.link
  const kit = join(ctx.project, ...outDir(ctx.target).split('/'), 'kit'), dist = join(ctx.project, ...joinRelative(entry.root, entry.frontend.dist).split('/'))
  const then = `then run \`${ctx.resume(false)}\``
  return entry.frontend.build
    ? { kind: 'build', command: entry.frontend.build, reason: `This build command comes from ${ctx.linkFile}; review it, run it in ${ctx.appRoot} (mantle-host never runs it), follow ${join(kit, 'AGENT.md')} so it writes static files to ${dist}, ${then}.` }
    : { kind: 'build', reason: `Read ${join(kit, 'AGENT.md')}, build the frontend as static files into ${dist}, ${then}.` }
}

/** The failure nextAction for `code` at the current save stage. */
export function saveFailureNext(ctx, code) {
  const pending = ctx.targetState?.pending
  const fix = reason => ({ kind: 'fix', command: ctx.line('save', ...ctx.targetArgs), reason })
  switch (code) {
    case 'worktree_dirty': return fix('Commit the listed changes (untracked files count; ignore build output in .gitignore), then re-run save. There is no --allow-dirty.')
    case 'head_changed': return { kind: 'run', command: ctx.line('save', ...ctx.targetArgs, '--restart'), reason: 'HEAD moved during this save. Start again from the new commit with a new operationId.' }
    case 'submodule_unsupported': return fix('Submodules are not uploaded. Vendor the listed paths or move them out of the app root.')
    case 'symlink_unsupported': return fix('Replace the listed symlinks with regular files; symlinks could reach outside the project.')
    case 'source_archive_secret_path': return fix('Remove the listed files from Git (git rm --cached, then ignore them) or pass --omit <path> for each; an omission is recorded and shown to the deployer. Cloud rejects secret paths instead of stripping them.')
    case 'source_archive_expansion_limit': return fix('Pass --omit <path> for large tracked files that are not source; each omission is recorded and shown to the deployer.')
    case 'host_state_tracked': return fix('Local mantle-host state is committed. Run git rm -r --cached .mantle/host, add .mantle/host/ to .gitignore and commit.')
    case 'source_archive_path_invalid': return fix('Rename the listed tracked file, or pass --omit <path> for it; the omission is recorded and shown to the deployer.')
    case 'dist_path_unsafe': case 'dist_outside_root': return { kind: 'fix', reason: `frontend.dist in ${ctx.linkFile} must be a build output directory inside the app root, never .git, .mantle or node_modules.` }
    case 'static_asset_secret_path': return fix('The build output holds secret-named files (listed). Keep them out of the dist directory; they are rejected, not stripped.')
    case 'handler_input_untracked': return fix('The handler bundle reads only committed files and node_modules. Commit the listed file or stop importing it.')
    case 'handler_config_untracked': return fix('The handler bundle resolves with committed config only. Commit the listed file (or delete it) so the bundle is a function of HEAD.')
    case 'handler_config_unsupported': case 'handler_config_invalid': return fix('Fix the app-root tsconfig.json: it must be valid JSON(C) and may extend only a package, not a file.')
    case 'handler_config_outside_project': return fix('A package.json above the project sets browser, imports or exports and would change how the handlers resolve. Move the project or remove those fields.')
    case 'handler_input_omitted': return fix('The handler imports a path passed to --omit. Drop that --omit or stop importing it.')
    case 'esbuild_missing': return fix('Add esbuild as a devDependency of the project and install it (mantle-host never installs packages), then re-run save.')
    case 'git_repository_missing': case 'git_head_missing': return fix('Commit the project to Git (save labels versions with the HEAD commit), or pass --no-git to save an unversioned copy.')
    case 'dist_missing': return pending ? buildNext(ctx, pending) : fix('Build the frontend first.')
    case 'client_outdated': return { kind: 'fix', reason: `Cloud requires a newer mantle-host protocol. ${updateHost} Nothing was uploaded by this call.` }
    case 'cli_core_mismatch': return { kind: 'fix', reason: `Cloud pins another Mantle Core than this mantle-host. ${updateHost}` }
    case 'grant_project_mismatch': return { kind: 'fix', reason: `The grant is for another project than ${ctx.linkFile} names. Call the tool with exactly the arguments of the last nextAction.` }
    case 'local_hash_mismatch': case 'nothing_pending': case 'link_changed': case 'candidate_expired': case 'static_upload_expired': case 'candidate_upload_expired':
      return { kind: 'run', command: ctx.line('save', ...ctx.targetArgs, '--restart'), reason: 'This save cannot continue with the reserved operation. Start again with a new operationId.' }
    case 'cloud_unreachable': case 'cloud_unavailable': case 'save_timeout':
      return { kind: 'wait', ...pending ? { command: ctx.resume(pending.stage !== 'build') } : {},
        reason: 'Wait a minute, call the same Cloud MCP tool with the SAME arguments for a fresh grant and pipe it to the command; Cloud resumes the same operation.' }
    case 'operation_mismatch': case 'upload_grant_rejected': case 'upload_grant_invalid': case 'frontend_kit_unavailable': case 'kit_url_expired': case 'frontend_kit_grant_invalid': case 'grant_invalid': case 'grant_required': case 'grant_invalid_json': case 'grant_file_unreadable':
      if (pending?.stage === 'backend') return backendNext(ctx, pending)
      if (pending?.stage === 'static') return staticNext(ctx, pending)
      return fix('Pipe the Cloud MCP tool result on stdin with --grant -.')
    case 'link_file_invalid': case 'link_file_missing': case 'link_target_required': case 'link_target_unknown':
      return { kind: 'fix', reason: `Fix ${ctx.linkFile} (it holds only ids, a slug and paths) or run link, then re-run save.` }
    default: return fix('Fix the reported problem and re-run save.')
  }
}

async function snapshot(ctx, pending, { distPath } = {}) {
  const { entry } = ctx.link
  if (pending.mode === 'git') return gitSnapshot(ctx.project, { root: entry.root, omit: pending.omitted, commit: pending.commit })
  return diskSnapshot(ctx.project, ctx.appRoot, { omit: pending.omitted, dist: distPath ?? join(ctx.appRoot, ...entry.frontend.dist.split('/')) })
}

const outFile = (ctx, name) => `${outDir(ctx.target)}/${name}`
async function readOwn(ctx, name, hash, limit) {
  const bytes = await readInside(ctx.project, outFile(ctx, name), limit)
  if (!bytes || sha256(bytes) !== hash) throw fail('local_hash_mismatch', `${name} changed after it was reserved`, 409)
  return bytes
}

/** `save` without --resume: preflight and the backend candidate. */
export async function startSave(ctx, flags) {
  const { entry } = ctx.link
  const ts = ctx.targetState
  const omitted = normalizeOmit(flags.omit)
  const mode = flags['no-git'] ? 'unversioned' : 'git'
  const snap = await snapshot(ctx, { mode, omitted })
  ctx.emit({ ok: true, stage: 'preflight', state: mode === 'git' ? 'clean' : 'unversioned', commit: snap.commit, nextAction: null,
    notes: [`${Object.keys(snap.files).length} files`, ...omitted.length ? [`omitted: ${omitted.join(', ')}`] : []] })
  const artifact = await packBackendSnapshot({ esbuild: projectEsbuild(ctx.appRoot), top: snap.top, appRoot: ctx.appRoot, entry: entry.handlers,
    files: snap.files, git: mode === 'git', omit: omitted, cliVersion: `${hostName}@${cliVersion}` })
  await ensureDir(ctx.project, outDir(ctx.target))
  await writeAtomic(ctx.project, outFile(ctx, 'backend.json'), artifact.text)
  const previous = ts.pending
  const reuse = previous && !flags.restart && previous.linkHash === ctx.link.hash && previous.mode === mode && previous.commit === snap.commit && previous.backend.contentHash === artifact.sha256 &&
    previous.omitted.join('\0') === omitted.join('\0') && ctx.now() - previous.backend.reservedAt < reuseMs
  const pending = ts.pending = { stage: 'backend', mode, commit: snap.commit, omitted, linkHash: ctx.link.hash,
    backend: reuse ? previous.backend : { operationId: randomUUID(), contentHash: artifact.sha256, reservedAt: ctx.now(), candidateId: null } }
  await saveState(ctx.project, ctx.state)
  ctx.emit({ ok: true, stage: 'backend', state: 'built', commit: snap.commit, verified: { contentHash: artifact.sha256, sourceHash: null, contractHash: null },
    nextAction: backendNext(ctx, pending) })
  return 0
}

/** `save --resume`: continues the persisted stage. */
export async function resumeSave(ctx, readGrant) {
  const pending = ctx.targetState.pending
  if (!pending) throw fail('nothing_pending', 'run save first')
  // The link target is part of what the user confirmed; a change mid-save starts over.
  if (pending.linkHash !== ctx.link.hash) throw fail('link_changed', `${ctx.linkFile} changed during this save`)
  if (pending.mode === 'git') await cleanHead(ctx.project, pending.commit)
  if (pending.stage === 'backend') return resumeBackend(ctx, pending, await readGrant())
  if (pending.stage === 'build') return packStatic(ctx, pending)
  if (pending.stage === 'static') return resumeStatic(ctx, pending, await readGrant())
  throw fail('state_invalid')
}

async function until(ctx, deadline, step) {
  for (let attempt = 0; ; attempt++) {
    if (attempt) {
      if (ctx.now() >= deadline) throw fail('save_timeout', 'Cloud did not finish in time', 503)
      await ctx.sleep(Math.min(2 * second * 2 ** (attempt - 1), 15 * second))
    }
    const done = await step(attempt)
    if (done) return done
  }
}

async function resumeBackend(ctx, pending, raw) {
  const { entry } = ctx.link
  const grant = unwrapResult(raw, 'candidateId')
  if (!grant || !uuid.test(grant.candidateId ?? '') || !grant.poll || !('upload' in grant) || 'staticUploadId' in grant) throw fail('grant_invalid', 'expected the cloud-backend-upload result for this save')
  if (grant.projectId !== entry.projectId) throw fail('grant_project_mismatch', `${ctx.linkFile} names project ${entry.projectId}`)
  if (grant.contentHash !== pending.backend.contentHash) throw fail('local_hash_mismatch', 'the grant reserves other bytes', 409)
  if (grant.operationId !== undefined && grant.operationId !== pending.backend.operationId) throw fail('operation_mismatch')
  checkProtocol(grant.protocol)
  const id = grant.candidateId, path = `/api/cloud/backend-uploads/${id}`
  const poll = grantUrl(grant.poll.url, path), pollAuth = bearerOf(grant.poll, ctx.output)
  const upload = grant.upload ? grantUrl(grant.upload.url, path, { origin: poll.origin }) : null
  const uploadAuth = grant.upload ? bearerOf(grant.upload, ctx.output) : null
  if (upload && grant.upload.method !== 'PUT') throw fail('grant_invalid')
  const bytes = await readOwn(ctx, 'backend.json', pending.backend.contentHash, 2_000_000)
  pending.backend.candidateId = id
  ctx.targetState.confirmedLink = ctx.link.hash
  await saveState(ctx.project, ctx.state)
  let status = grant.status, body = grant, uploaded = false
  const deadline = ctx.now() + ctx.timeouts.backend
  const ready = await until(ctx, deadline, async () => {
    // Validation advances only inside the PUT, so a validating candidate is sent again.
    if (upload && (status === 'uploading' || status === 'validating')) {
      try { body = await ctx.cloud.json(upload, { method: 'PUT', authorization: uploadAuth, body: bytes, type: 'application/json', timeout: 180 * second }) }
      catch (error) { if (error.status === 503) return null; throw error }
      if (body.candidateId !== id || body.contentHash !== pending.backend.contentHash) throw fail('cloud_response_mismatch')
      if (!uploaded) ctx.emit({ ok: true, stage: 'backend', state: 'uploaded', commit: commitOf(pending), nextAction: null })
      uploaded = true
    } else body = await ctx.cloud.json(poll, { authorization: pollAuth, timeout: 60 * second })
    // The PUT answer carries no kit; the bearer poll does once ready.
    if (body.status === 'ready' && !('frontendKit' in body)) body = await ctx.cloud.json(poll, { authorization: pollAuth, timeout: 60 * second })
    if (body.candidateId !== id) throw fail('cloud_response_mismatch')
    status = body.status
    if (status === 'failed') throw fail('candidate_failed', JSON.stringify((body.diagnostics ?? []).slice(0, 5)).slice(0, 1500))
    return status === 'ready' && 'frontendKit' in body ? body : null
  })
  if (!ready.frontendKit) throw fail('frontend_kit_unavailable', typeof ready.frontendKitError === 'string' ? ready.frontendKitError.slice(0, 100) : undefined)
  const kit = ready.frontendKit
  if (!hex64.test(kit.zipSha256 ?? '') || !hex64.test(kit.contractHash ?? '')) throw fail('cloud_response_invalid')
  const kitUrl = grantUrl(kit.url, `/api/cloud/frontend-kits/${id}`, { origin: poll.origin, query: true })
  ctx.output.remember(kit.url); ctx.output.remember(kitUrl.search.slice(1))
  for (const value of kitUrl.searchParams.values()) ctx.output.remember(value)
  const zip = await ctx.cloud.bytes(kitUrl, { limit: kitLimitBytes, timeout: 60 * second })
  if (sha256(zip) !== kit.zipSha256) throw fail('kit_checksum_mismatch')
  const { entries } = extractKit(zip, { candidateId: id, contractHash: kit.contractHash })
  const dir = await resetDir(ctx.project, `${outDir(ctx.target)}/kit`)
  for (const name of kitFiles) await writeFile(join(dir, name), entries[name], { flag: 'wx' })
  Object.assign(pending, { stage: 'build', contractHash: kit.contractHash, kitZipSha256: kit.zipSha256 })
  await saveState(ctx.project, ctx.state)
  ctx.emit({ ok: true, stage: 'kit', state: 'ready', commit: commitOf(pending),
    verified: { contentHash: pending.backend.contentHash, sourceHash: null, contractHash: kit.contractHash }, nextAction: buildNext(ctx, pending) })
  return 0
}

async function packStatic(ctx, pending) {
  const { entry } = ctx.link
  const distPath = join(ctx.appRoot, ...entry.frontend.dist.split('/'))
  // Followed: a symlinked dist is judged by where it really points.
  const stat = await statPath(distPath).catch(() => null)
  if (!stat?.isDirectory()) throw fail('dist_missing', distPath)
  const dist = await realpath(distPath)
  if (!inside(ctx.appRoot, dist) || dist === ctx.appRoot) throw fail('dist_outside_root', entry.frontend.dist)
  // Never a repository, host state or dependency directory, even through a symlink.
  if (relative(ctx.appRoot, dist).split(sep).some(part => unsafeDist.includes(part.toLowerCase())) || inside(join(ctx.project, '.git'), dist) || inside(join(ctx.project, '.mantle'), dist))
    throw fail('dist_path_unsafe', entry.frontend.dist)
  const kitBytes = await readInside(ctx.project, `${outDir(ctx.target)}/kit/kit.json`, 1_000_000)
  let kit = null
  try { kit = JSON.parse(new TextDecoder().decode(kitBytes)) } catch { /* checked below */ }
  if (kit?.candidateId !== pending.backend.candidateId || kit?.contractHash !== pending.contractHash) throw fail('kit_contract_mismatch', 'the downloaded kit changed; run save --restart')
  if (kit.coreRevision !== corePin.revision) throw fail('cli_core_mismatch', undefined, 409)
  const ignored = []
  const frontendText = serializeStaticArtifact(await readDist(dist, ignored), { sdkRevision: corePin.revision, spa: entry.frontend.spa })
  const snap = await snapshot(ctx, pending, { distPath: dist })
  const backend = JSON.parse(new TextDecoder().decode(await readOwn(ctx, 'backend.json', pending.backend.contentHash, 2_000_000)))
  // Unversioned: nothing pins the working tree, so the handler inputs must still bundle to the uploaded candidate.
  if (pending.mode !== 'git') {
    const again = await packBackendSnapshot({ esbuild: projectEsbuild(ctx.appRoot), top: snap.top, appRoot: ctx.appRoot, entry: entry.handlers,
      files: snap.files, git: false, omit: pending.omitted, cliVersion: `${hostName}@${cliVersion}` })
    if (again.sha256 !== pending.backend.contentHash) throw fail('local_hash_mismatch', 'the manifests or handlers changed after the backend upload', 409)
  }
  const zip = canonicalSourceZip(snap.files)
  // The same rules Cloud applies, including YAML byte-equality with the candidate.
  inspectSourceArchive(zip, backend.sources)
  const frontend = new TextEncoder().encode(frontendText)
  await writeAtomic(ctx.project, outFile(ctx, 'static-frontend.json'), frontend)
  await writeAtomic(ctx.project, outFile(ctx, 'source.zip'), zip)
  const hashes = { contentHash: sha256(frontend), sourceHash: sha256(zip) }
  const previous = pending.static
  const reuse = previous && previous.contentHash === hashes.contentHash && previous.sourceHash === hashes.sourceHash && ctx.now() - previous.reservedAt < reuseMs
  Object.assign(pending, { stage: 'static', static: reuse ? previous : { operationId: randomUUID(), ...hashes, reservedAt: ctx.now() } })
  await saveState(ctx.project, ctx.state)
  ctx.emit({ ok: true, stage: 'static', state: 'built', commit: commitOf(pending),
    verified: { contentHash: hashes.contentHash, sourceHash: hashes.sourceHash, contractHash: pending.contractHash },
    notes: [`${Object.keys(snap.files).length} source files`, ...ignored.length ? [`skipped in dist: ${ignored.join(', ')}`] : [],
      ...pending.omitted.length ? [`omitted: ${pending.omitted.join(', ')}`] : []], nextAction: staticNext(ctx, pending) })
  return 0
}

async function resumeStatic(ctx, pending, raw) {
  const { entry } = ctx.link
  const grant = unwrapResult(raw, 'staticUploadId')
  const id = pending.static.operationId
  if (!grant || grant.staticUploadId !== id) throw fail('grant_invalid', 'expected the cloud-static-frontend-upload result for this save')
  if (grant.projectId !== entry.projectId) throw fail('grant_project_mismatch', `${ctx.linkFile} names project ${entry.projectId}`)
  if (grant.candidateId !== pending.backend.candidateId || grant.contentHash !== pending.static.contentHash || grant.sourceHash !== pending.static.sourceHash ||
    (grant.contractHash !== undefined && grant.contractHash !== pending.contractHash)) throw fail('local_hash_mismatch', 'the grant reserves other bytes', 409)
  checkProtocol(grant.protocol)
  const parts = { frontend: { path: `/api/cloud/static-uploads/${id}`, file: 'static-frontend.json', hash: pending.static.contentHash, type: 'application/json', limit: staticFrontendLimit },
    source: { path: `/api/cloud/static-sources/${id}`, file: 'source.zip', hash: pending.static.sourceHash, type: 'application/zip', limit: sourceArchiveLimit } }
  const poll = grantUrl(grant.poll?.url, parts.frontend.path), pollAuth = bearerOf(grant.poll, ctx.output)
  const loaded = {}
  for (const [kind, part] of Object.entries(parts)) {
    if (!grant[kind] || grant[kind].method !== 'PUT') throw fail('grant_invalid', kind)
    part.url = grantUrl(grant[kind].url, part.path, { origin: poll.origin })
    part.authorization = bearerOf(grant[kind], ctx.output)
    // Both files are checked before either is sent.
    loaded[kind] = await readOwn(ctx, part.file, part.hash, part.limit)
  }
  let pairing = null
  for (const [kind, part] of Object.entries(parts)) {
    if (grant[kind].uploaded) continue
    // The PUT that completes both parts pairs in-request (about 90 s).
    const body = await ctx.cloud.json(part.url, { method: 'PUT', authorization: part.authorization, body: loaded[kind], type: part.type, timeout: 180 * second })
    if (body.staticUploadId !== id || body.kind !== kind || body.hash !== part.hash) throw fail('cloud_response_mismatch', kind)
    pairing = body.pairing ?? pairing
  }
  ctx.emit({ ok: true, stage: 'static', state: 'uploaded', commit: commitOf(pending), nextAction: null })
  let result = pairing?.status === 'paired' || pairing?.status === 'failed' ? { status: pairing.status, failure: pairing.failure ?? null } : null
  if (!result) result = await until(ctx, ctx.now() + ctx.timeouts.pairing, async () => {
    const body = await ctx.cloud.json(poll, { authorization: pollAuth, timeout: 150 * second })
    return ['paired', 'failed', 'blocked', 'superseded'].includes(body.status) ? body : null
  })
  if (result.status === 'failed') throw fail('static_pair_failed', String(result.failure ?? 'probe failed').slice(0, 200))
  if (result.status === 'superseded') throw fail('static_pair_superseded', 'another static upload was paired with this candidate later')
  if (result.status === 'blocked') {
    const next = result.nextAction && typeof result.nextAction === 'object' ? result.nextAction : null
    throw Object.assign(fail('static_pair_blocked', String(result.reason ?? '').slice(0, 100)), next ? { nextAction: {
      kind: next.kind === 'fix' ? 'fix' : 'mcp', ...typeof next.tool === 'string' ? { tool: next.tool } : {},
      ...next.arguments && typeof next.arguments === 'object' ? { arguments: next.arguments } : {}, reason: String(next.reason ?? '').slice(0, 500) } } : {})
  }
  const versionId = `${pending.backend.candidateId}.${id}`
  const ts = ctx.targetState
  ts.versions = [...ts.versions.filter(version => version.versionId !== versionId),
    { versionId, commit: commitOf(pending), candidateId: pending.backend.candidateId, staticUploadId: id, omitted: pending.omitted }].slice(-50)
  ts.pending = null
  await saveState(ctx.project, ctx.state)
  ctx.emit({ ok: true, stage: 'saved', state: 'paired', versionId, commit: commitOf(pending),
    verified: { contentHash: pending.static.contentHash, sourceHash: pending.static.sourceHash, contractHash: pending.contractHash },
    nextAction: { kind: 'mcp', tool: 'cloud-backend-preview-grant', arguments: { projectId: entry.projectId, candidateId: pending.backend.candidateId },
      reason: `Saved, not published. Test the paired preview through the entrance this tool returns; to publish, a deployer runs \`${ctx.line('deploy', versionId, ...ctx.targetArgs)}\`.` } })
  return 0
}
