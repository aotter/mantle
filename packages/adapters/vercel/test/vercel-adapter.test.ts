import { createClient, type Client, type InStatement } from "@libsql/client";
import {
  SqliteMantleStorageAdapter,
  compileRuntimePlan,
  type HandlerContext,
  type MantleStorageAdapter,
} from "@aotter/mantle-runtime";
import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createVercelMantle } from "../src/index.js";
import { LibsqlDatabaseDriver } from "../src/libsql.js";

const EXPECTED_FINGERPRINT = "fnv1a64:1bececc8251e8b45";
const fingerprintFixture = readFileSync(
  new URL("../../../mantle-spec/test/fixtures/pipeline-v0.1/valid.yaml", import.meta.url),
  "utf8",
);
const executionFixture = readFileSync(
  new URL("../../bun/test/fixtures/embedded.yaml", import.meta.url),
  "utf8",
);
const context: HandlerContext = {
  user: { id: "customer-1" },
  staff: null,
  auth: { credential: "api-key", credentialId: "key-1", clientId: null, scopes: [] },
  env: { application: true },
};

describe("createVercelMantle", () => {
  test("shares durable libSQL state across adapter instances without owning the client", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute("CREATE TABLE app_records (value TEXT NOT NULL)");
    await client.execute("INSERT INTO app_records VALUES ('before')");
    const queries: string[] = [];
    const storage = new SqliteMantleStorageAdapter(
      new LibsqlDatabaseDriver(observeQueries(client, queries)),
    );
    expect(compilePlan(fingerprintFixture).semanticFingerprint).toBe(EXPECTED_FINGERPRINT);
    const plan = compilePlan(executionFixture);
    const scheduled: Promise<unknown>[] = [];
    let postResponseRan = false;
    const options = {
      plan,
      storage,
      handlers: {
        echoOrder: (input: unknown, ctx: HandlerContext) => {
          ctx.waitUntil?.(Promise.resolve().then(() => { postResponseRan = true; }));
          return input;
        },
      },
      ports: {
        clock: { now: () => 10 },
        idgen: { next: () => "order-1" },
      },
      waitUntil: (promise: Promise<unknown>) => { scheduled.push(promise); },
    } as const;
    const first = createVercelMantle(options);
    const runtime = await first.getRuntime();
    const order = await runtime.createDraft.execute({
      collection: "orders",
      data: { customerId: "customer-1", title: "Durable order" },
      authorId: "customer-1",
      ctx: context,
    });
    await runtime.requestPublish.execute({ id: order.id, ctx: context });

    queries.length = 0;
    const second = createVercelMantle(options);
    await second.getRuntime();
    expect(queries.some((sql) => /CREATE|_migrations/.test(sql))).toBe(false);
    queries.length = 0;

    const view = await second.handle(new Request(
      "https://fixture.vercel.app/api/views/published-orders?customerId=customer-1",
    ), context);
    expect(view?.status).toBe(200);
    expect(await view?.json()).toMatchObject({
      data: { rows: [{ id: "order-1", title: "Durable order" }] },
    });
    const trigger = await second.handle(new Request(
      "https://fixture.vercel.app/api/orders/customer-1",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId: "spoofed" }),
      },
    ), context);
    expect(trigger?.status).toBe(200);
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
    expect(postResponseRan).toBe(true);
    const invalidBody = await second.handle(new Request(
      "https://fixture.vercel.app/api/orders/customer-1",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      },
    ), context);
    expect(invalidBody?.status).toBe(400);
    expect(await invalidBody?.json()).toMatchObject({
      diagnostic: { code: "INPUT_VALIDATION_FAILED" },
    });
    expect(await second.handle(new Request("https://fixture.vercel.app/health"))).toBeNull();
    expect(queries.some((sql) => /CREATE|_migrations|_mantle_boot_state/.test(sql))).toBe(false);
    expect((await client.execute("SELECT count(*) AS count FROM app_records")).rows[0])
      .toEqual({ count: 1 });
    client.close();
  });

  test("retries a rejected per-instance preparation", async () => {
    const client = createClient({ url: "file::memory:" });
    const durable = new SqliteMantleStorageAdapter(new LibsqlDatabaseDriver(client));
    let attempts = 0;
    const storage: MantleStorageAdapter = {
      nativeViewDialects: durable.nativeViewDialects,
      async prepare(plan) {
        if (++attempts === 1) throw new Error("transient durable storage failure");
        return durable.prepare(plan);
      },
    };
    const mantle = createVercelMantle({
      plan: compilePlan(executionFixture),
      storage,
      handlers: { echoOrder: (input) => input },
      waitUntil: () => undefined,
    });

    await expect(mantle.getRuntime()).rejects.toThrow("transient durable storage failure");
    await expect(mantle.getRuntime()).resolves.toHaveProperty("revision");
    expect(attempts).toBe(2);
    client.close();
  });
});

function compilePlan(text: string) {
  const parsed = parseManifestSources({ sources: [{ sourceId: "memory:vercel", text }] });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(({ message }) => message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map(({ message }) => message).join("\n"));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error(compiled.diagnostics.map(({ message }) => message).join("\n"));
  return compiled.value;
}

function observeQueries(client: Client, queries: string[]): Client {
  return new Proxy(client, {
    get(target, property) {
      if (property === "execute") {
        return (statement: InStatement) => {
          queries.push(typeof statement === "string" ? statement : statement.sql);
          return target.execute(statement);
        };
      }
      if (property === "batch") {
        return (statements: InStatement[], mode?: "deferred" | "write" | "read") => {
          queries.push(...statements.map((statement) =>
            typeof statement === "string" ? statement : statement.sql));
          return target.batch(statements, mode);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
