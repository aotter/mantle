/**
 * Local SQLite-backed Durable Objects in workerd for tests (#1395): wrangler's `unstable_startWorker`, the same mechanism as
 * `LocalD1`. One worker serves many isolated databases (a fresh name is a fresh SQLite); `do-worker.mjs` runs the real
 * `durableObjectDriver` inside each object and Node ships `{ sql, binds }` to it.
 */
import { unstable_startWorker } from "wrangler";
import type { DatabaseDriver, SqlStatement } from "../../core/driver.js";

type Mode = "batch" | "exec" | "all" | "first" | "raw";
type Reply = { ok: true; results: { rows: Record<string, unknown>[] }[] } | { ok: false; error: { name?: string; message: string; code?: unknown; errcode?: unknown; errno?: unknown } };

export interface LocalDurableObject extends DatabaseDriver {
  /** The engine's own `sql.exec`, no driver in between: records the untouched error. */
  raw(sql: string, ...binds: unknown[]): Promise<readonly Record<string, unknown>[]>;
  /** DDL and fixtures, one statement at a time so an error names the statement. */
  exec(...stmts: string[]): Promise<void>;
}

const CONFIG = new URL("./do-wrangler.toml", import.meta.url).pathname;

export class LocalDurableObjects {
  private constructor(private readonly worker: Awaited<ReturnType<typeof unstable_startWorker>>) {}

  static async start(): Promise<LocalDurableObjects> {
    const worker = await unstable_startWorker({ config: CONFIG, dev: { persist: false, logLevel: "error", watch: false, inspector: false, server: { port: 0 } } });
    await worker.ready;
    return new LocalDurableObjects(worker);
  }

  private async send(name: string, mode: Mode, stmts: readonly SqlStatement[]) {
    // workerd answers plain text ("Network connection lost") when the machine is loaded; the statements did not run then, so a resend is safe
    for (let attempt = 0; ; attempt++) {
      const res = await this.worker.fetch("http://local-do/", { method: "POST", body: JSON.stringify({ name, mode, stmts }) });
      const text = await res.text();
      let reply: Reply;
      try { reply = JSON.parse(text) as Reply; } catch {
        if (attempt < 3) continue;
        throw new Error(`local Durable Object answered ${text.slice(0, 80)}`);
      }
      // keep name and the engine's code fields, so the executor sees the error's shape as transported
      if (!reply.ok) throw Object.assign(new Error(reply.error.message), Object.fromEntries(Object.entries(reply.error).filter(([, v]) => v !== undefined)));
      return reply.results;
    }
  }

  /** One isolated database. */
  open(name: string = crypto.randomUUID()): LocalDurableObject {
    return {
      batch: (stmts) => this.send(name, "batch", stmts),
      all: async (s) => (await this.send(name, "all", [s]))[0]!.rows,
      first: async (s) => (await this.send(name, "first", [s]))[0]!.rows[0] ?? null,
      raw: async (sql, ...binds) => (await this.send(name, "raw", [{ sql, binds }]))[0]!.rows,
      exec: async (...stmts) => { await this.send(name, "exec", stmts.map((sql) => ({ sql }))); },
    };
  }

  dispose(): Promise<void> {
    return this.worker.dispose();
  }
}
