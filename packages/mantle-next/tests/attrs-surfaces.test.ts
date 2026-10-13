/**
 * ADR-0046 decisions 6 and 9, lightweight: the generated mcp() and rest() are driven by a caller the host supplies. There is no
 * bearer token or cookie on any request; the surface still runs requires, validation and attribute scope.
 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "./apps/link.js";
import { sales } from "./attrs-scenarios.js";
import type { Caller } from "../src/kernel/contracts.js";

/** What a host forwards: a verified caller with the mcp scope (the surface needs it for a non-session credential). */
const forwarded = (attrs?: object, extra: object = {}): Caller => sales("host-user", attrs as never, { credential: "oauth", scopes: ["mcp"], clientId: "gateway", ...extra });

test("generated mcp() and rest() take the host's caller (no bearer) and scope by its attributes", async () => {
  const files = await generateOrThrow("bun-sqlite", await loadFixtureSources("attrs.yaml"));
  const dir = await mkdtemp(resolve(import.meta.dir, ".attrs-")), db = new Database(":memory:");
  let caller: Caller = forwarded({ region: ["TW"] });
  let resolverCalls = 0;
  try {
    await writeGenerated(dir, files); db.exec(files["schema.sql"]!);
    const app = await import(resolve(dir, "generated.ts"));
    const system: Caller = { kind: "system", reason: "seed" };
    for (const [region, tier, title] of [["TW", "gold", "A1"], ["TW", "silver", "A2"], ["JP", "gold", "B1"]] as const) await app.store(db, system).collection("orders").insert({ region, tier, title });
    const options = { db: () => db, caller: () => { resolverCalls++; return caller; } };
    const handle = (await import(resolve(dir, "mcp.ts"))).mcp(options), api = (await import(resolve(dir, "rest.ts"))).rest(options);
    let id = 0;
    const call = async (method: string, params: any = {}, path = "/mcp/staff") => {
      const response = await handle(new Request("https://app.test" + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) }), {});
      const text = await response.text();
      return { response, data: JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text) };
    };
    const titles = (r: any) => r.data.result.structuredContent.rows.map((x: any) => x.title).sort();

    expect((await call("tools/list")).data.result.tools.map((t: any) => t.name).sort()).toEqual(["notes_list", "regional_orders", "rename_order"]);
    expect(titles(await call("tools/call", { name: "regional_orders", arguments: {} }))).toEqual(["A1", "A2"]);
    caller = forwarded({ region: ["TW", "JP"] });
    expect(titles(await call("tools/call", { name: "regional_orders", arguments: {} }))).toEqual(["A1", "A2", "B1"]);
    caller = forwarded();
    expect(titles(await call("tools/call", { name: "regional_orders", arguments: {} }))).toEqual([]);
    caller = forwarded({ region: [] });
    expect(titles(await call("tools/call", { name: "regional_orders", arguments: {} }))).toEqual([]);

    // the host's role still gates the staff surface, and generated validation still runs before any SQL
    caller = forwarded({ region: ["TW"] }, { role: "other" });
    expect((await call("tools/list")).response.status).toBe(403);
    // KNOWN GAP (spike): `roles[]` reaches generated `requires` (attrs.test.ts) but the kernel's MCP staff gate still reads `role` only
    caller = forwarded({ region: ["TW"] }, { role: null, roles: ["sales"] });
    expect((await call("tools/list")).response.status).toBe(403);
    caller = forwarded({ region: ["TW"] });
    const bad = await call("tools/call", { name: "rename_order", arguments: { id: "x", title: "" } });
    expect(bad.data.result.isError).toBe(true);
    expect(JSON.parse(bad.data.result.content[0].text).diagnostics[0].code).toBe("INPUT_VALIDATION_FAILED");

    // a write through MCP and through REST: inside the caller's set it applies, outside it changes nothing
    const rows = (await app.store(db, system).collection("orders").find({})).rows as { id: string; title: string }[];
    const idOf = (title: string) => rows.find(r => r.title === title)!.id;
    const rename = (name: string, to: string) => call("tools/call", { name: "rename_order", arguments: { id: idOf(name), title: to } });
    expect((await rename("A1", "A1-mcp")).data.result.isError).toBeUndefined();
    expect((await rename("B1", "stolen")).data.result.isError).toBe(true);
    const post = (name: string, to: string) => api(new Request("https://app.test/api/orders/rename", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: idOf(name), title: to }) }), {});
    expect((await post("A2", "A2-rest"))!.status).toBe(200);
    expect((await post("B1", "stolen"))!.status).not.toBe(200);
    expect((await app.store(db, system).collection("orders").find({})).rows.map((r: any) => r.title).sort()).toEqual(["A1-mcp", "A2-rest", "B1"]);
    // the host's resolver, not a header, decided every call
    expect(resolverCalls).toBeGreaterThan(8);
    // no Authorization header was ever sent: an anonymous resolver is challenged, not served
    caller = { kind: "anonymous" };
    expect((await call("tools/list")).response.status).toBe(401);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
}, 60_000);
