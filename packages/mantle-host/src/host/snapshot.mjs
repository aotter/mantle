// The project files a save uploads. In Git mode they are HEAD's objects under
// the app root (never the working tree, never `git archive`), so CRLF
// checkouts, export-ignore and filters cannot change a byte; `.gitignore`
// decides what is source. `--no-git` reads the working tree with the same rules.
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { readSource } from '../pack.mjs'
import { omittablePath, secretSourcePath, sourceEntryLimit, sourceExpandedLimit, sourcePathKey } from '../source-zip.mjs'
import { dirtyPaths, headCommit, headEntries, listTree, readBlobs, repository, trackedUnder } from './git.mjs'
import { fail } from './output.mjs'
import { inside, joinRelative } from './files.mjs'

const listing = paths => paths.slice(0, 20).join(', ') + (paths.length > 20 ? ` and ${paths.length - 20} more` : '')
const covered = (path, list) => list.some(item => path === item || path.startsWith(item + '/'))

/** Normalized, sorted `--omit` paths (relative to the app root). */
export function normalizeOmit(values = []) {
  const list = [...new Set(values.map(value => String(value).replace(/^\.\/+/, '').replace(/\/+$/, '')))]
  // The same rule Cloud applies to `omitted`, so any tracked path an archive cannot hold can still be left out.
  if (list.length > 100 || list.some(value => !omittablePath(value))) throw fail('omit_invalid', 'each --omit is a relative path inside the app root (NFC, no .. or control characters), at most 100')
  return list.sort()
}

/** Absolute real path of the app root, which must stay inside the project. */
export async function appRootOf(project, root) {
  const path = join(project, ...root.split('/').filter(Boolean))
  let real
  try { real = await realpath(path) } catch { throw fail('link_root_missing', root || '.') }
  if (!inside(project, real) || !(await lstat(real)).isDirectory()) throw fail('link_root_outside_project', root)
  return real
}

async function currentHead(project, commit) {
  const head = await headCommit(project)
  if (commit && head !== commit) throw fail('head_changed', `HEAD is ${head}; this save started at ${commit}`)
  return head
}

async function refuseDirty(project) {
  const dirty = await dirtyPaths(project)
  if (dirty.length) throw fail('worktree_dirty', listing(dirty))
}

/** Refuses the tree unless HEAD matches `commit` (when given) and nothing under the project is changed or untracked. */
export async function cleanHead(project, commit) {
  const head = await currentHead(project, commit)
  const dirty = await dirtyPaths(project)
  if (dirty.length) throw fail('worktree_dirty', listing(dirty))
  return head
}

