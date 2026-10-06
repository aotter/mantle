import { expect, it } from 'vitest';
import { compilePlan } from '../../src/spec/index.js';
import { createMantleRuntime, type Caller } from '../../src/core/index.js';
import { postgresStorage } from '../../src/postgres/index.js';
import * as pgCompile from '../../src/postgres/compile/index.js';
import { PG_URL, freshSchema } from './engine.js';

it.skipIf(!PG_URL)('JSON scalar strings and mixed-type inputs keep their type through SQL, Store, Views and hooks', async () => {
  const db = await freshSchema();
  const mixed = { type: ['string', 'object', 'boolean', 'integer', 'array', 'null'] };
  const scalar = { oneOf: [{ type: 'string' }, { type: 'object' }] };
  const atom = (kind: string, name: string, spec: unknown) => JSON.stringify({ apiVersion: 'cms.mantle.aotter.net/v2', kind, metadata: { name }, spec });
  const text = [
    atom('Schema', 'records', { title: 'Records', lifecycle: 'operational', schema: { type: 'object', required: ['payload', 'scalar'], properties: { payload: mixed, scalar } } }),
    atom('Procedure', 'create-record', { input: { type: 'object', required: ['payload', 'scalar'], properties: { payload: mixed, scalar } }, output: { type: 'object' }, handler: { sql: 'INSERT INTO records (payload, scalar) VALUES (input.payload, input.scalar) RETURNING id, payload, scalar' } }),
    atom('Procedure', 'observe', { input: { type: 'object' }, output: { type: 'object' }, handler: { ref: 'observe' } }),
    atom('Trigger', 'observe-created', { source: { kind: 'lifecycle', schema: 'records', on: ['after_create'] }, target: { procedure: 'observe' } }),
    atom('View', 'records-view', { surface: 'internal', sql: 'SELECT id, payload, scalar FROM records ORDER BY id' }),
  ].join('\n---\n');
  try {
    const compiled = await compilePlan({ sources: [{ sourceId: 'json-roundtrip', text }] }, pgCompile);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    expect(compiled.plan.schemas.records?.fields.payload).toBe('json');
    const observed: unknown[] = [];
    const runtime = await createMantleRuntime({ plan: compiled.plan, storage: postgresStorage({ connect: db.connect }), handlers: { observe: (_input, ctx) => { observed.push(ctx.cause.kind === 'lifecycle' ? ctx.cause.rows[0] : null); return {}; } } });
    const caller: Caller = { kind: 'anonymous' };
    for (const payload of ['123', 'true', 'null', '{"admin":true}', { manager: true }, true, 123, [1, '2'], null]) {
      const scalarValue = typeof payload === 'string' ? payload : { manager: true };
      const result = await runtime.invokeProcedure({ procedure: 'create-record', input: { payload, scalar: scalarValue }, caller, cause: { kind: 'internal', id: crypto.randomUUID() } }) as { results: Array<Array<{ id: string; payload: unknown; scalar: unknown }>> };
      const row = result.results[0]![0]!;
      expect(row).toMatchObject({ payload, scalar: scalarValue });
      const selected = await runtime.store.as(caller).select({ from: 'records', where: { id: row.id } });
      expect(selected.rows[0]).toMatchObject({ payload, scalar: scalarValue });
      const viewed = await runtime.store.as(caller).view('records-view');
      expect(viewed.rows.find((r) => r.id === row.id)).toMatchObject({ payload, scalar: scalarValue });
      expect(observed.at(-1)).toMatchObject({ payload, scalar: scalarValue });
    }
  } finally { await db.drop(); }
}, 60_000);
