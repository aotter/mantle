// Runs inside workerd. Holds the local D1 binding and executes whatever it is sent, the way a
// tenant Worker executes a compiled program: one `batch` per program (in order, all or nothing).
export default {
  async fetch(req, env) {
    const { mode, stmts } = await req.json();
    try {
      if (mode === 'exec') {
        // DDL and fixtures: one at a time, so an error names the statement
        for (const s of stmts) await env.DB.prepare(s.sql).bind(...(s.binds ?? [])).run();
        return Response.json({ ok: true, results: [] });
      }
      const res = await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...(s.binds ?? []))));
      return Response.json({ ok: true, results: res.map((r) => ({ rows: r.results ?? [], changes: r.meta?.changes ?? 0 })) });
    } catch (e) {
      return Response.json({ ok: false, error: String(e?.message ?? e) });
    }
  },
};
