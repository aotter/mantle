// A tiny recorder: every claim in the report is a `check` that ran, with its evidence.
// @ts-nocheck test code over loosely typed IR and rows
import { isDeepStrictEqual } from 'node:util';

export type Check = { case: string; name: string; ok: boolean; detail?: string };

export class Report {
  checks: Check[] = [];
  current = '';
  section(title: string) {
    this.current = title;
  }
  check(name: string, ok: boolean, detail?: unknown) {
    const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
    this.checks.push({ case: this.current, name, ok, detail: d });
  }
  equal(name: string, actual: unknown, expected: unknown) {
    const ok = isDeepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
    this.check(name, ok, ok ? JSON.stringify(actual) : { expected, actual });
  }
  get failed() {
    return this.checks.filter((c) => !c.ok);
  }
}
