// Local D1 in workerd (wrangler's own `unstable_startWorker`, workerd 1.20260903.1 as pinned by the
// monorepo). `worker.mjs` holds the D1 binding; Node only ships `{sql, binds}` to it and reads rows
// back. Nothing here touches Cloudflare: `persist: false` keeps the database in memory.
import { unstable_startWorker } from 'wrangler';

export type Stmt = { sql: string; binds?: unknown[] };
type Reply = { ok: true; results: { rows: any[]; changes: number }[] } | { ok: false; error: string };

const CONFIG = new URL('../wrangler.toml', import.meta.url).pathname;

export class LocalD1 {
  private w: Awaited<ReturnType<typeof unstable_startWorker>>;
  private constructor(w: Awaited<ReturnType<typeof unstable_startWorker>>) {
    this.w = w;
  }
  static async create(): Promise<LocalD1> {
    const w = await unstable_startWorker({ config: CONFIG, dev: { persist: false, logLevel: 'error', watch: false } });
    await w.ready;
    return new LocalD1(w);
  }
  private async send(mode: 'batch' | 'exec', stmts: Stmt[]): Promise<Reply> {
    const r = await this.w.fetch('http://spike/', { method: 'POST', body: JSON.stringify({ mode, stmts }) });
    return (await r.json()) as Reply;
  }
  /** One D1 batch. Throws the D1 error text when any statement fails; everything is rolled back. */
  async batch(stmts: Stmt[]) {
    const r = await this.send('batch', stmts);
    if (!r.ok) throw new Error(r.error);
    return r.results;
  }
  async exec(stmts: (string | Stmt)[]) {
    const r = await this.send('exec', stmts.map((s) => (typeof s === 'string' ? { sql: s } : s)));
    if (!r.ok) throw new Error(r.error);
  }
  async all(sql: string, binds: unknown[] = []) {
    return (await this.batch([{ sql, binds }]))[0].rows;
  }
  /** Rows, or the error text (for probes that expect a refusal). */
  async try(sql: string, binds: unknown[] = []): Promise<{ rows: any[] } | { error: string }> {
    try {
      return { rows: await this.all(sql, binds) };
    } catch (e: any) {
      return { error: e.message };
    }
  }
  dispose() {
    return this.w.dispose();
  }
}
