import { fileURLToPath } from 'node:url'
import { main } from './main.mjs'

// The printed commands name this file, which is the bundle once built.
process.exitCode = await main(process.argv.slice(2), { scriptPath: fileURLToPath(import.meta.url) })
