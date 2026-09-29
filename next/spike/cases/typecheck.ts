// The `satisfies` binding of ADR-0034 decision 8: the probe list is checked against the IR's position
// union by the compiler. This case runs `tsc` on the spike, then proves the binding bites: it adds a
// position (and, separately, a relation edge) to a scratch copy and expects `tsc` to fail.
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Report } from '../src/report.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const TSC = `${ROOT}node_modules/.bin/tsc`;
const tsc = (project: string) => {
  const p = spawnSync(TSC, ['-p', project, '--noEmit'], { cwd: ROOT, encoding: 'utf8' });
  return { code: p.status, out: (p.stdout + p.stderr).trim() };
};

export async function run(r: Report) {
  r.section('Typecheck: the probe list is bound to the IR position union by `satisfies`');
  const real = tsc(`${ROOT}tsconfig.json`);
  r.check('tsc --noEmit passes on the spike (strict, erasable syntax only)', real.code === 0, real.out.slice(0, 400));

  const scratch = `${ROOT}.neg`;
  const variant = (name: string, edit: (positions: string) => string, expect: RegExp, why: string) => {
    rmSync(scratch, { recursive: true, force: true });
    cpSync(`${ROOT}src`, `${scratch}/src`, { recursive: true });
    cpSync(`${ROOT}cases`, `${scratch}/cases`, { recursive: true });
    cpSync(`${ROOT}tsconfig.json`, `${scratch}/tsconfig.json`);
    writeFileSync(`${scratch}/run.ts`, '');
    const file = `${scratch}/src/positions.ts`;
    writeFileSync(file, edit(readFileSync(file, 'utf8')));
    const res = tsc(`${scratch}/tsconfig.json`);
    r.check(`${name}: tsc fails (${why})`, res.code !== 0 && expect.test(res.out), res.out.split('\n').slice(0, 3).join(' | ').slice(0, 300));
    rmSync(scratch, { recursive: true, force: true });
  };
  variant('a new position without a probe',
    (s) => s.replace("  | 'near'; // _mantle_geo_<schema>, emitted by the compiler for near()", "  | 'near' // _mantle_geo_<schema>, emitted by the compiler for near()\n  | 'new-position';").replace("  near: 'compiler',", "  near: 'compiler',\n  'new-position': 'compiler',"),
    /new-position/, 'cases/policy.ts has no probe for it');
  variant('a new relation edge no position reaches',
    (s) => s.replace("  | Edge<'SelectStmt', SelectStmt, 'fromClause'>", "  | Edge<'SelectStmt', SelectStmt, 'fromClause'>\n  | Edge<'SelectStmt', SelectStmt, 'havingClause'>"),
    /ALL_EDGES_REACHED|not assignable to type 'never'/, 'ALL_EDGES_REACHED is `never`');
  variant('an edge naming a key that @pgsql/types does not have',
    (s) => s.replace("Edge<'SelectStmt', SelectStmt, 'fromClause'>", "Edge<'SelectStmt', SelectStmt, 'fromClaus'>"),
    /fromClaus/, 'the key is checked against the real node type');
  rmSync(scratch, { recursive: true, force: true });
}
