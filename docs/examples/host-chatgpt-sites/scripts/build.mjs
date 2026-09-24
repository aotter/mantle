import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await rm('dist',{recursive:true,force:true});
execFileSync('node',['node_modules/@aotter/mantle/dist/cli/main.js','generate'],{stdio:'inherit'});
// Reject older published SDKs that cannot advertise the mounted MCP endpoints.
execFileSync('node',['node_modules/typescript/bin/tsc','--noEmit'],{stdio:'inherit'});
await mkdir('dist/server',{recursive:true});
await build({entryPoints:['src/index.ts'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',conditions:['workerd'],target:'es2022',external:['cloudflare:*','node:*'],minify:true});
await cp('public','dist/client',{recursive:true});
await mkdir('dist/.openai',{recursive:true});
await cp('.openai/hosting.json','dist/.openai/hosting.json');
await cp('drizzle','dist/.openai/drizzle',{recursive:true});
