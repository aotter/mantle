import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { CloudRuleError, serializeStaticArtifact } from './static-artifact.mjs'
import { canonicalSourceZip, inspectSourceArchive, secretSourcePath, sourceEntryLimit, sourceExpandedLimit, sourcePathKey } from './source-zip.mjs'
import { yamlSources } from './backend-artifact.mjs'
import { parseCorePin } from './protocol.mjs'

/** Names never taken into a source snapshot, at any depth (a worktree's `.git` is a file). */
export const defaultSourceExcludes = Object.freeze(['.git', 'node_modules', '.wrangler'])
/** Operating-system metadata files skipped (and reported) in a dist directory. */
export const ignoredDistFiles = Object.freeze(['.DS_Store', 'Thumbs.db'])
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const posix = path => path.split(sep).join('/')
const inside = (root, path) => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !rel.startsWith(sep) }

// Regular files only: a symlink could smuggle bytes from outside the project.
async function walk(root, visit, skip = () => false) {
  async function step(dir) {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      const path = join(dir, entry.name), rel = posix(relative(root, path))
      if (skip(rel, entry)) continue
      if (entry.isSymbolicLink()) throw new CloudRuleError(400, 'symlink_unsupported', rel)
      if (entry.isDirectory()) await step(path)
      else if (entry.isFile()) await visit(rel, path)
      else throw new CloudRuleError(400, 'special_file_unsupported', rel)
    }
  }
  await step(root)
}

/** Reads a built dist directory into `/path` → bytes, the asset map of a static artifact. Secret-named files are rejected, never stripped. */
export async function readDist(distArg, ignored = []) {
  const dist = await realpath(resolve(distArg))
  if (!(await lstat(dist)).isDirectory()) throw new CloudRuleError(400, 'dist_not_directory')
  const files = Object.create(null), secrets = []
  await walk(dist, async (rel, path) => { if (secretSourcePath(rel)) secrets.push(rel); else files['/' + rel] = new Uint8Array(await readFile(path)) },
    (rel, entry) => {
      // Build output never holds a repository, host state or dependencies.
      if (entry.isDirectory() && ['.git', '.mantle', 'node_modules'].includes(entry.name.toLowerCase())) throw new CloudRuleError(400, 'dist_path_unsafe', rel)
      return entry.isFile() && ignoredDistFiles.includes(entry.name) && Boolean(ignored.push('/' + rel))
    })
  if (secrets.length) throw new CloudRuleError(400, 'static_asset_secret_path', secrets.join(', '))
  return files
}

/** Reads project files for the source snapshot, rejecting (never silently dropping) secret paths. */
export async function readSource(projectArg, excludes = []) {
  const project = await realpath(resolve(projectArg))
  const skipped = excludes.map(item => posix(item).replace(/^\.\/+/, '').replace(/\/+$/, '')).filter(Boolean)
  const excluded = new Set()
  const skip = (rel, entry) => {
    const hit = defaultSourceExcludes.includes(entry.name) ||
      skipped.some(item => rel === item || rel.startsWith(item + '/'))
    if (hit) excluded.add(rel)
    return hit
  }
  const files = Object.create(null), secrets = [], seen = new Map()
  let expanded = 0
  await walk(project, async (rel, path) => {
    if (secretSourcePath(rel)) { secrets.push(rel); return }
    const key = sourcePathKey(rel)
    if (seen.has(key)) throw new CloudRuleError(400, 'source_archive_duplicate_path', `${seen.get(key)} and ${rel}`)
    seen.set(key, rel)
    const bytes = new Uint8Array(await readFile(path))
    expanded += bytes.byteLength
    if (Object.keys(files).length >= sourceEntryLimit || expanded > sourceExpandedLimit) throw new CloudRuleError(400, 'source_archive_expansion_limit')
    files[rel] = bytes
  }, skip)
  if (secrets.length) throw new CloudRuleError(400, 'source_archive_secret_path', secrets.join(', '))
  return { project, files, excluded: [...excluded].sort() }
}

async function readJson(path, label) {
  try { return JSON.parse(await readFile(resolve(path), 'utf8')) }
  catch { throw new CloudRuleError(400, `${label}_unreadable`, path) }
}

/**
 * Builds the static artifact JSON v2 and the canonical source ZIP, checks both
 * with Cloud's own rules and writes them to `out`. Nothing is uploaded.
 */
export async function packFrontend({ project: projectArg = '.', dist: distArg, out: outArg, spa = false, kit: kitArg, backend: backendArg, exclude = [], core: inputCore }) {
  if (!distArg || !outArg) throw new CloudRuleError(400, 'usage', 'pack-frontend needs --dist and --out')
  const core = parseCorePin(inputCore)
  if (!core) throw new CloudRuleError(400, 'core_pin_invalid')
  const warnings = []
  let kit = null
  if (kitArg) {
    kit = await readJson(join(kitArg, 'kit.json'), 'kit')
    if (kit.coreVersion !== core.version || kit.coreRevision !== core.revision) throw new CloudRuleError(409, 'cli_core_mismatch', 'kit pins another Core')
  } else warnings.push('kit_not_checked: pass --kit <dir> so the contract hash and Core pin come from the downloaded kit')
  let sources, backendPath = null
  if (backendArg) {
    backendPath = await realpath(resolve(backendArg))
    const backend = await readJson(backendArg, 'backend')
    if (backend.sdkVersion !== core.version || backend.sdkRevision !== core.revision || !Array.isArray(backend.sources)) throw new CloudRuleError(409, 'cli_core_mismatch', 'backend artifact was packed for another Core')
    sources = backend.sources
  } else {
    warnings.push('backend_not_checked: pass --backend <backend.json> to compare YAML with the uploaded candidate')
    sources = await yamlSources(await realpath(resolve(projectArg)))
  }
  const ignored = []
  const assets = await readDist(distArg, ignored)
  const frontendText = serializeStaticArtifact(assets, { sdkRevision: core.revision, spa })
  // Compare real paths so a symlinked project or output path is still recognized.
  await mkdir(resolve(outArg), { recursive: true })
  const out = await realpath(resolve(outArg)), dist = await realpath(resolve(distArg)), projectRoot = await realpath(resolve(projectArg))
  // Build output, the backend artifact and this command's own output are not source.
  const own = [dist, out, ...backendPath ? [backendPath, backendPath + '.metafile.json'] : []]
    .filter(path => inside(projectRoot, path)).map(path => posix(relative(projectRoot, path)))
  const { files, excluded } = await readSource(projectRoot, [...exclude, ...own])
  const zip = canonicalSourceZip(files)
  inspectSourceArchive(zip, sources)
  const frontendBytes = new TextEncoder().encode(frontendText)
  const frontendPath = join(out, 'static-frontend.json'), sourcePath = join(out, 'source.zip')
  await writeFile(frontendPath, frontendBytes)
  await writeFile(sourcePath, zip)
  return { candidateId: kit?.candidateId ?? null, contractHash: kit?.contractHash ?? null, spa: Boolean(spa),
    frontend: { path: frontendPath, sha256: sha256(frontendBytes), bytes: frontendBytes.byteLength, assets: Object.keys(assets).length, ignored },
    source: { path: sourcePath, sha256: sha256(zip), bytes: zip.byteLength, files: Object.keys(files).length, excluded }, warnings }
}
