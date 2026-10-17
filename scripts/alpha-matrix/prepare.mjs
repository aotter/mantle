// Materialize consumers outside the SDK: exact tarballs, real presets, no source aliases.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, join, relative, isAbsolute, sep } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
const sdk=resolve(import.meta.dirname,'../..'), root=resolve(process.argv[2]??'');
const physical=input=>{let found=resolve(input),tail=[];while(!existsSync(found)){const parent=dirname(found);if(parent===found)return found;tail.unshift(basename(found));found=parent;}return resolve(realpathSync(found),...tail);};
const inside=(outer,inner)=>{const path=relative(physical(outer),physical(inner));return path===''||path!=='..'&&!path.startsWith(`..${sep}`)&&!isAbsolute(path);};
if(!process.argv[2]||inside(sdk,root))throw Error('Pass a new consumer directory outside the SDK');
if(existsSync(root))throw Error('Consumer directory already exists; preserve its data and run E2E there directly');
if(!process.env.BUN_PG_URL||!process.env.CF_PG_URL)throw Error('Set BUN_PG_URL and CF_PG_URL to two separate disposable PostgreSQL databases');
const run=(cmd,args,cwd)=>execFileSync(cmd,args,{cwd,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
const version=JSON.parse(readFileSync(join(sdk,'package.json'))).version;
mkdirSync(join(root,'artifacts'),{recursive:true});
for(const pkg of ['mantle','mantle-ui'])run('pnpm',['-C',join(sdk,'packages',pkg),'pack','--pack-destination',join(root,'artifacts')],sdk);
const pkg=JSON.parse(readFileSync(join(sdk,'docs/examples/reference-service/package.json')));
pkg.name='mantle-alpha-acceptance';pkg.scripts={};
pkg.dependencies={...pkg.dependencies,'@aotter/mantle':`file:artifacts/aotter-mantle-${version}.tgz`,'@aotter/mantle-ui':`file:artifacts/aotter-mantle-ui-${version}.tgz`,pg:'8.23.1',yaml:'2.9.0'};
pkg.devDependencies={...pkg.devDependencies,'@types/pg':'8.20.0','bun-types':'1.3.14',playwright:'1.63.0'};
pkg.pnpm={peerDependencyRules:{allowAny:['@aotter/mantle']}};
writeFileSync(join(root,'package.json'),JSON.stringify(pkg,null,2)+'\n');
for(const file of ['author.ts','e2e.mjs','extras.mjs'])copyFileSync(join(import.meta.dirname,file),join(root,file));
const installEnv={...process.env,WRANGLER_SEND_METRICS:'false'};delete installEnv.BUN_PG_URL;delete installEnv.CF_PG_URL;
execFileSync('pnpm',['install','--no-frozen-lockfile'],{cwd:root,stdio:'inherit',env:installEnv});
const bunPg=process.env.BUN_PG_URL, cfPg=process.env.CF_PG_URL;
mkdirSync(join(root,'manifests'));run('bun',['author.ts'],root);
const handler=`import type { MantleHandlers } from "../.mantle/generated/mantle.js";
import type { CallerStore } from "@aotter/mantle";
export const handlers: MantleHandlers = {
  seedLocal: async (input, ctx) => {
    // Local owner-only importer; Store validates dynamic rows. Chunk below the IR work budget.
    for (let i = 0; i < input.rows.length; i += 10)
      await (ctx.store as unknown as CallerStore).write(input.rows.slice(i, i + 10).map(row => ({ insert: input.collection, id: row.id, values: row.values, onConflict: "ignore" })));
    return { count: input.rows.length };
  },
};
`;
for(const [i,[name,host,dialect]] of [['bun-sqlite','bun','sqlite'],['bun-postgres','bun','postgres'],['cf-sqlite','cloudflare','sqlite'],['cf-postgres','cloudflare','postgres']].entries()) {
 const dir=join(root,name);mkdirSync(join(dir,'manifests'),{recursive:true});
 const sub={...pkg,name:`acceptance-${name}`,dependencies:{...pkg.dependencies,'@aotter/mantle':`file:../artifacts/aotter-mantle-${version}.tgz`,'@aotter/mantle-ui':`file:../artifacts/aotter-mantle-ui-${version}.tgz`}};
 writeFileSync(join(dir,'package.json'),JSON.stringify(sub,null,2)+'\n');
 writeFileSync(join(dir,'mantle.config.json'),JSON.stringify({version:2,host,dialect,identity:'mantle',features:['mcp','admin','web']})+'\n');
 symlinkSync('../node_modules',join(dir,'node_modules'));
 copyFileSync(join(root,'manifests/procurement.yaml'),join(dir,'manifests/procurement.yaml'));
 run('bun',['../node_modules/@aotter/mantle/dist/cli/main.js','generate'],dir);
 writeFileSync(join(dir,'src/handlers.ts'),handler);
 const port=4421+i, env=`PUBLIC_ORIGIN=http://127.0.0.1:${port}\nADMIN_EMAIL=owner@alpha.test\nBETTER_AUTH_SECRET=${randomBytes(32).toString('hex')}\nPORT=${port}\n`+(name==='bun-postgres'?`DATABASE_URL=${bunPg}\n`:'');
 writeFileSync(join(dir,host==='bun'?'.env':'.dev.vars'),env,{mode:0o600});
 if(name==='cf-postgres') {const path=join(dir,'wrangler.jsonc'),config=JSON.parse(readFileSync(path));config.hyperdrive[0].localConnectionString=cfPg;writeFileSync(path,JSON.stringify(config,null,2)+'\n');chmodSync(path,0o600);}
 run('bun',['../node_modules/@aotter/mantle/dist/cli/main.js','generate','--check'],dir);
 run('../node_modules/.bin/tsc',['--noEmit'],dir);
}
writeFileSync(join(root,'provenance.json'),JSON.stringify({sdkRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:sdk,encoding:'utf8'}).trim(),packageVersion:version,artifacts:Object.fromEntries(['mantle','mantle-ui'].map(name=>{const file=`aotter-${name}-${version}.tgz`;return [file,createHash('sha256').update(readFileSync(join(root,'artifacts',file))).digest('hex')];})),consumerLockSha256:createHash('sha256').update(readFileSync(join(root,'pnpm-lock.yaml'))).digest('hex')},null,2)+'\n');
console.log(`Prepared ${root}; follow the host launch commands in scripts/alpha-matrix/README.md`);
