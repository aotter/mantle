// A tiny recorder: every claim in the report is a `check` that ran, with its evidence.
import { isDeepStrictEqual } from 'node:util';

export type Check = { case: string; name: string; ok: boolean; detail?: string };

export class Report {
  lines: string[] = [];
  checks: Check[] = [];
  current = '';
  section(title: string) {
    this.current = title;
    this.lines.push('', `== ${title} ==`);
  }
  note(text: string) {
    this.lines.push(text);
  }
  check(name: string, ok: boolean, detail?: unknown) {
    const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
    this.checks.push({ case: this.current, name, ok, detail: d });
    this.lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${d && (!ok || d.length < 160) ? `  -> ${d}` : ''}`);
  }
  equal(name: string, actual: unknown, expected: unknown) {
    const ok = isDeepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
    this.check(name, ok, ok ? JSON.stringify(actual) : { expected, actual });
  }
  /** rows returned by a probe must not contain any of these ids (another owner's, expired or unpublished rows) */
  get failed() {
    return this.checks.filter((c) => !c.ok);
  }
  summary(byCase: boolean) {
    const cases = [...new Set(this.checks.map((c) => c.case))];
    return cases.map((c) => {
      const cs = this.checks.filter((x) => x.case === c);
      return `${cs.every((x) => x.ok) ? 'PASS' : 'FAIL'}  ${c}  (${cs.filter((x) => x.ok).length}/${cs.length} checks)`;
    }).join('\n') + (byCase ? '' : '');
  }
}
