// The only filesystem writes: `.mantle/host/**`, `.mantle/hosting.json` and an
// appended `.gitignore` line, each under the project realpath. Every segment is
// checked with lstat so a committed symlink cannot redirect a write or a read.
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { appendFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { fail } from './output.mjs'

/** A committed relative path: posix, no empty, `.` or `..` segments, no drive, backslash or control characters. */
export function safeRelative(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') return false
  if (value === '' || value === '.') return allowEmpty
  return value.length <= 200 && value === value.normalize('NFC') && !/[\\:\u0000-\u001f\u007f]/.test(value) &&
    !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..')
}
const normalized = value => value === '.' ? '' : value.replace(/\/+$/, '')
export const joinRelative = (...parts) => parts.map(part => normalized(part ?? '')).filter(Boolean).join('/')

// Each existing segment must be a real directory (or, for the last, `kind`).
async function walk(project, rel, create) {
  let path = project
  const parts = rel.split('/').filter(Boolean)
  for (const part of parts) {
    path = join(path, part)
    const stat = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (stat && !stat.isDirectory()) throw fail('host_path_unsafe', rel)
    if (!stat) { if (!create) return null; await mkdir(path) }
  }
  return path
}

export const ensureDir = (project, rel) => walk(project, rel, true)

/** Reads a regular file under the project; null when it does not exist. */
export async function readInside(project, rel, limit) {
  const parts = rel.split('/')
  const dir = await walk(project, parts.slice(0, -1).join('/'), false)
  if (!dir) return null
  const path = join(dir, parts.at(-1))
  const stat = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (!stat) return null
  if (!stat.isFile()) throw fail('host_path_unsafe', rel)
  if (stat.size > limit) throw fail('host_file_too_large', rel)
  return new Uint8Array(await readFile(path))
}

/** Writes via a fresh temporary file and rename, so readers never see half a file. */
export async function writeAtomic(project, rel, bytes, mode = 0o644) {
  const parts = rel.split('/')
  const dir = await ensureDir(project, parts.slice(0, -1).join('/'))
  const path = join(dir, parts.at(-1)), temporary = `${path}.${randomUUID()}.tmp`
  const stat = await lstat(path).catch(() => null)
  if (stat && !stat.isFile()) throw fail('host_path_unsafe', rel)
  await writeFile(temporary, bytes, { flag: 'wx', mode })
  try { await rename(temporary, path) } catch (error) { await rm(temporary, { force: true }); throw error }
  return path
}

/** Appends to a regular file (never through a symlink), creating it when missing. */
export async function appendInside(project, rel, text) {
  const parts = rel.split('/')
  const path = join(await ensureDir(project, parts.slice(0, -1).join('/')), parts.at(-1))
  const stat = await lstat(path).catch(() => null)
  if (stat && !stat.isFile()) throw fail('host_path_unsafe', rel)
  await appendFile(path, text, { flag: constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) })
}

/** Empties one directory the script owns, then recreates it. */
export async function resetDir(project, rel) {
  const path = await ensureDir(project, rel)
  await rm(path, { recursive: true, force: true })
  await mkdir(path)
  return path
}

export const inside = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
