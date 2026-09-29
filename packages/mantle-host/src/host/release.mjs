// link, status, deploy and rollback. Deploy and rollback only ever print the
// literal Cloud MCP call for a deployer to make after review: this script
// never publishes, and there is no one-step upload-and-publish. `open` restores the live source.
import { createHash, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { unzipSync } from 'fflate'
import { grantUrl, hex64, unwrapResult, uuid } from './cloud.mjs'
import { appendInside, readInside, safeRelative, writeAtomic } from './files.mjs'
import { linkFile, readLink, validateLink, writeLink } from './link.mjs'
import { fail } from './output.mjs'
import { saveState } from './state.mjs'
import { backendNext, contractNext, staticNext } from './save.mjs'
import { parseCorePin } from '../protocol.mjs'
import { sourceArchiveLimit, sourceEntryLimit, sourceExpandedLimit } from '../source-zip.mjs'

const versionRule = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** What a target hosted elsewhere does instead; mantle-host never wraps those tools. */
export function nativeNext(entry, verb) {
  if (entry.runtime === 'cloudflare') {
    const config = entry.config && entry.config !== 'wrangler.jsonc' ? ['--config', entry.config] : []
    const command = ['pnpm', 'exec', 'wrangler', ...{ rollback: ['rollback'], status: ['deployments', 'list'] }[verb] ?? ['deploy'], ...config].join(' ')
    return { kind: 'run', command, reason: `This target deploys with wrangler (${entry.config ?? 'wrangler.jsonc'}); mantle-host does not wrap it.` }
  }
  return { kind: 'fix', reason: `This target is saved and deployed in ChatGPT Sites (${entry.config ?? '.openai/hosting.json'}); mantle-host does not wrap it.` }
}

export async function link(ctx, flags) {
  const doc = await readLink(ctx.project) ?? { schemaVersion: 1, targets: {} }
  const names = Object.keys(doc.targets)
  const target = flags.target ?? (names.length === 1 ? names[0] : names.length ? null : 'production')
  if (!target) throw fail('link_target_required', `pass --target with one of: ${names.join(', ')} or a new name`)
  const existing = doc.targets[target]
  const runtime = flags.runtime ?? existing?.runtime ?? 'mantle-cloud'
  const base = existing?.runtime === runtime ? existing : { runtime }
  const drop = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
  const entry = runtime === 'mantle-cloud' ? drop({ ...base, organizationId: flags.organization ?? base.organizationId, projectId: flags.project ?? base.projectId,
    slug: flags.slug ?? base.slug, root: flags.root ?? base.root, handlers: flags.handlers ?? base.handlers,
    frontend: flags.dist || flags.spa || flags.build || base.frontend ? drop({ ...base.frontend, dist: flags.dist ?? base.frontend?.dist, spa: flags.spa ?? base.frontend?.spa,
      build: flags.build ?? base.frontend?.build }) : undefined })
    : drop({ ...base, config: flags.config ?? base.config })
  const next = { schemaVersion: 1, targets: { ...doc.targets, [target]: entry } }
  validateLink(next)
  await writeLink(ctx.project, next)
  const ignore = await readInside(ctx.project, '.gitignore', 1_000_000)
  const text = ignore ? new TextDecoder().decode(ignore) : ''
  const lines = text.split(/\r?\n/).map(line => line.trim())
  if (!['.mantle/host/', '.mantle/host', '/.mantle/host/', '/.mantle/host', '.mantle/host/**'].some(pattern => lines.includes(pattern)))
    await appendInside(ctx.project, '.gitignore', (text && !text.endsWith('\n') ? '\n' : '') + '.mantle/host/\n')
  ctx.emit({ ok: true, stage: 'link', state: 'linked', notes: [`target ${target} → ${runtime}${entry.projectId ? ` project ${entry.projectId}` : ''}`],
    nextAction: { kind: 'run', command: `git add -- ${linkFile} .gitignore && git commit -m 'Link Mantle hosting'`,
      reason: 'Commit the link file: save reads only committed files. The first save asks the user to confirm the organization and project by name.' } })
  return 0
}

export async function status(ctx) {
  const { entry } = ctx.link, ts = ctx.targetState, pending = ts.pending
  const latest = ts.versions.at(-1) ?? null
  let nextAction
  // A pending upload continues with the same literal call its save printed (same operationId).
  if (pending && pending.stage !== 'contract' && !parseCorePin(pending.core))
    nextAction = { kind: 'run', command: ctx.line('save', ...ctx.targetArgs, '--restart'), reason: 'This save predates Cloud Core negotiation. Start a new save.' }
  else if (pending?.stage === 'contract') nextAction = contractNext(ctx)
  else if (pending?.stage === 'backend') nextAction = backendNext(ctx, pending)
  else if (pending?.stage === 'build') nextAction = { kind: 'run', command: ctx.resume(false), reason: 'Build the frontend, then continue this save.' }
  else if (pending?.stage === 'static') nextAction = staticNext(ctx, pending)
  else if (latest) nextAction = { kind: 'mcp', tool: 'cloud-paired-review', arguments: { projectId: entry.projectId, staticUploadId: latest.staticUploadId },
    command: ctx.line('deploy', latest.versionId, ...ctx.targetArgs, '--review', '-'), reason: 'Review the latest saved version; a deployer pipes the review to the command.' }
  else nextAction = { kind: 'run', command: ctx.line('save', ...ctx.targetArgs), reason: 'Nothing is saved for this target yet.' }
  ctx.emit({ ok: true, stage: 'status', state: pending ? `pending-${pending.stage}` : latest ? 'saved' : 'idle', ...latest ? { versionId: latest.versionId } : {},
    commit: pending?.commit ?? latest?.commit ?? null, notes: [`project ${entry.projectId}`, `${ts.versions.length} saved versions`], nextAction })
  return 0
}

function parseVersion(value) {
  const match = versionRule.exec(value ?? '')
  if (!match) throw fail('version_invalid', 'a versionId is <candidateId>.<staticUploadId> as printed by save')
  return { versionId: value, candidateId: match[1], staticUploadId: match[2] }
}

const reviewSummary = review => ({
  backend: { contentHash: review.candidate?.contentHash ?? null, uploader: review.candidate?.uploader?.email ?? review.candidate?.uploader?.id ?? null, baseRevision: review.candidate?.baseRevision ?? null },
  static: { contentHash: review.static?.contentHash ?? null, sourceHash: review.static?.sourceHash ?? null, uploader: review.static?.uploader?.email ?? review.static?.uploader?.id ?? null,
    spa: review.static?.spa ?? null, files: (review.static?.files ?? []).slice(0, 100).map(file => file.path), omitted: review.static?.omitted ?? [] },
  sourceRef: review.static?.sourceRef?.commit ? `${review.static.sourceRef.commit} (unverified label, not provenance)` : 'none (unversioned)',
  contractHash: review.contractHash ?? null, handlerRefs: (review.handlerRefs ?? []).slice(0, 100),
  yaml: review.yamlDiff ? { changed: review.yamlDiff.changed, added: review.yamlDiff.added, removed: review.yamlDiff.removed } : null,
  migration: review.migration ? { supported: review.migration.supported === true, destructive: review.migration.destructive ?? null, count: review.migration.count ?? null,
    ...review.migration.supported === true ? {} : { error: String(review.migration.error ?? 'unsupported storage change').slice(0, 500) } } : null,
  live: review.live ?? null,
  evidence: review.validation?.evidence?.probes ? Object.fromEntries(Object.entries(review.validation.evidence.probes).map(([name, probe]) => [name, probe.ok ? 'ok' : probe.reason ?? 'failed'])) : null,
})

export async function deploy(ctx, positional, flags, readInput) {
  const { entry } = ctx.link
  const version = parseVersion(positional)
  const again = [...flags['dry-run'] ? ['--dry-run'] : []]
  if (flags.release) return await released(ctx, version, flags, readInput)
  if (!flags.review) {
    ctx.emit({ ok: true, stage: 'deploy', state: 'review-needed', versionId: version.versionId, commit: null, nextAction: { kind: 'mcp', tool: 'cloud-paired-review',
      arguments: { projectId: entry.projectId, staticUploadId: version.staticUploadId }, command: ctx.line('deploy', version.versionId, ...ctx.targetArgs, '--review', '-', ...again),
      reason: 'Deploy is a separate, reviewed step for a project deployer. Pipe the review to the command.' } })
    return 0
  }
  if (flags.review !== '-') throw fail('usage', 'pass --review - and pipe the cloud_paired_review result on stdin')
  const review = unwrapResult(await readInput(), 'validation')
  if (!review || review.static?.id !== version.staticUploadId || review.candidate?.id !== version.candidateId) throw fail('review_mismatch', 'pipe the cloud_paired_review result for this versionId')
  const summary = reviewSummary(review), commit = review.static?.sourceRef?.commit ?? 'unversioned'
  const notes = [`backend ${summary.backend.contentHash} by ${summary.backend.uploader}`, `static ${summary.static.contentHash} by ${summary.static.uploader}, ${summary.static.files.length} files`,
    `source ${summary.static.sourceHash}, label ${summary.sourceRef}`, `omitted: ${summary.static.omitted.length ? summary.static.omitted.join(', ') : 'none'}`,
    `handlers: ${summary.handlerRefs.join(', ') || 'none'}`, `yaml: ${summary.yaml ? `+${summary.yaml.added} -${summary.yaml.removed}` : 'no live comparison'}`,
    `migration: ${!summary.migration ? 'unavailable (live schemas failed to compile)' : !summary.migration.supported ? `unsupported: ${summary.migration.error}` : `${summary.migration.count ?? 0} steps${summary.migration.destructive ? ', destructive' : ''}`}`,
    `evidence: ${summary.evidence ? Object.entries(summary.evidence).map(([name, verdict]) => `${name} ${verdict}`).join(', ') : 'none'}`]
  if (review.validation?.status !== 'paired') throw Object.assign(fail('version_not_paired', String(review.validation?.status ?? 'unknown')),
    { nextAction: { kind: 'mcp', tool: 'cloud-static-preview', arguments: { projectId: entry.projectId, staticUploadId: version.staticUploadId }, reason: 'Only a paired version can be published.' } })
  // Cloud refuses these at publish; say so with the review instead of printing a call that fails.
  if (summary.migration && (!summary.migration.supported || summary.migration.destructive)) {
    ctx.emit({ ok: false, stage: 'deploy', error: summary.migration.supported ? 'migration_destructive' : 'migration_unsupported', detail: notes.join('\n'), review: summary,
      nextAction: { kind: 'fix', reason: 'This version changes storage in a way Cloud cannot migrate automatically; nothing can be published. Change the manifests so the storage change is additive, then save a new version.' } })
    return 1
  }
  const active = review.live?.revision ?? null, base = review.candidate?.baseRevision ?? null
  if (active !== base) throw Object.assign(fail('candidate_base_revision_changed', 'the live revision moved after this candidate was built'),
    { nextAction: { kind: 'run', command: ctx.line('save', ...ctx.targetArgs, '--restart'), reason: 'Save a new version against the current live revision.' } })
  if (flags['dry-run']) {
    ctx.emit({ ok: true, stage: 'deploy', state: 'reviewed', versionId: version.versionId, commit, review: summary, notes,
      nextAction: { kind: 'run', command: ctx.line('deploy', version.versionId, ...ctx.targetArgs, '--review', '-'), reason: 'Dry run: nothing is published. Re-run without --dry-run, piping the same review, to get the publish call.' } })
    return 0
  }
  const ts = ctx.targetState
  const saved = ts.deploys[version.versionId]
  const operationId = saved?.expectedActiveRevision === active && saved.operationId ? saved.operationId : randomUUID()
  ts.deploys[version.versionId] = { operationId, expectedActiveRevision: active }
  await saveState(ctx.project, ctx.state)
  ctx.emit({ ok: true, stage: 'deploy', state: 'reviewed', versionId: version.versionId, commit, review: summary, notes,
    nextAction: publishNext(ctx, version, { operationId, expectedActiveRevision: active }, 'Publish now (Cloud checks deploy access). Repeat the identical call while the result is not serving.') })
  return 0
}

const publishNext = (ctx, version, { operationId, expectedActiveRevision }, reason) => ({ kind: 'mcp', tool: 'cloud-publish-paired-release',
  arguments: { projectId: ctx.link.entry.projectId, candidateId: version.candidateId, staticUploadId: version.staticUploadId, expectedActiveRevision, operationId,
    ...expectedActiveRevision === null ? { slug: ctx.link.entry.slug } : {} },
  command: ctx.line('deploy', version.versionId, ...ctx.targetArgs, '--release', '-'), reason })

/** Reads the publish result: a serving URL ends the deploy; anything else repeats the same operation. */
async function released(ctx, version, flags, readInput) {
  if (flags.release !== '-') throw fail('usage', 'pass --release - and pipe the cloud_publish_paired_release result on stdin')
  const saved = ctx.targetState.deploys[version.versionId]
  if (!saved?.operationId) throw fail('nothing_to_publish', 'run deploy for this versionId first')
  const raw = await readInput(), release = unwrapResult(raw, 'release')?.release
  // A business failure is an MCP isError result: {diagnostics:[{code, value?: {code, retryable, retryAfter}}]} in its text block.
  const diagnostic = release ? null : unwrapResult(raw, 'diagnostics')?.diagnostics?.[0]
  const problem = diagnostic ? { error: String(diagnostic.value?.code ?? diagnostic.code).toLowerCase(), ...diagnostic.value } : null
  const wait = (reason) => ctx.emit({ ok: true, stage: 'deploy', state: 'publishing', versionId: version.versionId, commit: null, nextAction: { ...publishNext(ctx, version, saved, reason), kind: 'wait' } })
  if (problem?.error === 'media_domain_not_ready' && problem.retryable) wait(`The site address is not ready. Wait ${Number(problem.retryAfter) || 30} seconds, then repeat this identical call.`)
  else if (problem) throw fail(/^[a-z0-9_]{1,100}$/.test(problem.error) ? problem.error : 'publish_failed')
  else if (!release) throw fail('release_invalid', 'pipe the cloud_publish_paired_release result')
  else if (release.active && release.serving && /^https:\/\/[^\s]+$/.test(release.url ?? '')) {
    ctx.emit({ ok: true, stage: 'deploy', state: 'serving', versionId: version.versionId, commit: null, url: release.url, nextAction: null })
  } else wait('Not serving yet. Repeat this identical call (same operation); it finishes the publish. Do not report a URL until it is serving.')
  return 0
}

/** Restores the live source ZIP into an empty directory: discover (no staticUploadId) → download → sha256 → extract. */
export async function open(ctx, flags, readInput) {
  if (!uuid.test(flags.project ?? '')) throw fail('usage', 'pass --project <id>')
  if ((await readdir(ctx.project)).length) throw fail('directory_not_empty', 'open restores into an empty directory only')
  if (flags.discover !== '-') {
    ctx.emit({ ok: true, stage: 'open', state: 'discover-needed', commit: null, nextAction: { kind: 'mcp', tool: 'cloud-static-source-discover', arguments: { projectId: flags.project },
      command: ctx.line('open', '--project', flags.project, '--discover', '-'), reason: 'Call the tool with these arguments (no staticUploadId: it returns the live source), then pipe its result to the command.' } })
    return 0
  }
  const found = unwrapResult(await readInput(), 'downloadUrl')
  if (!found || !hex64.test(found.sourceHash ?? '')) throw fail('discover_invalid', 'pipe the cloud_static_source_discover result')
  ctx.output.remember(found.downloadUrl)
  const zip = await ctx.cloud.bytes(grantUrl(found.downloadUrl, undefined, { query: true }), { limit: sourceArchiveLimit, timeout: 120_000 })
  if (createHash('sha256').update(zip).digest('hex') !== found.sourceHash) throw fail('source_checksum_mismatch')
  let count = 0, size = 0
  const files = unzipSync(zip, { filter: file => {
    size += file.originalSize
    if (++count > sourceEntryLimit || size > sourceExpandedLimit || !safeRelative(file.name)) throw fail('source_archive_invalid', file.name)
    return true
  } })
  for (const [name, bytes] of Object.entries(files)) await writeAtomic(ctx.project, name, bytes)
  ctx.emit({ ok: true, stage: 'open', state: 'restored', commit: null, verified: { contentHash: null, sourceHash: found.sourceHash, contractHash: null }, notes: [`${count} files`],
    nextAction: { kind: 'fix', reason: 'Source restored. Edit it, then commit it with Git (save reads HEAD; git init first if needed) or use save --no-git. If .mantle/hosting.json is missing, run link.' } })
  return 0
}

export async function rollback(ctx, positional, flags, readInput) {
  const { entry } = ctx.link
  const version = positional ? parseVersion(positional) : null
  if (flags.revision !== undefined && !hex64.test(flags.revision)) throw fail('revision_invalid', 'a revision is 64 lowercase hex characters')
  const select = [...version ? [version.versionId] : [], ...ctx.targetArgs, ...flags.revision ? ['--revision', flags.revision] : []]
  if (!flags.deployment) {
    ctx.emit({ ok: true, stage: 'rollback', state: 'deployment-needed', commit: null, nextAction: { kind: 'mcp', tool: 'cloud-project-deployment',
      arguments: { projectId: entry.projectId }, command: ctx.line('rollback', ...select, '--deployment', '-'),
      reason: 'Rollback is a reviewed step for a project deployer. Pipe the deployment to the command.' } })
    return 0
  }
  if (flags.deployment !== '-') throw fail('usage', 'pass --deployment - and pipe the cloud_project_deployment result on stdin')
  const row = unwrapResult(await readInput(), 'rows')?.rows?.find(item => item?.projectId === entry.projectId)
  const active = row?.revision
  if (!row || !hex64.test(active ?? '')) throw fail('nothing_to_roll_back', 'the project has no active revision')
  const history = (Array.isArray(row.history) ? row.history : []).filter(item => hex64.test(item?.revision ?? ''))
  let target = flags.revision ?? null
  if (!target && version) {
    const operationId = ctx.targetState.deploys[version.versionId]?.operationId
    if (operationId && row.operationId === operationId) throw fail('version_is_active')
    target = history.find(item => operationId && item.operationId === operationId)?.revision ?? null
    if (!target) throw fail('rollback_target_unknown', 'this machine did not deploy that version; pass --revision <64-hex> from the deployment history')
  }
  target ??= history.filter(item => item.revision !== active).at(-1)?.revision ?? null
  if (!target || !history.some(item => item.revision === target)) throw fail('rollback_target_unknown', 'choose a retained revision from the deployment history with --revision')
  if (target === active) throw fail('version_is_active')
  const ts = ctx.targetState, key = `${active}:${target}`
  const operationId = ts.rollbacks[key] ?? randomUUID()
  ts.rollbacks = { [key]: operationId }
  await saveState(ctx.project, ctx.state)
  ctx.emit({ ok: true, stage: 'rollback', state: 'ready', commit: null, notes: [`active ${active}`, `target ${target}`],
    nextAction: { kind: 'mcp', tool: 'cloud-rollback-project', arguments: { projectId: entry.projectId, operationId, expectedRevision: active, targetRevision: target },
      reason: 'Confirm with the deployer: this restores Manifest, handlers, frontend and assets only, never data. Repeat the identical call until cloud_project_deployment reports targetRevision active.' } })
  return 0
}
