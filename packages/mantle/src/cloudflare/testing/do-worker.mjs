// Runs inside workerd. One Durable Object per database name; each runs the real durableObjectDriver over its own SQLite storage.
import { DurableObject } from "cloudflare:workers";
import { durableObjectDriver } from "../durableObject.ts";

// An Error thrown across JS RPC loses its own props, so the DO catches and serialises name, message and the code fields itself
const describe = (e) => ({ name: e?.name, message: String(e?.message ?? e), code: e?.code, errcode: e?.errcode, errno: e?.errno });

export class Tenant extends DurableObject {
  async run(mode, stmts) {
    const driver = durableObjectDriver(this.ctx.storage);
    try {
      if (mode === "batch") return { ok: true, results: await driver.batch(stmts) };
      // one statement per batch, so an error names the statement
      if (mode === "exec") { for (const s of stmts) await driver.batch([s]); return { ok: true, results: [] }; }
      if (mode === "all") return { ok: true, results: [{ rows: await driver.all(stmts[0]) }] };
      if (mode === "first") return { ok: true, results: [{ rows: [await driver.first(stmts[0])].filter(Boolean) }] };
      // no driver: the untouched engine error
      if (mode === "raw") return { ok: true, results: [{ rows: this.ctx.storage.sql.exec(stmts[0].sql, ...(stmts[0].binds ?? [])).toArray() }] };
      throw new Error(`unknown mode ${mode}`);
    } catch (e) {
      return { ok: false, error: describe(e) };
    }
  }
}

export default {
  async fetch(req, env) {
    const { name, mode, stmts } = await req.json();
    return Response.json(await env.TENANT.get(env.TENANT.idFromName(name)).run(mode, stmts));
  },
};
