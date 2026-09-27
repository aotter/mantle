// Read-only git: rev-parse, status, ls-tree and cat-file only, without a shell,
// with system/global config, hooks, fsmonitor and prompts turned off. Paths
// come back NUL-separated, so no quoting or pathspec parsing is involved.
import { spawn } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { fail } from './output.mjs'
import { inside } from './files.mjs'

// `config` only ever runs as `config --null --get-regexp ^filter\.` (read-only), to neutralize filter drivers.
const commands = new Set(['rev-parse', 'status', 'ls-tree', 'cat-file', 'config'])
const hardening = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`, '-c', 'core.untrackedCache=false', '--no-pager', '--no-replace-objects']
const outputLimit = 128_000_000

function gitEnv() {
  const kept = Object.fromEntries(['PATH', 'Path', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  // No HOME: git reads no user config, credentials or includes from it.
  return { ...kept, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C' }
}

const executable = process.platform === 'win32' ? 'git.exe' : 'git'
const resolved = new Map()

/**
 * The absolute git binary from PATH, skipping relative entries and any directory
 * inside `project`: with the neutral working directory below, Windows can then
 * run neither a committed git.exe from the working directory nor one on a project PATH entry.
 */
export function gitBinary(project) {
  if (resolved.has(project)) return resolved.get(project)
  const found = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(dir => dir && isAbsolute(dir)).map(dir => {
    try {
      const real = realpathSync(dir)
      // Windows paths compare case-insensitively.
      if (process.platform === 'win32' ? inside(project.toLowerCase(), real.toLowerCase()) : inside(project, real)) return null
      const path = join(real, executable)
      if (!statSync(path).isFile()) return null
      if (process.platform !== 'win32') accessSync(path, constants.X_OK)
      return path
    } catch { return null }
  }).find(Boolean)
  if (!found) throw fail('git_unavailable', 'install git (outside the project) or pass --no-git')
  resolved.set(project, found)
  return found
}

// NUL-separated records, each strictly UTF-8: a path git stores in another encoding is refused, never guessed.
const utf8 = new TextDecoder('utf-8', { fatal: true })
function nulSeparated(bytes) {
  const records = []
  for (let at = 0; at < bytes.length;) {
    let end = bytes.indexOf(0, at)
    if (end < 0) end = bytes.length
    if (end > at) {
      try { records.push(utf8.decode(bytes.subarray(at, end))) }
      catch { throw fail('source_path_not_utf8', 'a tracked path is not valid UTF-8; rename it') }
    }
    at = end + 1
  }
  return records
}

/** Runs one allowed read-only git command against `project` and returns stdout bytes. */
export function git(project, args, input) {
  const command = args.find((arg, index) => args[index - 1] !== '-c' && !arg.startsWith('-'))
  if (!commands.has(command) || (command === 'config' && args.slice(args.indexOf('config')).join(' ') !== 'config --null --get-regexp ^filter\\.'))
    throw new Error('git command not allowed')
  const binary = gitBinary(project)
  return new Promise((done, reject) => {
    let child
    // A neutral working directory; the repository is named with -C.
    try { child = spawn(binary, [...hardening, '-C', project, ...args], { cwd: tmpdir(), env: gitEnv(), stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true }) }
    catch { reject(fail('git_unavailable')); return }
    const out = [], err = []
    let length = 0
    child.stdout.on('data', chunk => { length += chunk.length; if (length > outputLimit) child.kill(); else out.push(chunk) })
    child.stderr.on('data', chunk => { if (err.length < 64) err.push(chunk) })
    child.on('error', () => reject(fail('git_unavailable', 'install git or pass --no-git')))
    child.on('close', code => {
      if (length > outputLimit) reject(fail('source_archive_expansion_limit'))
      else if (code === 0) done(Buffer.concat(out))
      else reject(Object.assign(new Error('git failed'), { gitCode: code, stderr: Buffer.concat(err).toString('utf8').slice(0, 500) }))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

/** The repository top level and the project's prefix inside it. */
export async function repository(project) {
  let text
  try { text = (await git(project, ['rev-parse', '--show-toplevel', '--show-prefix'])).toString('utf8') }
  catch (error) {
    if (error.code) throw error
    if (/dubious ownership/.test(error.stderr ?? '')) throw fail('git_repository_unsafe', 'the repository is owned by another user; git refuses it without safe.directory, which this script does not read')
    throw fail('git_repository_missing', 'commit the project to Git, or pass --no-git to save an unversioned copy')
  }
  const [top, prefix = ''] = text.split('\n')
  return { top, prefix: prefix.replace(/\/$/, '') }
}

/** The HEAD commit as 40 or 64 hex characters. */
export async function headCommit(project) {
  let commit
  try { commit = (await git(project, ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'])).toString('utf8').trim() }
  catch (error) { if (error.code) throw error; throw fail('git_head_missing', 'commit the project first') }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw fail('git_head_missing')
  return commit
}

/**
 * `-c` overrides that switch off every filter driver the repository configures.
 * `status` would otherwise run a `filter.<name>.clean` command from repo config
 * (or an include) to compare a racily-clean file; blobs are read raw anyway.
 */
export async function filterOverrides(project) {
  let raw
  try { raw = await git(project, ['config', '--null', '--get-regexp', '^filter\\.']) }
  catch (error) { if (error.gitCode === 1) return []; throw error }
  const names = new Set(nulSeparated(raw).map(entry => entry.split('\n', 1)[0]).map(key => key.slice('filter.'.length, key.lastIndexOf('.'))))
  if ([...names].some(name => !name || /[=\s\u0000-\u001f\u007f]/.test(name))) throw fail('git_filter_unsafe', 'a filter driver name in the repository config cannot be switched off; remove it from .git/config')
  return [...names].flatMap(name => ['clean', 'smudge', 'process'].flatMap(key => ['-c', `filter.${name}.${key}=`]).concat(['-c', `filter.${name}.required=false`]))
}

/** Changed, staged and untracked non-ignored paths under `project`, bounded. */
export async function dirtyPaths(project) {
  // Line endings never count: uploads are HEAD's blobs, so a CRLF checkout of an LF blob is clean
  // whatever autocrlf setting made it (system and global config are not read). Submodules are
  // never entered: their own config could name filters, and gitlinks are refused from ls-tree first.
  const raw = await git(project, [...await filterOverrides(project), '-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false', '--no-literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all', '--no-renames', '--', '.', ':(exclude).mantle/host'])
  return nulSeparated(raw).map(entry => entry.slice(3))
}

/** Every entry of `<commit>:<path>` as { mode, type, oid, size, path }, paths relative to that tree. */
export async function listTree(project, commit, path) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw fail('git_head_missing')
  let raw
  try { raw = await git(project, ['ls-tree', '-r', '-z', '-l', '--full-tree', `${commit}:${path}`]) }
  catch (error) { if (error.code) throw error; throw fail('link_root_missing', path || '.') }
  return nulSeparated(raw).map(line => {
    const tab = line.indexOf('\t')
    const [mode, type, oid, size] = line.slice(0, tab).split(/ +/)
    return { mode, type, oid, size: size === '-' ? 0 : Number(size), path: line.slice(tab + 1) }
  })
}

/** Tracked paths under `<commit>:<prefix>` inside `dir` (for example `.mantle/host`). */
export async function trackedUnder(project, commit, prefix, dir) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw fail('git_head_missing')
  return nulSeparated(await git(project, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', '--full-tree', `${commit}:${prefix}`, '--', dir]))
}

/** HEAD entries (mode, oid) for exact repository-relative paths; missing paths are absent. */
export async function headEntries(project, commit, paths) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw fail('git_head_missing')
  if (!paths.length) return new Map()
  const raw = await git(project, ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', commit, '--', ...paths])
  return new Map(nulSeparated(raw).map(line => { const tab = line.indexOf('\t'), [mode, , oid] = line.slice(0, tab).split(' '); return [line.slice(tab + 1), { mode, oid }] }))
}

/** Raw blob bytes (no filters, no eol conversion) for `oids`, read by ONE `cat-file --batch` process. */
export async function readBlobs(project, oids) {
  const unique = [...new Set(oids)]
  if (!unique.length) return new Map()
  if (unique.some(oid => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))) throw fail('git_object_invalid')
  const out = await git(project, ['cat-file', '--batch'], unique.join('\n') + '\n')
  const blobs = new Map()
  let at = 0
  for (const oid of unique) {
    const end = out.indexOf(0x0a, at)
    const [name, type, size] = out.subarray(at, end).toString('utf8').split(' ')
    if (name !== oid || type !== 'blob') throw fail('git_object_invalid', oid)
    const start = end + 1, length = Number(size)
    blobs.set(oid, new Uint8Array(out.subarray(start, start + length)))
    at = start + length + 1
  }
  return blobs
}