export async function gitSnapshot(project, { root, omit, commit: expected }) {
  const { top, prefix } = await repository(project)
  const commit = await currentHead(project, expected)
  // State and output are local; committing them would make every save dirty itself.
  const hostFiles = await trackedUnder(project, commit, prefix, '.mantle/host')
  if (hostFiles.length) throw fail('host_state_tracked', listing(hostFiles))
  // Gitlinks and symlinks are refused from HEAD's tree before git status looks at the working tree.
  const entries = await listTree(project, commit, joinRelative(prefix, root))
  const submodules = entries.filter(entry => entry.mode === '160000').map(entry => entry.path)
  if (submodules.length) throw fail('submodule_unsupported', listing(submodules))
  const links = entries.filter(entry => entry.mode === '120000').map(entry => entry.path)
  if (links.length) throw fail('symlink_unsupported', listing(links))
  await refuseDirty(project)
  const blobs = entries.filter(entry => entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755'))
  const unmatched = omit.filter(item => !blobs.some(entry => covered(entry.path, [item])))
  if (unmatched.length) throw fail('omit_unmatched', listing(unmatched))
  const kept = blobs.filter(entry => !covered(entry.path, omit))
  const secrets = kept.filter(entry => secretSourcePath(entry.path)).map(entry => entry.path)
  if (secrets.length) throw fail('source_archive_secret_path', listing(secrets))
  const keys = new Map()
  for (const { path } of kept) {
    let key
    try { key = sourcePathKey(path) } catch (error) { throw error.code === 'source_archive_path_invalid' ? fail('source_archive_path_invalid', `${path}: an archive path cannot hold % : # ? \\ or control characters; rename it or pass --omit`) : error }
    if (keys.has(key)) throw fail('source_archive_duplicate_path', `${keys.get(key)} and ${path}`)
    keys.set(key, path)
  }
  const bytes = kept.reduce((sum, entry) => sum + entry.size, 0)
  if (kept.length > sourceEntryLimit || bytes > sourceExpandedLimit)
    throw fail('source_archive_expansion_limit', `${kept.length} files, ${bytes} bytes; the limit is ${sourceEntryLimit} files and ${sourceExpandedLimit} bytes`)
  const read = await readBlobs(project, kept.map(entry => entry.oid))
  const files = Object.create(null)
  for (const entry of kept) files[entry.path] = read.get(entry.oid)
  const realTop = await realpath(top)
  await ancestorPackages(project, { top: realTop, appRoot: await realpath(join(project, ...root.split('/').filter(Boolean))), commit })
  return { commit, top: realTop, files }
}

// esbuild reads package.json (browser, imports, exports) in every directory above
// the files it bundles, so the app root's ancestors are handler inputs too: inside
// the repository each must be committed and unchanged; above it none may carry
// resolution fields. Nested tsconfig/jsconfig files are ignored (tsconfigRaw).
const resolutionFields = ['browser', 'imports', 'exports']
async function ancestorPackages(project, { top, appRoot, commit }) {
  const inRepo = [], outside = []
  for (let dir = dirname(appRoot), last = appRoot; dir !== last; last = dir, dir = dirname(dir)) {
    const path = join(dir, 'package.json')
    if (!(await lstat(path).catch(() => null))) continue
    if (inside(top, dir)) inRepo.push(path); else outside.push(path)
  }
  for (const path of outside) {
    // Fails closed: a file this check cannot read or parse might still steer esbuild.
    let doc = null
    try { doc = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) } catch { doc = null }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw fail('handler_config_outside_project', `${path} cannot be checked (not a JSON object); move the project or fix that file`)
    if (resolutionFields.some(field => Object.hasOwn(doc, field)))
      throw fail('handler_config_outside_project', `${path} sets ${resolutionFields.filter(field => Object.hasOwn(doc, field)).join(', ')}, which would change how the handlers resolve`)
  }
  if (!commit || !inRepo.length) return
  const rels = inRepo.map(path => relative(top, path).split(sep).join('/'))
  const head = await headEntries(project, commit, rels)
  const missing = rels.filter(rel => head.get(rel)?.mode !== '100644' && head.get(rel)?.mode !== '100755')
  if (missing.length) throw fail('handler_config_untracked', listing(missing))
  const blobs = await readBlobs(project, rels.map(rel => head.get(rel).oid))
  // Line endings aside (a CRLF checkout of the same blob), the disk must hold HEAD's bytes.
  const text = bytes => Buffer.from(bytes).toString('utf8').replaceAll('\r\n', '\n')
  const changed = []
  for (const [index, rel] of rels.entries()) if (text(await readFile(inRepo[index])) !== text(blobs.get(head.get(rel).oid))) changed.push(rel)
  if (changed.length) throw fail('worktree_dirty', listing(changed))
}

/** `--no-git`: the working tree minus .git, node_modules, .wrangler, the host directory, dist and `--omit`. */
export async function diskSnapshot(project, appRoot, { omit, dist }) {
  const own = [join(project, '.mantle', 'host'), dist].filter(Boolean).filter(path => inside(appRoot, path) && path !== appRoot)
    .map(path => relative(appRoot, path).split(sep).join('/'))
  const { files } = await readSource(appRoot, [...omit, ...own])
  if (Object.keys(files).length > sourceEntryLimit) throw fail('source_archive_expansion_limit')
  await ancestorPackages(project, { top: project, appRoot, commit: null })
  return { commit: 'unversioned', top: project, files }
}
