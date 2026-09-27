// The backend candidate from a snapshot: YAML from `manifests/**`, handlers
// bundled by the project's own esbuild. In Git mode every project file the
// bundle reads comes from its HEAD blob; only node_modules resolve from disk.
import { lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, sep } from 'node:path'
import { closedHandlers, handlerBuildOptions, serializeBackend, yamlSourcesFrom } from '../backend-artifact.mjs'
import { CloudRuleError, fail } from './output.mjs'
import { inside } from './files.mjs'

const loaders = { '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.json': 'json' }
const posix = path => path.split(sep).join('/')
// Files esbuild reads from disk while resolving; in Git mode each must be committed (tsconfig comes from HEAD).
const configNames = ['package.json', 'tsconfig.json', 'jsconfig.json']

// tsconfig is JSON with comments and trailing commas. One pass over tokens:
// strings are copied untouched, comments dropped, and a comma is dropped only
// when the next token closes an object or array.
export function parseJsonc(text) {
  let out = '', pendingComma = false
  for (let i = 0; i < text.length;) {
    const c = text[i]
    if (c === '"') {
      let end = i + 1
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
      if (end >= text.length) throw new SyntaxError('unterminated string')
      if (pendingComma) out += ','
      pendingComma = false
      out += text.slice(i, end + 1); i = end + 1; continue
    }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); if (end < 0) throw new SyntaxError('comment'); i = end + 2; continue }
    if (/\s/.test(c)) { out += c; i++; continue }
    if (c === ',') { if (pendingComma) throw new SyntaxError('comma'); pendingComma = true; i++; continue }
    if (pendingComma && c !== '}' && c !== ']') out += ','
    pendingComma = false
    out += c; i++
  }
  if (pendingComma) throw new SyntaxError('trailing comma')
  return JSON.parse(out)
}

/**
 * HEAD's app-root tsconfig.json (or jsconfig.json) as esbuild's tsconfigRaw. esbuild
 * would follow `extends` on disk, so only a package (resolved from node_modules,
 * a dependency like any other) may be extended; a relative or absolute file may not.
 */
export function headTsconfig(files) {
  const name = Object.hasOwn(files, 'tsconfig.json') ? 'tsconfig.json' : Object.hasOwn(files, 'jsconfig.json') ? 'jsconfig.json' : null
  if (!name) return '{}'
  const text = new TextDecoder().decode(files[name])
  let doc
  try { doc = parseJsonc(text.replace(/^\uFEFF/, '')) } catch { throw fail('handler_config_invalid', `${name} is not valid JSON`) }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw fail('handler_config_invalid', name)
  const extended = doc.extends === undefined ? [] : Array.isArray(doc.extends) ? doc.extends : [doc.extends]
  const local = extended.filter(value => typeof value !== 'string' || !value || /^[./\\]|^[A-Za-z]:|:/.test(value) || value.split(/[\\/]/).includes('..'))
  if (local.length) throw fail('handler_config_unsupported', `${name} extends ${local.map(String).join(', ')}; the handler bundle reads config from HEAD only, so extend a package or inline the options`)
  // The checked document, re-serialized: duplicate keys, escapes and comments cannot reach esbuild differently.
  return JSON.stringify(doc)
}

/** esbuild from the project; mantle-host never installs packages. */
export function projectEsbuild(appRoot) {
  try { return createRequire(join(appRoot, 'package.json'))('esbuild') }
  catch { throw fail('esbuild_missing', 'add esbuild as a devDependency of the project and install it') }
}

export async function bundleHandlers({ esbuild, top, appRoot, entry, files, omit = [] }) {
  let refusal = null
  const refuse = (code, detail) => { refusal ??= fail(code, detail); return { errors: [{ text: code }] } }
  const checked = new Set()
  // Every config file on the way from a loaded file up to the app root must be committed.
  const untrackedConfig = dir => {
    for (let at = dir; inside(appRoot, at) && !checked.has(at); at = dirname(at)) {
      checked.add(at)
      for (const name of configNames) {
        const rel = posix(relative(appRoot, join(at, name)))
        if (!Object.hasOwn(files, rel) && lstatSync(join(at, name), { throwIfNoEntry: false })) return rel
      }
      if (at === appRoot) break
    }
    return null
  }
  const plugin = { name: 'mantle-host-sources', setup(build) {
    build.onLoad({ filter: /.*/ }, args => {
      if (args.namespace !== 'file') return refuse('handler_input_unsupported', args.namespace)
      const path = args.path
      if (!inside(top, path)) return refuse('handler_input_outside_project', 'a file outside the project')
      const rel = posix(relative(appRoot, path)), inRoot = inside(appRoot, path)
      // Dependencies: under a node_modules directory of the project itself (not of an ancestor of it).
      const dependency = posix(relative(top, path)).split('/').includes('node_modules')
      const loader = loaders[extname(path).toLowerCase()]
      if (!files) return dependency || inRoot ? undefined : refuse('handler_input_outside_root', posix(relative(top, path)))
      // A committed file under node_modules is still part of HEAD: its blob is the input.
      if (dependency && !(inRoot && Object.hasOwn(files, rel))) return undefined
      if (!inRoot) return refuse('handler_input_outside_root', posix(relative(top, path)))
      if (!loader) return refuse('handler_input_unsupported', rel)
      if (omit.some(item => rel === item || rel.startsWith(item + '/'))) return refuse('handler_input_omitted', rel)
      if (!Object.hasOwn(files, rel)) return refuse('handler_input_untracked', rel)
      const config = untrackedConfig(dirname(path))
      if (config) return refuse('handler_config_untracked', config)
      return { contents: files[rel], loader }
    })
  } }
  if (files && !Object.hasOwn(files, entry)) throw fail('handler_input_untracked', entry)
  // In Git mode the TypeScript config is HEAD's, and esbuild reads no tsconfig or jsconfig from disk.
  const tsconfigRaw = files ? headTsconfig(files) : undefined
  let result
  try {
    // absWorkingDir keeps path comments relative, so two checkouts bundle to the same bytes.
    result = await esbuild.build({ ...handlerBuildOptions, entryPoints: [join(appRoot, ...entry.split('/'))], absWorkingDir: appRoot, plugins: [plugin],
      ...tsconfigRaw === undefined ? {} : { tsconfigRaw } })
  } catch (error) {
    if (refusal) throw refusal
    throw fail('handler_build_failed', String(error?.errors?.[0]?.text ?? 'esbuild failed').slice(0, 500))
  }
  if (refusal) throw refusal
  try { return closedHandlers(result) } catch { throw fail('backend_handlers_not_closed', 'the handler bundle must have no imports or dynamic imports') }
}

export async function packBackendSnapshot({ esbuild, top, appRoot, entry, files, git, omit, cliVersion, core }) {
  let sources
  try { sources = yamlSourcesFrom(files) }
  catch (error) { throw error instanceof CloudRuleError ? error : fail('manifest_invalid', error.message) }
  const handlers = await bundleHandlers({ esbuild, top, appRoot, entry, files: git ? files : null, omit })
  return serializeBackend({ sources, handlers, cliVersion, core })
}
