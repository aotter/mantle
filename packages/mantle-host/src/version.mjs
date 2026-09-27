import pkg from '../package.json' with { type: 'json' }
import core from './core.json' with { type: 'json' }

export const cliPackage = pkg.name
export const cliVersion = pkg.version
/** The agent-facing tool: a bundled script shipped in Mantle Core's root plugin. */
export const hostName = 'mantle-host'
/** How Cloud MCP descriptions and the kit name the tool; the script prints its own literal path. */
export const hostCommand = `${hostName} (the mantle plugin script; see the ${hostName} skill)`
/** How an outdated script is replaced: the plugin, or the skills CLI fallback that carries the same file. */
export const updateHost = `Update the mantle plugin, or re-run \`npx skills add aotter/mantle --skill ${hostName}\`.`
/** The Mantle Core release this package packs for; Cloud rejects any other. */
export const corePin = Object.freeze({ version: core.version, revision: core.revision })
