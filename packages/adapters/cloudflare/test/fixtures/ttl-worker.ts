import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { bootMantleRuntime, compileRuntimePlan, SqliteMantleStorageAdapter } from "@aotter/mantle-runtime";
import { D1DatabaseDriver } from "../../src/bindings/D1DatabaseDriver.js";

const source = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: events }
spec:
  title: Events
  lifecycle: operational
  ttl: { field: expiresAt, expireAfterSeconds: 0 }
  schema:
    type: object
    properties:
      label: { type: string }
      expiresAt: { type: string, format: date-time, nullable: true }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: current-events }
spec:
  surface: public
  from: events
  fields: [id, label]
`;
const parsed = parseManifestSources({ sources: [{ sourceId: "ttl-d1", text: source }] });
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
const linked = linkManifestSet(parsed.value);
if (!linked.ok) throw new Error(JSON.stringify(linked.diagnostics));
const compiled = compileRuntimePlan(linked.value);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));

export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    if (new URL(request.url).pathname === "/ready") return new Response("ready");
    const now = Date.now();
    const runtime = await bootMantleRuntime({
      plan: compiled.value,
      storage: new SqliteMantleStorageAdapter(new D1DatabaseDriver(env.DB), undefined, { now: () => now }),
    });
    const expired = await runtime.createDraft.execute({ collection: "events", data: {
      label: "expired", expiresAt: new Date(now - 60_000).toISOString(),
    }, authorId: null });
    const boundary = await runtime.createDraft.execute({ collection: "events", data: {
      label: "boundary", expiresAt: new Date(now).toISOString(),
    }, authorId: null });
    const future = await runtime.createDraft.execute({ collection: "events", data: {
      label: "future", expiresAt: new Date(now + 60_000).toISOString(),
    }, authorId: null });
    const missing = await runtime.createDraft.execute({ collection: "events", data: {
      label: "missing",
    }, authorId: null });
    const nullable = await runtime.createDraft.execute({ collection: "events", data: {
      label: "null", expiresAt: null,
    }, authorId: null });
    const hidden = await runtime.entries.readById({ collection: "events", id: expired.id }) === null;
    const listed = (await runtime.listEntries.execute({ collection: "events" })).map((row) => row.id);
    const view = await runtime.executeView({ view: "current-events" });
    const viewIds = view.ok ? view.result.rows.map((row) => row.id) : [];
    const preview = await runtime.sweepExpired({ collection: "events", limit: 1 });
    const first = await runtime.sweepExpired({ collection: "events", limit: 1, delete: true });
    const second = await runtime.sweepExpired({ collection: "events", limit: 1, delete: true, cursor: first.nextCursor });
    const count = await env.DB.prepare("SELECT count(*) AS count FROM events").first<{ count: number }>();
    return Response.json({ passed: hidden && !listed.includes(expired.id) && !listed.includes(boundary.id)
      && listed.includes(future.id) && listed.includes(missing.id) && listed.includes(nullable.id)
      && !viewIds.includes(expired.id) && !viewIds.includes(boundary.id)
      && viewIds.includes(future.id) && viewIds.includes(missing.id) && viewIds.includes(nullable.id)
      && preview.scanned === 1 && preview.removed === 0 && first.removed === 1
      && !!first.nextCursor && second.removed === 1 && count?.count === 3 });
  },
};
