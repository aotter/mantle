import { expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { SQL } from 'bun';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { userCaller } from '../src/kernel/user-caller.js';
import { hasRole, fieldsOf } from '../src/kernel/caller-identity.js';
import { userBinds, modeOf, userRefs, isAll, scopeInsert } from '../src/kernel/user-fields.js';
import { binds } from '../src/kernel/binds.js';
import { renderTerm } from '../src/kernel/store.js';
import { dialect } from '../src/kernel/dialect/sqlite.js';
import { isAdmin, hasAdminRole } from '../src/kernel/contracts.js';
import { generateOrThrow, writeGenerated } from './apps/link.js';
import { compilePlan, compileProgram, d1Dialect, postgresCompiler, postgresDialect, rowPolicy, sqliteCompiler } from '../src/build/compiler.js';
await mkdir(resolve(import.meta.dir, 'apps/.generated'), { recursive: true });
const fields = { region: { type: 'string' as const, multiple: true }, tier: { type: 'string' as const, multiple: false } };
test('row mode is required and caller visibility is admin visibility', () => {
  const s = { publishing: true }, ctx = { dialect: d1Dialect, schemas: {}, inputs: {}, kind: 'view' as const };
  expect(rowPolicy(s, 'caller')).toEqual(rowPolicy(s, 'admin'));
  expect(rowPolicy(s, 'caller')).toContainEqual(['status', 'admin', { k: 'admin' }, 'published']);
  // @ts-expect-error A missing mode must never acquire caller visibility.
  expect(() => rowPolicy(s)).toThrow('explicit row mode');
  if (false) {
    // @ts-expect-error Compilation also requires an explicit mode.
    compileProgram([], ctx);
  }
});
test('verified identities freeze values, discard unknown fields and lose authority when copied', () => {
  const caller = userCaller({ id: 'member', role: 'vip,editor,vip', region: ['TW', 'TW'], tier: 'gold', ignored: 'secret' }, { fields, adminRoles: ['editor'] });
  expect(caller.roles).toEqual(['vip', 'editor']); expect(fieldsOf(caller)).toEqual({ region: ['TW'], tier: 'gold' });
  expect(isAdmin(caller)).toBe(true); expect(hasAdminRole(caller, 'editor')).toBe(true); expect(hasRole(caller, 'vip')).toBe(true);
  const copy = { ...caller }; expect(isAdmin(copy)).toBe(false); expect(hasRole(copy, 'vip')).toBe(false); expect(fieldsOf(copy)).toEqual({});
  expect(Object.isFrozen(caller)).toBe(true); expect(Object.isFrozen(caller.roles)).toBe(true); expect(Object.isFrozen(caller.fields)).toBe(true); expect(Object.isFrozen(caller.fields!.region)).toBe(true);
  expect(modeOf({ kind: 'system', reason: 'fixture' })).toBe('trusted'); expect(() => modeOf({ kind: 'future' } as never)).toThrow('Unknown caller');
  for (const value of ['', '\0', '\uD800', 'x'.repeat(257), Array(65).fill('TW'), true, Infinity])
    expect(() => userCaller({ id: 'bad', region: value }, { fields })).toThrow();
  for (const value of ['NULL', 'null', '  TW  ', '},{', 'q"u\\o,te{}', 'x'.repeat(256), '界'.repeat(85), Array.from({ length: 64 }, (_, i) => String(i))])
    expect(() => userCaller({ id: 'ok', region: value }, { fields })).not.toThrow();
  expect(() => userCaller({ id: 'bad', region: '界'.repeat(86) }, { fields })).toThrow();
  expect(() => userCaller({ id: 'host:bad' })).toThrow();
  expect(() => userRefs(true, 2)).toThrow('version');
  expect(() => binds({userRefs:userRefs(true, 1)},[{k:'future'}] as never,caller)).toThrow('Unknown user-reference');
  expect(() => renderTerm(dialect,['region','future',{k:'uid'}] as never,'r.','?1')).toThrow('Unknown row-policy');
  const recipe = { k: 'user' as const, field: 'region', type: 'string' as const, multiple: true };
  expect(() => userBinds(true)(recipe, { kind: 'anonymous' })).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  expect(() => userBinds(false)(recipe, userCaller({ id: 'empty', region: [] }, { fields }))).toThrow(expect.objectContaining({ code: 'AUTH_DENIED' }));
  const every = userCaller({ id: 'every', region: { all: true } }, { fields }); expect(isAll(every, 'region')).toBe(true); expect(isAll({ ...every }, 'region')).toBe(false);
  expect(() => userBinds(true)(recipe, every)).toThrow('does not lift a restrict');
  expect(() => userCaller({ id: 'bad', tier: ['gold'] }, { fields })).toThrow('one value');
  expect(userBinds(false)(recipe, userCaller({ id: 'odd', region: ['NULL', '},{', 'q"u\\o'] }, { fields }))).toBe('{"NULL","},{","q\\"u\\\\o"}');
});

const schema = JSON.stringify({ apiVersion: 'cms.mantle.aotter.net/v2', kind: 'Schema', metadata: { name: 'orders' }, spec: { title: 'Orders', schema: { type: 'object', required: ['region', 'tier'], properties: { region: { type: 'string' }, tier: { type: 'string' } } }, indexes: [['region', 'id']] } });
const view = (name: string, sql: string, restrict?: Record<string, string>) => JSON.stringify({ apiVersion: 'cms.mantle.aotter.net/v2', kind: 'View', metadata: { name }, spec: { surface: 'internal', sql, ...(restrict ? { restrict } : {}) } });
const code = (run: () => Promise<unknown>) => run().then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
test('restricted Procedure INSERT variants refuse caller compilation while trusted inserts and owner scope still work', async () => {
  const procedure = (sql: string, restrict?: Record<string, string>) => JSON.stringify({ apiVersion: 'cms.mantle.aotter.net/v2', kind: 'Procedure', metadata: { name: 'seed' }, spec: { title: 'Seed', input: { type: 'object', additionalProperties: false }, output: { type: 'object' }, ...(restrict ? { restrict } : {}), handler: { sql } } });
  const sqls = ["INSERT INTO orders(region,tier) VALUES ('TW','gold') RETURNING id", "INSERT INTO orders(region,tier) SELECT region,'copy' FROM orders RETURNING id", "INSERT INTO orders(region,tier) VALUES ('TW','gold') ON CONFLICT(id) DO NOTHING RETURNING id"];
  const db = new Database(':memory:');
  try {
    db.exec((await generateOrThrow('bun-sqlite', [{ sourceId: 'orders.yaml', text: schema }]))['schema.sql']!);
    for (const postgres of [false, true]) for (const restrict of [{ orders: "region IN auth.user('region')" }]) for (const sql of sqls) {
      const result = await compilePlan({ sources: [{ sourceId: 'insert.yaml', text: schema+'\n---\n'+procedure(sql, restrict) }] }, postgres ? postgresCompiler : sqliteCompiler, 'operational');
      if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
      const p = result.plan.procedures.seed!;
      if (!('sql' in p.handler)) throw Error('Expected SQL Procedure');
      const { stmts } = p.handler.sql;
      const ctx = { dialect: postgres ? postgresDialect() : d1Dialect, schemas: result.plan.schemas, inputs: p.inputs, kind: 'procedure' as const, restrict: p.restrict };
      expect(() => compileProgram(stmts, { ...ctx, mode: 'caller' })).toThrow(expect.objectContaining({ code: 'USER_FIELD_POSITION', message: expect.stringContaining('use its scoped Store') }));
      const [trusted] = compileProgram(stmts, { ...ctx, mode: 'trusted' });
      expect(trusted!.verb).toBe('insert');
      if (!postgres) expect(db.query(ctx.dialect.print!(trusted!.ast, ctx.schemas)).all(...binds(dialect, trusted!.binds as Parameters<typeof binds>[1], { kind: 'system', reason: 'fixture' }, {}) as SQLQueryBindings[])).not.toHaveLength(0);
    }
  } finally { db.close(); }
  const owned = JSON.parse(schema); owned.spec.scope = 'owner = auth.uid()';
  owned.spec.schema.properties.owner = { type: 'string' }; owned.spec.schema.required.push('owner'); owned.spec.indexes = [['owner', 'region', 'id']];
  const files = await generateOrThrow('bun-sqlite', [{ sourceId: 'owner.yaml', text: JSON.stringify(owned)+'\n---\n'+procedure(sqls[0]!) }]);
  const dir = await mkdtemp(resolve(import.meta.dir, 'apps/.generated/owner-insert-')), ownerDb = new Database(':memory:');
  try {
    await writeGenerated(dir, files); const app = await import(resolve(dir, 'generated.ts')); ownerDb.exec(files['schema.sql']!);
    const caller = userCaller({ id: 'owner' });
    expect((await app.procedures.seed(ownerDb, caller, {})).results[0]).toHaveLength(1);
    expect(ownerDb.query('SELECT owner,author_id FROM orders').all()).toEqual([{ owner: 'owner', author_id: 'owner' }]);
  } finally { ownerDb.close(); await rm(dir, { recursive: true, force: true }); }
});

test('upsert SET refuses restrict columns with the same diagnostic as UPDATE', async () => {
  for (const mode of ['caller','admin'] as const) for (const postgres of [false, true]) for (const sql of ["UPDATE orders SET region = 'JP' WHERE id = 'one' RETURNING id", "INSERT INTO orders(region,tier) VALUES ('TW','gold') ON CONFLICT(id) DO UPDATE SET region=excluded.region RETURNING id"]) {
    const p = JSON.stringify({ apiVersion: 'cms.mantle.aotter.net/v2', kind: 'Procedure', metadata: { name: 'move' }, spec: { title: 'Move', input: { type: 'object', additionalProperties: false }, output: { type: 'object' }, restrict: { orders: "region IN auth.user('region')" }, handler: { sql } } });
    const result = await compilePlan({ sources: [{ sourceId: 'upsert.yaml', text: schema+'\n---\n'+p }] }, postgres ? postgresCompiler : sqliteCompiler, 'operational');
    if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
    const proc = result.plan.procedures.move!;
    if (!('sql' in proc.handler)) throw Error('Expected SQL Procedure');
    const { stmts } = proc.handler.sql;
    expect(() => compileProgram(stmts, { dialect: postgres ? postgresDialect() : d1Dialect, schemas: result.plan.schemas, inputs: proc.inputs, kind: 'procedure', mode, restrict: proc.restrict })).toThrow(expect.objectContaining({ code: 'USER_FIELD_POSITION', message: 'The scoped column is never writable through SET.' }));
  }
});

test('caller references are refused in SQL and restrict is validated', async () => {
  for (const sql of ["SELECT id FROM orders WHERE region IN auth.user('region')", "SELECT auth.user('region') FROM orders", "SELECT id FROM orders WHERE NOT(region IN (auth.user('region')))", "SELECT id FROM orders WHERE region <> auth.user('region')", "SELECT id FROM orders WHERE (region = auth.user('region')) IS NOT TRUE", "SELECT id FROM orders ORDER BY auth.hasRole('vip')", "SELECT id FROM orders WHERE NOT EXISTS(SELECT id FROM orders WHERE region IN (auth.user('region')))", "SELECT id FROM orders WHERE auth.role() = 'vip'"])
    await expect(generateOrThrow('bun-sqlite', [{ sourceId: 'deny.yaml', text: schema+'\n---\n'+view('denied', sql) }])).rejects.toThrow(/USER_REF_SCOPE_ONLY|AUTH_ROLE_REMOVED/);
  for (const restrict of <Record<string, string>[]>[{ other: "region IN auth.user('region')" }, { orders: "missing IN auth.user('region')" }, { orders: "region = auth.user('region')" }, { orders: 'region = auth.uid()' }, { orders: "region IN auth.user('region') OR tier IN auth.user('tier')" }])
    await expect(generateOrThrow('bun-sqlite', [{ sourceId: 'restrict.yaml', text: schema+'\n---\n'+view('restricted', 'SELECT id FROM orders', restrict) }]), JSON.stringify(restrict)).rejects.toThrow();
});

test('scope wraps SQL relations; { all: true } drops only the scope term, never a restrict',async()=>{
 const scoped=JSON.parse(schema);scoped.spec.scope="region IN auth.user('region')";scoped.spec.uniqueIndexes=[['tier']];
 const sqls={cte:'WITH visible AS (SELECT id,region FROM orders) SELECT id,region FROM visible ORDER BY id',derived:'SELECT id,region FROM (SELECT id,region FROM orders) o ORDER BY id',left:'SELECT a.id,a.region,b.id AS joined FROM orders a LEFT JOIN orders b ON a.id=b.id ORDER BY a.id',exists:'SELECT id,region FROM orders a WHERE EXISTS(SELECT id FROM orders b WHERE b.id=a.id) ORDER BY id',window:'SELECT id,region,row_number() OVER(ORDER BY id) AS position FROM orders ORDER BY id',restricted:'WITH visible AS (SELECT id,region FROM orders) SELECT id,region FROM visible v ORDER BY id'};
 const procedure=(name:string,sql:string)=>JSON.stringify({apiVersion:'cms.mantle.aotter.net/v2',kind:'Procedure',metadata:{name},spec:{title:name,input:{type:'object',additionalProperties:false},output:{type:'object'},handler:{sql}}});
 const text=[JSON.stringify(scoped),...Object.entries(sqls).map(([name,sql])=>view(name,sql,name==='restricted'?{orders:"region IN auth.user('region')"}:undefined)),procedure('seed',"INSERT INTO orders(region,tier) VALUES ('TW','gold') ON CONFLICT(tier) DO UPDATE SET tier=excluded.tier RETURNING id")].join('\n---\n'),files=await generateOrThrow('bun-sqlite',[{sourceId:'matrix.yaml',text}]),dir=await mkdtemp(resolve(import.meta.dir,'apps/.generated/scope-matrix-')),db=new Database(':memory:');
 try{await writeGenerated(dir,files);const app=await import(resolve(dir,'generated.ts'));db.exec(files['schema.sql']!);const system={kind:'system',reason:'fixture'} as const;
  await app.store(db,system).collection('orders').insert({region:'TW',tier:'gold'});await app.store(db,system).collection('orders').insert({region:'JP',tier:'gold'});
  const member=userCaller({id:'member',region:'TW'},{fields}),admin=userCaller({id:'admin',role:'admin',region:{all:true}},{fields});
  const {default:page}=await import(resolve(dir,'paged/views/cte.ts'));
  let queries=0;const noSql={query(){queries++;throw Error('SQL before scope admission');}};
  for(const region of [undefined,[]]){
   const absent=userCaller({id:'absent',region},{fields}),collection=app.store(noSql,absent).collection('orders');
   for(const run of [()=>app.views.cte(noSql,absent,{}),()=>app.procedures.seed(noSql,absent,{}),()=>collection.find(),()=>collection.insert({tier:'silver'}),()=>page(noSql,absent,{})])
    await expect(Promise.resolve().then(run)).rejects.toMatchObject({code:'AUTH_DENIED'});
  }
  expect(queries).toBe(0);
  for(const name of Object.keys(sqls)){const own=await app.views[name](db,member,{});expect(own.length).toBe(1);expect(own.every((row:any)=>row.region==='TW')).toBe(true);expect(name==='restricted'?await code(()=>app.views[name](db,admin,{})):(await app.views[name](db,admin,{})).length).toBe(name==='restricted'?'AUTH_DENIED':2);expect(await code(()=>app.views[name](db,{...admin},{}))).toBe('AUTH_DENIED');}
  expect(await app.store(db,member).collection('orders').count()).toBe(1);expect(await app.store(db,admin).collection('orders').count()).toBe(2);
  await expect(app.procedures.seed(db,member,{})).rejects.toMatchObject({code:'AUTH_DENIED'});expect((await app.procedures.seed(db,system,{})).results[0]).toHaveLength(1);
  await expect(generateOrThrow('bun-sqlite',[{sourceId:'readonly.yaml',text:JSON.stringify(scoped)+'\n---\n'+procedure('bad',"INSERT INTO orders(region,tier) VALUES ('TW','gold') ON CONFLICT(tier) DO UPDATE SET region=excluded.region RETURNING id")}])).rejects.toThrow('scoped column');
  await expect(generateOrThrow('bun-sqlite',[{sourceId:'anti.yaml',text:JSON.stringify(scoped)+'\n---\n'+view('anti',"SELECT a.id FROM orders a LEFT JOIN orders b ON a.id=b.id AND b.region IN auth.user('region') WHERE b.id IS NULL")}])).rejects.toThrow('USER_REF_SCOPE_ONLY');
  await expect(generateOrThrow('bun-sqlite',[{sourceId:'unsupported-set.yaml',text:JSON.stringify(scoped)+'\n---\n'+view('set','SELECT id FROM orders UNION ALL SELECT id FROM orders')}])).rejects.toThrow('SQL_UNSUPPORTED');
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test('translation parent scope remains inside EXISTS when the child field is { all: true }',async()=>{
 const manifest=(kind:string,name:string,spec:object)=>JSON.stringify({apiVersion:'cms.mantle.aotter.net/v2',kind,metadata:{name},spec});
 const text=[manifest('Schema','parents',{title:'Parents',lifecycle:'publishing',scope:"region IN auth.user('region')",indexes:[['region','slug']],uniqueIndexes:[['slug']],schema:{type:'object',required:['region','slug','title'],properties:{region:{type:'string'},slug:{type:'string'},title:{type:'string'}}}}),manifest('Schema','children',{title:'Children',lifecycle:'publishing',localized:true,translates:{parent:'parents',on:'slug'},scope:"region IN auth.user('zone')",indexes:[['region','slug']],schema:{type:'object',required:['region','slug','locale','title'],properties:{region:{type:'string'},slug:{type:'string'},locale:{type:'string'},title:{type:'string'}}}}),manifest('View','translated',{title:'Translations',surface:'public',sql:'SELECT id,title FROM children ORDER BY id'})].join('\n---\n');
 const files=await generateOrThrow('bun-sqlite',[{sourceId:'parent-scope.yaml',text}]),dir=await mkdtemp(resolve(import.meta.dir,'apps/.generated/parent-scope-')),db=new Database(':memory:');
 try{await writeGenerated(dir,files);const app=await import(resolve(dir,'generated.ts')),sys={kind:'system',reason:'fixture'} as const;db.exec(files['schema.sql']!);
  const parent=await app.store(db,sys).collection('parents').insert({region:'JP',slug:'foreign',title:'Parent'});await app.procedures['parents.publish'](db,sys,{id:parent.id,expectedVersion:1});
  const child=await app.store(db,sys).collection('children').insert({region:'TW',slug:'foreign',locale:'en',title:'Child'});
  const admin=userCaller({id:'admin',role:'admin',region:'TW',zone:{all:true}},{fields:{...fields,zone:{type:'string',multiple:true}}});
  await expect(app.procedures['children.publish'](db,admin,{id:child.id,expectedVersion:1})).rejects.toMatchObject({code:'CONFLICT'});
  await app.procedures['children.publish'](db,sys,{id:child.id,expectedVersion:1});expect(await app.views.translated(db,admin,{})).toEqual([]);
  const {translationLocales}=await import(resolve(dir,'translations.ts'));expect(await translationLocales(db,admin,'parents',[{id:parent.id,slug:'foreign'}])).toEqual({[parent.id]:[]});
  expect(await translationLocales(db,sys,'parents',[{id:parent.id,slug:'foreign'}])).toEqual({[parent.id]:['en']});
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test('partitioned unique keys cannot prove a multi-region join non-fanning',async()=>{
 const scoped=JSON.parse(schema);scoped.spec.scope="region IN auth.user('region')";scoped.spec.uniqueIndexes=[['tier']];const other={...scoped,metadata:{name:'otherorders'}};
 const v=JSON.parse(view('joined','SELECT a.id,a.tier FROM orders a JOIN otherorders b ON a.tier=b.tier ORDER BY a.id'));v.spec.surface='admin';v.spec.requires={auth:{all:['ctx.admin']}};
 for(const target of ['bun-sqlite','cloudflare-d1','bun-postgres','cloudflare-postgres'] as const)await expect(generateOrThrow(target,[{sourceId:'fanout.yaml',text:[scoped,other,v].map(m=>JSON.stringify(m)).join('\n---\n')}])).rejects.toThrow('Fanning join');
});

test('numeric user fields bind finite numbers and inferred enum/type conflicts are refused',async()=>{
 const numeric=JSON.parse(schema);numeric.spec.schema.properties.amount={type:'number'};
 const files=await generateOrThrow('bun-sqlite',[{sourceId:'numeric.yaml',text:JSON.stringify(numeric)+'\n---\n'+view('amounts','SELECT id FROM orders ORDER BY id',{orders:"amount IN auth.user('amount')"})}]),dir=await mkdtemp(resolve(import.meta.dir,'apps/.generated/numeric-fields-')),db=new Database(':memory:');
 try{await writeGenerated(dir,files);const app=await import(resolve(dir,'generated.ts'));db.exec(files['schema.sql']!);await app.store(db,{kind:'system',reason:'fixture'}).collection('orders').insert({region:'TW',tier:'gold',amount:1.5});const c=userCaller({id:'numbers',amount:[1.5,2]},{fields:{amount:{type:'number',multiple:true}}});expect(await app.views.amounts(db,c,{})).toHaveLength(1);expect(()=>userCaller({id:'bad',amount:NaN},{fields:{amount:{type:'number',multiple:true}}})).toThrow('finite');
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
 await expect(generateOrThrow('bun-sqlite',[{sourceId:'string.yaml',text:JSON.stringify(numeric)+'\n---\n'+view('stringly','SELECT id FROM orders',"author_id = auth.uid()" as never)}])).rejects.toThrow('restrict maps each Schema to a predicate');
 await expect(generateOrThrow('bun-sqlite',[{sourceId:'conflict.yaml',text:JSON.stringify(numeric)+'\n---\n'+view('conflicting','SELECT id FROM orders',{orders:"region IN auth.user('same')"})+'\n---\n'+view('conflicting2','SELECT id FROM orders',{orders:"amount IN auth.user('same')"})}])).rejects.toThrow('USER_FIELD_CONFLICT');
});

test('unrelated { all: true } fields stay independent in one SQL per target',async()=>{
 const manifests:any[]=[];
 for(let i=0;i<2;i++){const m=JSON.parse(schema);m.metadata.name='partition'+i;m.spec.scope=`region IN auth.user('r${i}')`;manifests.push(m,JSON.parse(view('partition'+i,`SELECT id,region FROM partition${i} ORDER BY id`)));}
 manifests.push(JSON.parse(view('combined','SELECT a.id,a.region,b.region AS otherregion FROM partition0 a JOIN partition1 b ON a.tier=b.tier ORDER BY a.id')));
 const files=await generateOrThrow('bun-sqlite',[{sourceId:'independent.yaml',text:manifests.map(m=>JSON.stringify(m)).join('\n---\n')}]),dir=await mkdtemp(resolve(import.meta.dir,'apps/.generated/independent-scopes-')),db=new Database(':memory:');
 try{await writeGenerated(dir,files);const app=await import(resolve(dir,'generated.ts'));db.exec(files['schema.sql']!);
  for(let i=0;i<2;i++)for(const region of ['TW','JP'])await app.store(db,{kind:'system',reason:'fixture'}).collection('partition'+i).insert({region,tier:'gold'});
  const names=['r0','r1'],c=(all:string)=>userCaller({id:'admin',...Object.fromEntries(names.map(n=>[n,all.split(',').includes(n)?{all:true}:'TW']))},{fields:Object.fromEntries(names.map(n=>[n,{type:'string' as const,multiple:true}]))});
  for(let i=0;i<2;i++){expect((await app.views['partition'+i](db,c('r0,r1'),{}))).toHaveLength(2);expect((await app.views['partition'+i](db,c('r0'),{}))).toHaveLength(i===0?2:1);}
  expect(await app.views.combined(db,c('r0'),{})).toHaveLength(2);expect(await app.views.combined(db,c('r1'),{})).toHaveLength(2);expect(await app.views.combined(db,c('r0,r1'),{})).toHaveLength(4);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test('valid user-field names that match Object prototype members infer and bind normally',async()=>{
 const files=await generateOrThrow('bun-sqlite',[{sourceId:'prototype-field.yaml',text:schema+'\n---\n'+view('prototype-fields','SELECT id FROM orders ORDER BY id',{orders:"tier IN auth.user('constructor') AND region IN auth.user('toString')"})}]),dir=await mkdtemp(resolve(import.meta.dir,'apps/.generated/prototype-fields-')),db=new Database(':memory:');
 try{await writeGenerated(dir,files);const app=await import(resolve(dir,'generated.ts'));db.exec(files['schema.sql']!);await app.store(db,{kind:'system',reason:'fixture'}).collection('orders').insert({region:'TW',tier:'gold'});
  const caller=userCaller({id:'member',constructor:'gold',toString:['TW']},{fields:{constructor:{type:'string' as const,multiple:false},toString:{type:'string' as const,multiple:true}}});expect(await app.views['prototype-fields'](db,caller,{})).toHaveLength(1);expect(await code(()=>app.views['prototype-fields'](db,{...caller},{}))).toBe('AUTH_DENIED');
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test('two scope dimensions: { all: true } on one keeps the other, through Views, pages, Store and INSERT…SELECT',async()=>{
 const two=JSON.parse(schema);two.spec.scope="region IN auth.user('region') AND tier IN auth.user('tier')";two.spec.indexes=[['region','tier','id']];
 const fields2={region:{type:'string' as const,multiple:true},tier:{type:'string' as const,multiple:true}};
 const procedure=JSON.stringify({apiVersion:'cms.mantle.aotter.net/v2',kind:'Procedure',metadata:{name:'copy-gold'},spec:{title:'Copy',input:{type:'object',additionalProperties:false},output:{type:'object'},handler:{sql:"INSERT INTO orders(region,tier) SELECT region,'copy' FROM orders WHERE tier='gold' RETURNING id"}}});
 const files=await generateOrThrow('bun-sqlite',[{sourceId:'two.yaml',text:[JSON.stringify(two),view('listed','SELECT id,region,tier FROM orders ORDER BY id'),procedure].join('\n---\n')}]),dir=await mkdtemp(resolve(import.meta.dir,'apps/.generated/two-scopes-')),db=new Database(':memory:');
 try{await writeGenerated(dir,files);const app=await import(resolve(dir,'generated.ts')),{default:page}=await import(resolve(dir,'paged/views/listed.ts'));db.exec(files['schema.sql']!);const sys={kind:'system',reason:'fixture'} as const;
  for(const [region,tier] of [['TW','gold'],['TW','silver'],['JP','gold'],['JP','silver']])await app.store(db,sys).collection('orders').insert({region,tier});
  const c=(region:unknown,tier:unknown)=>userCaller({id:'u',region,tier},{fields:fields2});
  const rows=async(caller:any)=>(await app.views.listed(db,caller,{})).map((r:any)=>r.region+r.tier).sort();
  expect(await rows(c('TW','gold'))).toEqual(['TWgold']);
  expect(await rows(c({all:true},'gold'))).toEqual(['JPgold','TWgold']);
  expect(await rows(c('TW',{all:true}))).toEqual(['TWgold','TWsilver']);
  expect(await rows(c({all:true},{all:true}))).toHaveLength(4);
  const first=await page(db,c({all:true},'gold'),{},{limit:1});expect(first.nextCursor).toBeString();
  const second=await page(db,c({all:true},'gold'),{},{limit:1,cursor:first.nextCursor});
  expect([...first.rows,...second.rows].map((r:any)=>r.tier)).toEqual(['gold','gold']);
  expect(await app.store(db,c({all:true},'silver')).collection('orders').count()).toBe(2);
  await expect(app.procedures['copy-gold'](db,c({all:true},'gold'),{})).rejects.toMatchObject({code:'AUTH_DENIED'});
  expect(files['generated.ts']!.match(/\/\*s:(region|tier)\*\//g)?.length).toBeGreaterThanOrEqual(2);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test('scope markers cannot be forged, restrict columns are not SET-able, cached Views refuse field scope',async()=>{
 const scoped=JSON.parse(schema);scoped.spec.scope="region IN auth.user('region')";
 for(const sql of ["SELECT id, '/*s:region*/' AS a FROM orders","SELECT id AS \"x*/\" FROM orders"])
  await expect(generateOrThrow('bun-sqlite',[{sourceId:'forge.yaml',text:JSON.stringify(scoped)+'\n---\n'+view('forged',sql)}])).rejects.toThrow("'/*' or '*/'");
 const move=JSON.stringify({apiVersion:'cms.mantle.aotter.net/v2',kind:'Procedure',metadata:{name:'move'},spec:{title:'Move',input:{type:'object',properties:{id:{type:'string'},tier:{type:'string'}},additionalProperties:false},output:{type:'object'},restrict:{orders:"tier IN auth.user('tier')"},handler:{sql:'UPDATE orders SET tier = input.tier WHERE id = input.id RETURNING id'}}});
 await expect(generateOrThrow('bun-sqlite',[{sourceId:'move.yaml',text:schema+'\n---\n'+move}])).rejects.toThrow(/never writable|must be lowered/);
 const publishing=JSON.parse(JSON.stringify(scoped));publishing.spec.lifecycle='publishing';
 const cached=JSON.stringify({apiVersion:'cms.mantle.aotter.net/v2',kind:'View',metadata:{name:'cached'},spec:{surface:'public',cache:{sharedMaxAge:60},sql:'SELECT id FROM orders'}});
 await expect(generateOrThrow('bun-sqlite',[{sourceId:'cache.yaml',text:JSON.stringify(publishing)+'\n---\n'+cached}])).rejects.toThrow('field-scoped');
});

test('a target that reads a restricted View carries its restrict',async()=>{
 const M=(kind:string,name:string,spec:object)=>JSON.stringify({apiVersion:'cms.mantle.aotter.net/v2',kind,metadata:{name},spec});
 const text=[schema,M('View','regional',{surface:'internal',restrict:{orders:"region IN auth.user('region')"},sql:'SELECT id, region FROM orders'}),
  M('View','wrapper',{surface:'internal',sql:'SELECT id, region FROM regional ORDER BY id'}),
  M('View','wrapper-of-wrapper',{surface:'internal',sql:'SELECT id FROM wrapper ORDER BY id'}),
  M('Procedure','touch',{title:'Touch',input:{type:'object',additionalProperties:false},output:{type:'object'},handler:{sql:"UPDATE orders SET tier = 'seen' WHERE id IN (SELECT id FROM regional) RETURNING id"}})].join('\n---\n');
 const files=await generateOrThrow('bun-sqlite',[{sourceId:'compose.yaml',text}]),dir=await mkdtemp(resolve(import.meta.dir,'apps/.generated/compose-')),db=new Database(':memory:');
 try{await writeGenerated(dir,files);const app=await import(resolve(dir,'generated.ts'));db.exec(files['schema.sql']!);
  for(const region of ['TW','JP'])await app.store(db,{kind:'system',reason:'fixture'}).collection('orders').insert({region,tier:'gold'});
  const c=userCaller({id:'u',region:'TW'},{fields});
  for(const name of ['regional','wrapper','wrapper-of-wrapper'])expect(await app.views[name](db,c,{})).toHaveLength(1);
  expect((await app.procedures.touch(db,c,{})).results[0]).toHaveLength(1);
  expect(await code(()=>app.views.wrapper(db,userCaller({id:'a',region:{all:true}},{fields}),{}))).toBe('AUTH_DENIED');
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test('a caller Procedure may insert where the target restricts only the owner column',async()=>{
 const own=JSON.stringify({apiVersion:'cms.mantle.aotter.net/v2',kind:'Procedure',metadata:{name:'add-own'},spec:{title:'Add',input:{type:'object',properties:{region:{type:'string'},tier:{type:'string'}},required:['region','tier'],additionalProperties:false},output:{type:'object'},restrict:{orders:'author_id = auth.uid()'},handler:{sql:'INSERT INTO orders (region, tier) VALUES (input.region, input.tier) RETURNING id'}}});
 const files=await generateOrThrow('bun-sqlite',[{sourceId:'own.yaml',text:schema+'\n---\n'+own}]);
 expect(files['generated.ts']).toContain('add-own');
});
test('an undefined scope value is not given: one partition autofills, several still ask, a system caller must name it', () => {
  const scopes = [{ column: 'region', field: 'region', type: 'string' as const }];
  const one = userCaller({ id: 'member', role: 'user', region: ['TW'] }, { fields });
  expect(scopeInsert(scopes, one, { region: undefined, name: 'n' })).toEqual({ name: 'n', region: 'TW' });
  expect(() => scopeInsert(scopes, one, { region: 'JP' })).toThrow(/outside the caller/);
  const two = userCaller({ id: 'member', role: 'user', region: ['TW', 'JP'] }, { fields });
  expect(() => scopeInsert(scopes, two, { region: undefined })).toThrow(/several 'region' values/);
  expect(() => scopeInsert(scopes, { kind: 'system', reason: 'test' }, { region: undefined })).toThrow(/explicit 'region' value/);
});
// #1644: `col IN auth.user(...)` binds a set, so only equality fixes an index prefix. Accepted Views are checked by the plan
// of the SQL that actually runs, for every caller variant: one value, several values, { all: true } and system (trusted).
const inScoped=(scope:boolean)=>{const o=JSON.parse(schema);if(scope)o.spec.scope="region IN auth.user('region')";o.spec.indexes=[['region','orderNo','id']];
 o.spec.schema.required.push('orderNo');o.spec.schema.properties.orderNo={type:'integer'};return JSON.stringify(o);};
const inView=(name:string,sql:string,surface='public',more:object={})=>JSON.stringify({apiVersion:'cms.mantle.aotter.net/v2',kind:'View',metadata:{name},spec:{surface,sql:`SELECT id,orderNo AS "orderNo",region FROM orders ${sql}`,...more}});
test('#1644: an IN-scoped or IN-restricted prefix does not serve ORDER BY; the refusal names the bounded ways',async()=>{
 const cases=[[inScoped(true),inView('listed','ORDER BY orderNo')],[inScoped(false),inView('listed','ORDER BY orderNo','public',{restrict:{orders:"region IN auth.user('region')"}})]];
 for(const target of ['bun-sqlite','bun-postgres'] as const){
  for(const [s,v] of cases){
   const error=await generateOrThrow(target,[{sourceId:'a.yaml',text:[s,v].join('\n---\n')}]).then(()=>undefined,(e:Error)=>e.message);
   expect(error).toContain("ORDER BY (orderNo) is served by index [region, orderNo, id] only after 'region', which a user-field scope or restrict fixes to a set of values, not one value: every page would read and sort all of the caller's rows.");
   expect(error).toContain('ORDER BY region, orderNo (served by the same index)');
   expect(error).toContain('WHERE region = input.region, which fixes the prefix (the scope or restrict still applies)');
   expect(error).toContain('for Views read by { all: true } callers, an index on the ORDER BY columns alone, e.g. [orderNo] (not bounded for scoped callers)');
  }
  // The suggested order keeps the authored direction, and every set-bound prefix column needs its own equality.
  const desc=await generateOrThrow(target,[{sourceId:'d.yaml',text:[inScoped(true),inView('listed','ORDER BY orderNo DESC')].join('\n---\n')}]).then(()=>'',(e:Error)=>e.message);
  expect(desc).toContain('ORDER BY region DESC, orderNo DESC (served by the same index, read backwards; on PostgreSQL confirm with EXPLAIN that no Sort remains)');
  const two=JSON.parse(inScoped(true));two.spec.scope+=" AND store IN auth.user('store')";two.spec.indexes=[['region','store','orderNo','id']];two.spec.schema.required.push('store');two.spec.schema.properties.store={type:'string'};
  const both=await generateOrThrow(target,[{sourceId:'e.yaml',text:[JSON.stringify(two),inView('listed','ORDER BY orderNo')].join('\n---\n')}]).then(()=>'',(e:Error)=>e.message);
  expect(both).toContain("only after 'region', 'store', which");
  expect(both).toContain('ORDER BY region, store, orderNo (served by the same index); a View input bound with equality, e.g. WHERE region = input.region AND store = input.store, which fixes the prefix');
  // An equality-fixed column between the set-bound one and the order stays in the suggestion, and following it generates.
  const mid=JSON.parse(inScoped(true));mid.spec.indexes=[['region','tier','orderNo','id']];
  const tiered=(sql:string)=>[JSON.stringify(mid),inView('listed',sql,'public',{input:{type:'object',required:['tier'],properties:{tier:{type:'string'}}}})].join('\n---\n');
  const midError=await generateOrThrow(target,[{sourceId:'m.yaml',text:tiered('WHERE tier = input.tier ORDER BY orderNo')}]).then(()=>'',(e:Error)=>e.message);
  expect(midError).toContain('ORDER BY region, tier, orderNo (served by the same index)');
  await generateOrThrow(target,[{sourceId:'n.yaml',text:tiered('WHERE tier = input.tier ORDER BY region, tier, orderNo')}]);
  // An order no index serves keeps the plain message.
  await expect(generateOrThrow(target,[{sourceId:'b.yaml',text:[inScoped(true),inView('listed','ORDER BY tier')].join('\n---\n')}])).rejects.toThrow(/Missing index for ORDER BY \(tier\): declare a Schema index/);
 }
});
const sorts=(plan:any):boolean=>!!plan&&typeof plan==='object'&&(plan['Node Type']==='Sort'||Object.values(plan).some(sorts));
for(const pg of [false,true])(pg&&!process.env.MANTLE_NEXT_BUN_PG_URL?test.skip:test)(`#1644: accepted IN-scoped Views page without sorting the caller's rows on ${pg?'PostgreSQL':'SQLite'}`,async()=>{
 const text=[inScoped(true),inView('listed','ORDER BY region, orderNo','internal'),inView('backward','ORDER BY region DESC, orderNo DESC','internal'),inView('one','WHERE region = input.region ORDER BY orderNo','internal',{input:{type:'object',required:['region'],properties:{region:{type:'string'}}}})].join('\n---\n');
 const files=await generateOrThrow(pg?'bun-postgres':'bun-sqlite',[{sourceId:'c.yaml',text}]),dir=await mkdtemp(resolve(import.meta.dir,'apps/.generated/in-prefix-')),namespace='in_prefix_'+crypto.randomUUID().replaceAll('-','');
 const raw:any=pg?new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!,{max:1}):new Database(':memory:'),ran:[string,unknown[]][]=[];
 const run=(sql:string,values:unknown[]=[])=>pg?raw.unsafe(sql,values):Promise.resolve(raw.query(sql).all(...values));
 const db=pg?{unsafe:(sql:string,values:unknown[])=>(ran.push([sql,values]),raw.unsafe(sql,values))}:{query:(sql:string)=>{const q=raw.query(sql);return {columnNames:q.columnNames,all:(...values:unknown[])=>(ran.push([sql,values]),q.all(...values)),run:(...values:unknown[])=>q.run(...values)};},exec:(sql:string)=>raw.exec(sql),transaction:(fn:any)=>raw.transaction(fn)};
 try{await writeGenerated(dir,files);
  if(pg){await run(`CREATE SCHEMA ${namespace}`);await run(`SET search_path TO ${namespace}`);await run(files['schema.sql']!);}else raw.exec(files['schema.sql']!);
  const app=await import(resolve(dir,'generated.ts')),sys={kind:'system',reason:'fixture'} as const;
  for(const [region,tier,orderNo] of [['TW','a',3],['JP','b',1],['US','c',2],['TW','d',4],['JP','e',5]] as const)await app.store(raw,sys).collection('orders').insert({region,tier,orderno:orderNo});
  // Rows come back in index order across the caller's regions.
  const {default:listed}=await import(resolve(dir,'paged/views/listed.ts')),{default:backward}=await import(resolve(dir,'paged/views/backward.ts')),{default:one}=await import(resolve(dir,'paged/views/one.ts'));
  const walk=async(page:any,caller:any,input:object)=>{const seen:number[]=[];let cursor:string|undefined;do{const p=await page(db,caller,input,{limit:2,...(cursor?{cursor}:{})});seen.push(...p.rows.map((r:any)=>Number(r.orderNo)));cursor=p.nextCursor??undefined;}while(cursor);return seen;};
  expect(await walk(listed,userCaller({id:'u',region:['TW','JP']},{fields}),{})).toEqual([1,5,3,4]);
  expect(await walk(backward,userCaller({id:'u',region:['TW','JP']},{fields}),{})).toEqual([4,3,5,1]);
  expect(await walk(one,userCaller({id:'u',region:['TW','JP']},{fields}),{region:'TW'})).toEqual([3,4]);
  // Enough rows that a planner prefers the index to a scan and sort. PostgreSQL's DESC next page for one value can
  // still cost a Sort over a misestimated `= ANY(CAST(...))` range, so only SQLite pins the backward plan.
  if(pg)await run(`INSERT INTO orders(id,version,created_at,updated_at,region,tier,orderno) SELECT 'g'||i,1,now(),now(),'R'||(i%20),'t',i FROM generate_series(1,20000) i`);
  else raw.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20000) INSERT INTO orders(id,version,created_at,updated_at,region,tier,orderno) SELECT 'g'||i,1,0,0,'R'||(i%20),'t',i FROM n`);
  await run('ANALYZE');
  const callers=[userCaller({id:'u',region:['R1']},{fields}),userCaller({id:'u',region:['R1','R2','R3']},{fields}),userCaller({id:'u',region:{all:true}},{fields}),sys];
  for(const caller of callers)for(const [page,input] of [[listed,{}],[one,{region:'R1'}],...(pg?[]:[[backward,{}]] as const)] as const){
   ran.length=0;const first=await page(db,caller,input,{limit:10});expect(first.nextCursor).toBeDefined();await page(db,caller,input,{limit:10,cursor:first.nextCursor});
   expect(ran.length).toBe(2);
   for(const [sql,values] of ran){
    if(pg){const [row]=await raw.unsafe(`EXPLAIN (FORMAT JSON) ${sql}`,values);expect({sql,sort:sorts(row["QUERY PLAN"])}).toEqual({sql,sort:false});}
    else{const plan=raw.query(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map((r:any)=>r.detail).join(' | ');expect(plan).not.toContain('USE TEMP B-TREE FOR ORDER BY');}
   }
  }
 }finally{if(pg){await run(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);await raw.close();}else raw.close();await rm(dir,{recursive:true,force:true});}
},60000);
