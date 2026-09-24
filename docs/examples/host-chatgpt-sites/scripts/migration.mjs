// Append a reviewed D1 migration only after the previous one is applied locally.
import { buildSqliteMigrationArtifact, splitSqlStatements } from '@aotter/mantle/runtime';
import { parseManifestSources, ValidateManifestsUseCase } from '@aotter/mantle/spec';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
const statePath='drizzle/meta/mantle-state.json';
const state=JSON.parse(await readFile(statePath,'utf8'));
const files=(await readdir('manifests')).filter(name=>/\.ya?ml$/i.test(name)).sort();
const parsed=parseManifestSources({sources:await Promise.all(files.map(async name=>({sourceId:name,text:await readFile(`manifests/${name}`,'utf8')})))});
if(!parsed.ok)throw Error(`Invalid manifest: ${parsed.diagnostics.map(d=>d.message).join('; ')}`);
const validated=ValidateManifestsUseCase.run({parsed:parsed.value});
if(validated.errorCount)throw Error(`Invalid manifest: ${validated.diagnostics.filter(d=>d.severity==='error').map(d=>d.message).join('; ')}`);
const target=parsed.value.entries.map(entry=>entry.manifest).filter(manifest=>manifest.kind==='Schema');
const artifact=await buildSqliteMigrationArtifact(state.schemas,target,{appliedMigrationIds:state.appliedMigrationIds});
if(artifact.sourceFingerprint!==state.fingerprint)throw Error('The saved migration source fingerprint is invalid. Restore the applied state before generating.');
if(artifact.destructive)throw Error('Destructive Schema change needs a reviewed migration; no D1 file was written.');
const unchanged=artifact.sourceFingerprint===artifact.targetFingerprint&&artifact.migrations.length===0;
const fingerprint=JSON.parse(await readFile('src/storage-fingerprint.json','utf8'));
if(fingerprint!==state.fingerprint)throw Error('Generated fingerprint and migration source disagree. Restore the reviewed migration state.');
if(process.argv.includes('--check')){
  if(!unchanged)throw Error('Pending Schema or runtime migration. Run node scripts/migration.mjs and review the new D1 file.');
  process.exit(0);
}
const output=execFileSync('node',['node_modules/wrangler/bin/wrangler.js','d1','execute','mantle-sites-reference-local','--local','--command','SELECT fingerprint FROM _mantle_storage_state WHERE id = 1','--json'],{encoding:'utf8'});
const active=JSON.parse(output)[0]?.results?.[0]?.fingerprint;
if(active!==state.fingerprint)throw Error(`Local D1 fingerprint ${active??'(missing)'} does not match the last migration ${state.fingerprint}. Apply pending D1 migrations first.`);
const versionOutput=execFileSync('node',['node_modules/wrangler/bin/wrangler.js','d1','execute','mantle-sites-reference-local','--local','--command',"SELECT name FROM sqlite_schema WHERE type='table' AND name='_mantle_managed_runtime_state'",'--json'],{encoding:'utf8'});
const versionTable=JSON.parse(versionOutput)[0]?.results?.[0]?.name;
const version=versionTable?(JSON.parse(execFileSync('node',['node_modules/wrangler/bin/wrangler.js','d1','execute','mantle-sites-reference-local','--local','--command','SELECT canonical_version FROM _mantle_managed_runtime_state WHERE id = 1','--json'],{encoding:'utf8'}))[0]?.results?.[0]?.canonical_version??null):null;
if(version!==null&&version!==state.canonicalVersion)throw Error(`Local D1 runtime version ${version} does not match migration source ${state.canonicalVersion}.`);
if(version===null&&state.canonicalVersion!=='0005-store-instance-id')throw Error('Local D1 is missing the managed runtime version marker. Apply pending migrations first.');
if(unchanged){console.log('D1 migrations are current.');process.exit(0);}
const quote=value=>`'${value.replaceAll("'","''")}'`;
const sql=[
  ...artifact.migrations.flatMap(m=>splitSqlStatements(m.sql).map(s=>s+';')),
  ...artifact.projections.map(p=>`INSERT INTO _mantle_schema_tables(name,projection) VALUES (${quote(p.name)},${quote(p.projection)}) ON CONFLICT(name) DO UPDATE SET projection=excluded.projection;`),
  `INSERT INTO _mantle_managed_runtime_state(id,canonical_version) VALUES (1,${version===null?quote(artifact.targetCanonicalVersion):`(SELECT CASE WHEN canonical_version=${quote(state.canonicalVersion)} THEN ${quote(artifact.targetCanonicalVersion)} ELSE NULL END FROM _mantle_managed_runtime_state WHERE id=1)`}) ON CONFLICT(id) DO UPDATE SET canonical_version=excluded.canonical_version;`,
  `INSERT INTO _mantle_storage_state(id,fingerprint) VALUES (1,(SELECT CASE WHEN fingerprint=${quote(artifact.sourceFingerprint)} THEN ${quote(artifact.targetFingerprint)} ELSE NULL END FROM _mantle_storage_state WHERE id=1)) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint;`,
].join('\n--> statement-breakpoint\n')+'\n';
const index=state.lastIndex+1;
const path=`drizzle/${String(index).padStart(4,'0')}_mantle.sql`;
const journalPath='drizzle/meta/_journal.json';
const journal=JSON.parse(await readFile(journalPath,'utf8'));
if(journal.entries.at(-1)?.idx!==state.lastIndex)throw Error('Drizzle journal does not match the saved migration state.');
await writeFile(path,sql,{flag:'wx'});
await writeFile(journalPath,JSON.stringify({...journal,entries:[...journal.entries,{idx:index,version:'6',when:Date.now(),tag:`${String(index).padStart(4,'0')}_mantle`,breakpoints:true}]})+'\n');
await writeFile(statePath,JSON.stringify({fingerprint:artifact.targetFingerprint,canonicalVersion:artifact.targetCanonicalVersion,schemas:target,appliedMigrationIds:[...new Set([...state.appliedMigrationIds,...artifact.migrations.map(m=>m.id)])],lastIndex:index},null,2)+'\n');
await writeFile('src/storage-fingerprint.json',JSON.stringify(artifact.targetFingerprint)+'\n');
console.log(`Review ${path}, then apply it with wrangler d1 migrations apply mantle-sites-reference-local --local.`);
