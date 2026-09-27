// Bundles src/host into ONE deterministic file, dist/mantle-host.mjs, plus its
// SHA-256. fflate and es-module-lexer are inlined; esbuild stays external and
// is resolved from the user's project at runtime.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const pluginDir = fileURLToPath(new URL('../../../skills/mantle-host/scripts/', import.meta.url))

export async function buildHost(outDir = pluginDir) {
  const result = await build({ entryPoints: ['src/host/entry.mjs'], absWorkingDir: packageDir, bundle: true, write: false,
    platform: 'node', format: 'esm', target: 'node22', external: ['esbuild'], legalComments: 'inline', charset: 'utf8', logLevel: 'silent',
    outfile: 'mantle-host.mjs', banner: { js: '// mantle-host: generated from packages/mantle-host/src/host by scripts/build-host.mjs. Do not edit.' } })
  const [file] = result.outputFiles
  const sha256 = createHash('sha256').update(file.contents).digest('hex')
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'mantle-host.mjs'), file.contents)
  if (outDir !== pluginDir) await writeFile(join(outDir, 'mantle-host.mjs.sha256'), `${sha256}  mantle-host.mjs\n`)
  return { path: join(outDir, 'mantle-host.mjs'), sha256, bytes: file.contents.byteLength }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] === '--out' ? resolve(process.argv[3]) : undefined
  process.stdout.write(JSON.stringify(await buildHost(out)) + '\n')
}
