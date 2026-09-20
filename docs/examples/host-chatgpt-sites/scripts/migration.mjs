// One-time, reviewable initial migration from Mantle's public migration planner.
import { buildSqliteMigrationArtifact, splitSqlStatements } from '@aotter/mantle/runtime';
import { plan } from '../.mantle/generated/mantle.ts';
import { writeFile } from 'node:fs/promises';
const artifact=await buildSqliteMigrationArtifact([],Object.values(plan.schemas).map(s=>s.manifest));
const quote=value=>`'${value.replaceAll("'","''")}'`;
const sql=[...artifact.migrations.flatMap(m=>splitSqlStatements(m.sql).map(s=>s+';')),...artifact.projections.map(p=>`INSERT INTO _mantle_schema_tables(name,projection) VALUES (${quote(p.name)},${quote(p.projection)});`),`INSERT INTO _mantle_storage_state(id,fingerprint) VALUES (1,${quote(artifact.targetFingerprint)});`].join('\n--> statement-breakpoint\n');
await writeFile('drizzle/0001_mantle.sql',sql);
await writeFile('src/storage-fingerprint.json',JSON.stringify(artifact.targetFingerprint)+'\n');
