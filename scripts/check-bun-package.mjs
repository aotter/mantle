#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const temp = mkdtempSync(join(tmpdir(), "mantle-bun-package-"));
const artifacts = join(temp, "artifacts");
const consumer = join(temp, "consumer");
const zod = `file:${realpathSync(join(root, "packages/mantle-runtime/node_modules/zod"))}`;
const sharedFixture = readFileSync(
  join(root, "packages/mantle-spec/test/fixtures/pipeline-v0.1/valid.yaml"),
  "utf8",
);
const embeddedFixture = readFileSync(
  join(root, "packages/adapters/bun/test/fixtures/embedded.yaml"),
  "utf8",
);

try {
  mkdirSync(artifacts);
  mkdirSync(consumer);
  const tarballs = Object.fromEntries([
    ["@aotter/mantle-spec", "packages/mantle-spec"],
    ["@aotter/mantle-runtime", "packages/mantle-runtime"],
    ["@aotter/mantle-bun", "packages/adapters/bun"],
  ].map(([name, directory]) => {
    execFileSync("pnpm", ["-C", directory, "pack", "--pack-destination", artifacts], {
      cwd: root,
      stdio: "ignore",
    });
    return [name, join(artifacts, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`)];
  }));
  const dependencies = Object.fromEntries(Object.entries(tarballs)
    .map(([name, path]) => [name, `file:${path}`]));
  writeFileSync(join(consumer, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    dependencies: { ...dependencies, zod },
    pnpm: { overrides: dependencies },
  }, null, 2)}\n`);
  writeFileSync(join(consumer, "index.ts"), fixtureProgram(sharedFixture, embeddedFixture));
  execFileSync("pnpm", ["install", "--ignore-scripts"], { cwd: consumer, stdio: "inherit" });
  for (const optional of ["mantle-cloudflare", "mantle-web", "mantle-admin", "mantle-admin-ui"]) {
    if (existsSync(join(consumer, "node_modules/@aotter", optional))) {
      throw new Error(`packed Bun consumer installed @aotter/${optional}`);
    }
  }
  execFileSync("bun", ["run", "index.ts"], { cwd: consumer, stdio: "inherit" });
  console.log("Packed Bun-owned server and SQLite consumer passed.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function fixtureProgram(fingerprintFixture, runtimeFixture) {
  return `import { Database } from "bun:sqlite";
import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { compileRuntimePlan } from "@aotter/mantle-runtime";
import { createBunMantle } from "@aotter/mantle-bun";

const fingerprintPlan = compile(${JSON.stringify(fingerprintFixture)});
if (fingerprintPlan.semanticFingerprint !== "fnv1a64:38f4e5d9cf49b5c8") {
  throw new Error("semantic fingerprint drifted");
}
const plan = compile(${JSON.stringify(runtimeFixture)});
const database = new Database(":memory:");
database.run("CREATE TABLE app_records (value TEXT NOT NULL)");
database.run("INSERT INTO app_records VALUES ('application-owned')");
const queries = [];
const observed = new Proxy(database, {
  get(target, property) {
    if (property === "query") return (sql) => { queries.push(sql); return target.query(sql); };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const context = {
  user: { id: "customer-1" },
  staff: null,
  auth: { credential: "api-key", credentialId: "key-1", clientId: null, scopes: [] },
  env: { application: true },
};
const mantle = createBunMantle({
  plan,
  database: observed,
  handlers: { echoOrder: (input) => input },
  ports: { clock: { now: () => 10 }, idgen: { next: () => "order-1" } },
});
const runtime = await mantle.getRuntime();
const order = await runtime.createDraft.execute({
  collection: "orders",
  data: { customerId: "customer-1", title: "Packed order" },
  authorId: "customer-1",
  ctx: context,
});
await runtime.requestPublish.execute({ id: order.id, ctx: context });
queries.length = 0;

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/health") return new Response("application route");
    return await mantle.handle(request, context) ?? new Response("not found", { status: 404 });
  },
});
try {
  const health = await fetch(new URL("/health", server.url));
  if (health.status !== 200 || await health.text() !== "application route") {
    throw new Error("application-owned sibling route failed");
  }
  const view = await fetch(new URL("/api/views/published-orders?customerId=customer-1", server.url));
  const viewBody = await view.json();
  if (view.status !== 200 || viewBody?.data?.rows?.[0]?.id !== "order-1") {
    throw new Error("packed Bun View failed");
  }
  const trigger = await fetch(new URL("/api/orders/customer-1", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ customerId: "spoofed" }),
  });
  const triggerBody = await trigger.json();
  if (trigger.status !== 200 || triggerBody?.data?.customerId !== "customer-1") {
    throw new Error("packed Bun Trigger failed or body overrode path params");
  }
  if (queries.some((sql) => /CREATE|_migrations|_mantle_boot_state/.test(sql))) {
    throw new Error("request path repeated preparation work");
  }
  database.run("INSERT INTO app_records VALUES ('still-owned')");
  if (database.query("SELECT count(*) AS count FROM app_records").get()?.count !== 2) {
    throw new Error("Mantle took ownership of the application database");
  }
} finally {
  await server.stop();
  database.close();
}

function compile(text) {
  const parsed = parseManifestSources({ sources: [{ sourceId: "memory:packed-bun", text }] });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join("\\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map((item) => item.message).join("\\n"));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error(compiled.diagnostics.map((item) => item.message).join("\\n"));
  return compiled.value;
}
`;
}
