import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { compileRuntimePlan, type HandlerContext } from "@aotter/mantle-runtime";
import { createBunMantle } from "../src/index.js";

const EXPECTED_FINGERPRINT = "fnv1a64:38f4e5d9cf49b5c8";
const fixture = readFileSync(
  new URL("../../../mantle-spec/test/fixtures/pipeline-v0.1/valid.yaml", import.meta.url),
  "utf8",
);
const executionFixture = readFileSync(
  new URL("./fixtures/embedded.yaml", import.meta.url),
  "utf8",
);
const context: HandlerContext = {
  user: { id: "customer-1" },
  staff: null,
  auth: { credential: "api-key", credentialId: "key-1", clientId: null, scopes: [] },
  env: { application: true },
};

describe("createBunMantle", () => {
  test("runs the shared plan on caller-owned SQLite and routes only selected requests", async () => {
    const database = new Database(":memory:");
    database.run("CREATE TABLE app_records (value TEXT NOT NULL)");
    database.run("INSERT INTO app_records VALUES ('before')");
    const queries: string[] = [];
    const observed = observeQueries(database, queries);
    expect(compilePlan(fixture).semanticFingerprint).toBe(EXPECTED_FINGERPRINT);
    const plan = compilePlan(executionFixture);

    const mantle = createBunMantle({
      plan,
      database: observed,
      handlers: {
        echoOrder: (input) => input,
      },
      ports: {
        clock: { now: () => 10 },
        idgen: { next: () => "order-1" },
      },
    });
    const [runtime, sameRuntime] = await Promise.all([
      mantle.getRuntime(),
      mantle.getRuntime(),
    ]);
    expect(sameRuntime).toBe(runtime);
    expect(runtime.revision).toBe(plan.semanticFingerprint);

    const order = await runtime.createDraft.execute({
      collection: "orders",
      data: { customerId: "customer-1", title: "First order" },
      authorId: "customer-1",
      ctx: context,
    });
    await runtime.requestPublish.execute({ id: order.id, ctx: context });
    queries.length = 0;
    const view = await mantle.handle(new Request(
      "http://app.test/api/views/published-orders?customerId=customer-1",
    ), context);
    expect(view?.status).toBe(200);
    expect(await view?.json()).toMatchObject({
      data: { rows: [{ id: "order-1", customerId: "customer-1", title: "First order" }] },
    });

    const trigger = await mantle.handle(new Request("http://app.test/api/orders/customer-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: "spoofed" }),
    }), context);
    expect(trigger?.status).toBe(200);
    expect(await trigger?.json()).toEqual({
      ok: true,
      data: { customerId: "customer-1" },
    });
    expect(await mantle.handle(new Request("http://app.test/application-route"))).toBeNull();
    expect(queries.some((sql) => /CREATE|_migrations|_mantle_boot_state/.test(sql))).toBe(false);
    expect(database.query("SELECT value FROM app_records").get()).toEqual({ value: "before" });
    database.close();
  });

  test("retries initialization after a transient database failure", async () => {
    const database = new Database(":memory:");
    let fail = true;
    const unstable = new Proxy(database, {
      get(target, property) {
        if (property === "query") {
          return (sql: string) => {
            if (fail && sql.includes("sqlite_master")) {
              fail = false;
              throw new Error("transient open failure");
            }
            return target.query(sql);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const mantle = createBunMantle({
      plan: compilePlan(executionFixture),
      database: unstable,
      handlers: { echoOrder: (input) => input },
    });

    await expect(mantle.getRuntime()).rejects.toThrow("transient open failure");
    await expect(mantle.getRuntime()).resolves.toHaveProperty("revision");
    database.close();
  });

  test("rejects HTTP Triggers under its public View prefix", async () => {
    const database = new Database(":memory:");
    const mantle = createBunMantle({
      plan: compilePlan(executionFixture.replace(
        "/api/orders/{customerId}",
        "/api/views/{customerId}",
      )),
      database,
      handlers: { echoOrder: (input) => input },
    });

    await expect(mantle.getRuntime()).rejects.toMatchObject({
      diagnostics: [{ code: "TRIGGER_PATH_INVALID" }],
    });
    database.close();
  });
});

function compilePlan(text: string) {
  const parsed = parseManifestSources({ sources: [{ sourceId: "memory:bun", text }] });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(({ message }) => message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map(({ message }) => message).join("\n"));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error(compiled.diagnostics.map(({ message }) => message).join("\n"));
  return compiled.value;
}


function observeQueries(database: Database, queries: string[]): Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "query") {
        return (sql: string) => {
          queries.push(sql);
          return target.query(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
