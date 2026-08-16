import { createClient } from "@libsql/client";
import {
  SqliteMantleStorageAdapter,
  compileRuntimePlan,
  type HandlerContext,
} from "@aotter/mantle-runtime";
import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { createVercelMantle } from "@aotter/mantle-vercel";
import { LibsqlDatabaseDriver } from "@aotter/mantle-vercel/libsql";
import { timingSafeEqual } from "node:crypto";
import { manifestSource } from "./_manifest.js";

const databaseUrl = requiredEnv("TURSO_DATABASE_URL");
if (!/^(?:https|libsql|wss):/.test(databaseUrl)) {
  throw new Error("TURSO_DATABASE_URL must select durable remote storage.");
}
const smokeKey = requiredEnv("MANTLE_SMOKE_KEY");
const client = createClient({
  url: databaseUrl,
  authToken: requiredEnv("TURSO_AUTH_TOKEN"),
});
const plan = compile(manifestSource);
const mantle = createVercelMantle({
  plan,
  storage: new SqliteMantleStorageAdapter(new LibsqlDatabaseDriver(client)),
  handlers: { echoOrder: (input) => input },
});
const context: HandlerContext = { user: null, staff: null, env: {} };

export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ok");
    if (path === "/_smoke/seed" && request.method === "POST") {
      if (!authorized(request, smokeKey)) return new Response("not found", { status: 404 });
      return seed(request);
    }
    return await mantle.handle(request, context) ?? new Response("not found", { status: 404 });
  },
};

async function seed(request: Request): Promise<Response> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return new Response("invalid input", { status: 400 });
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return new Response("invalid input", { status: 400 });
  }
  const record = input as Record<string, unknown>;
  const customerId = shortString(record["customerId"]);
  const title = shortString(record["title"]);
  if (!customerId || !title) return new Response("invalid input", { status: 400 });
  try {
    const runtime = await mantle.getRuntime();
    const row = await runtime.createDraft.execute({
      collection: "orders",
      data: { customerId, title },
      authorId: null,
      ctx: context,
    });
    await runtime.requestPublish.execute({ id: row.id, ctx: context });
    return Response.json({ ok: true, id: row.id });
  } catch (error) {
    console.error("[vercel fixture seed] failed", error);
    return Response.json({ ok: false }, { status: 500 });
  }
}

function compile(source: string) {
  const parsed = parseManifestSources({ sources: [{ sourceId: "fixture:vercel", text: source }] });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(({ message }) => message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map(({ message }) => message).join("\n"));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error(compiled.diagnostics.map(({ message }) => message).join("\n"));
  return compiled.value;
}

function authorized(request: Request, expected: string): boolean {
  const actual = request.headers.get("x-mantle-smoke-key") ?? "";
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function shortString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
