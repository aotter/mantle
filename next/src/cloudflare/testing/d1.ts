/**
 * Local D1 in workerd for tests (ADR-0034 decision 6): wrangler's `unstable_startWorker` with an in-memory
 * database, so nothing touches Cloudflare. `worker.mjs` holds the D1 binding; Node ships `{ sql, binds }`
 * to it and reads rows back, the way a tenant Worker runs a compiled program: one `batch` per program.
 */
import { unstable_startWorker } from "wrangler";

export interface D1Statement {
  readonly sql: string;
  readonly binds?: readonly unknown[];
}
export interface D1Result {
  readonly rows: readonly Record<string, unknown>[];
  readonly changes: number;
}
type Reply = { ok: true; results: D1Result[] } | { ok: false; error: string };

const CONFIG = new URL("./wrangler.toml", import.meta.url).pathname;

export class LocalD1 {
  private constructor(private readonly worker: Awaited<ReturnType<typeof unstable_startWorker>>) {}

  static async create(): Promise<LocalD1> {
    const worker = await unstable_startWorker({ config: CONFIG, dev: { persist: false, logLevel: "error", watch: false } });
    await worker.ready;
    return new LocalD1(worker);
  }

  private async send(mode: "batch" | "exec", stmts: readonly D1Statement[]): Promise<D1Result[]> {
    const res = await this.worker.fetch("http://local-d1/", { method: "POST", body: JSON.stringify({ mode, stmts }) });
    const reply = (await res.json()) as Reply;
    if (!reply.ok) throw new Error(reply.error);
    return reply.results;
  }

  /** One D1 batch: applied in order, all or nothing. Throws D1's error text when a statement fails. */
  batch(stmts: readonly D1Statement[]): Promise<D1Result[]> {
    return this.send("batch", stmts);
  }

  /** DDL and fixtures, one statement at a time so an error names the statement. */
  async exec(...stmts: (string | D1Statement)[]): Promise<void> {
    await this.send("exec", stmts.map((s) => (typeof s === "string" ? { sql: s } : s)));
  }

  async all(sql: string, ...binds: unknown[]): Promise<readonly Record<string, unknown>[]> {
    return (await this.batch([{ sql, binds }]))[0]!.rows;
  }

  dispose(): Promise<void> {
    return this.worker.dispose();
  }
}
