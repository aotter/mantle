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
const temp = mkdtempSync(join(tmpdir(), "mantle-vercel-package-"));
const artifacts = join(temp, "artifacts");
const zod = `file:${realpathSync(join(root, "packages/mantle-runtime/node_modules/zod"))}`;
const libsql = `file:${realpathSync(join(root, "packages/adapters/vercel/node_modules/@libsql/client"))}`;
const fingerprintFixture = readFileSync(
  join(root, "packages/mantle-spec/test/fixtures/pipeline-v0.1/valid.yaml"),
  "utf8",
);
const executionFixture = readFileSync(
  join(root, "packages/adapters/bun/test/fixtures/embedded.yaml"),
  "utf8",
);
const liveFixture = join(root, "packages/adapters/vercel/test/fixtures/live-node");
const liveConfig = JSON.parse(readFileSync(
  join(liveFixture, "vercel.json"),
  "utf8",
));

try {
  if (liveConfig.framework !== null ||
      liveConfig.outputDirectory !== "public" ||
      !existsSync(join(liveFixture, "public/robots.txt")) ||
      liveConfig.rewrites?.[0]?.destination !== "/api/index") {
    throw new Error("Vercel live fixture must remain a deployable framework-free catch-all Web Handler");
  }
  mkdirSync(artifacts);
  const tarballs = Object.fromEntries([
    ["@aotter/mantle-spec", "packages/mantle-spec"],
    ["@aotter/mantle-runtime", "packages/mantle-runtime"],
    ["@aotter/mantle-vercel", "packages/adapters/vercel"],
  ].map(([name, directory]) => {
    execFileSync("pnpm", ["-C", directory, "pack", "--pack-destination", artifacts], {
      cwd: root,
      stdio: "ignore",
    });
    return [name, join(artifacts, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`)];
  }));
  const packed = Object.fromEntries(Object.entries(tarballs)
    .map(([name, path]) => [name, `file:${path}`]));

  const generic = installConsumer("generic", { ...packed, zod }, packed);
  if (existsSync(join(generic, "node_modules/@libsql/client"))) {
    throw new Error("generic Vercel consumer installed optional @libsql/client");
  }
  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    const adapter = await import("@aotter/mantle-vercel");
    if (typeof adapter.createVercelMantle !== "function") throw new Error("missing adapter");
  `], { cwd: generic, stdio: "inherit" });

  const consumer = installConsumer("libsql", { ...packed, "@libsql/client": libsql, zod }, packed);
  mkdirSync(join(consumer, "api"));
  writeFileSync(join(consumer, "vercel.json"), `${JSON.stringify({
    $schema: "https://openapi.vercel.sh/vercel.json",
    framework: null,
    rewrites: [{ source: "/(.*)", destination: "/api/index" }],
  }, null, 2)}\n`);
  writeFileSync(
    join(consumer, "api/index.mjs"),
    fixtureProgram(fingerprintFixture, executionFixture),
  );
  for (const optional of [
    "mantle-admin",
    "mantle-admin-ui",
    "mantle-bun",
    "mantle-cloudflare",
    "mantle-web",
  ]) {
    if (existsSync(join(consumer, "node_modules/@aotter", optional))) {
      throw new Error(`packed Vercel consumer installed @aotter/${optional}`);
    }
  }
  execFileSync(process.execPath, ["api/index.mjs"], { cwd: consumer, stdio: "inherit" });
  console.log("Packed framework-free Vercel Function and optional libSQL consumer passed.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function installConsumer(name, dependencies, overrides) {
  const directory = join(temp, name);
  mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    dependencies,
    pnpm: { overrides },
  }, null, 2)}\n`);
  execFileSync("pnpm", ["install", "--ignore-scripts"], { cwd: directory, stdio: "inherit" });
  return directory;
}

function fixtureProgram(sharedFixture, runtimeFixture) {
  return `import { createClient } from "@libsql/client";
import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { compileRuntimePlan, SqliteMantleStorageAdapter } from "@aotter/mantle-runtime";
import { createVercelMantle } from "@aotter/mantle-vercel";
import { LibsqlDatabaseDriver } from "@aotter/mantle-vercel/libsql";

const fingerprintPlan = compile(${JSON.stringify(sharedFixture)});
if (fingerprintPlan.semanticFingerprint !== "fnv1a64:38f4e5d9cf49b5c8") {
  throw new Error("semantic fingerprint drifted");
}
const plan = compile(${JSON.stringify(runtimeFixture)});
const client = createClient({ url: "file::memory:" });
await client.execute("CREATE TABLE app_records (value TEXT NOT NULL)");
await client.execute("INSERT INTO app_records VALUES ('application-owned')");
const queries = [];
const observed = new Proxy(client, {
  get(target, property) {
    if (property === "execute") return (statement) => {
      queries.push(typeof statement === "string" ? statement : statement.sql);
      return target.execute(statement);
    };
    if (property === "batch") return (statements, mode) => {
      queries.push(...statements.map((statement) => typeof statement === "string" ? statement : statement.sql));
      return target.batch(statements, mode);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const storage = new SqliteMantleStorageAdapter(new LibsqlDatabaseDriver(observed));
const context = {
  user: { id: "customer-1" },
  staff: null,
  auth: { credential: "api-key", credentialId: "key-1", clientId: null, scopes: [] },
  env: { application: true },
};
const scheduled = [];
const options = {
  plan,
  storage,
  handlers: {
    echoOrder(input, ctx) {
      ctx.waitUntil?.(Promise.resolve());
      return input;
    },
  },
  ports: { clock: { now: () => 10 }, idgen: { next: () => "order-1" } },
  waitUntil: (promise) => scheduled.push(promise),
};
const first = createVercelMantle(options);
const runtime = await first.getRuntime();
const order = await runtime.createDraft.execute({
  collection: "orders",
  data: { customerId: "customer-1", title: "Packed order" },
  authorId: "customer-1",
  ctx: context,
});
await runtime.requestPublish.execute({ id: order.id, ctx: context });

const second = createVercelMantle(options);
await second.getRuntime();
queries.length = 0;
const handler = {
  async fetch(request) {
    if (new URL(request.url).pathname === "/health") return new Response("application route");
    return await second.handle(request, context) ?? new Response("not found", { status: 404 });
  },
};
if (typeof handler.fetch !== "function") throw new Error("invalid Vercel Web Handler");
const health = await handler.fetch(new Request("https://fixture.vercel.app/health"));
if (health.status !== 200 || await health.text() !== "application route") {
  throw new Error("application-owned sibling route failed");
}
const view = await handler.fetch(new Request(
  "https://fixture.vercel.app/api/views/published-orders?customerId=customer-1",
));
const viewBody = await view.json();
if (view.status !== 200 || viewBody?.data?.rows?.[0]?.id !== "order-1") {
  throw new Error("packed Vercel View failed");
}
const trigger = await handler.fetch(new Request("https://fixture.vercel.app/api/orders/customer-1", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ customerId: "spoofed" }),
}));
const triggerBody = await trigger.json();
if (trigger.status !== 200 || triggerBody?.data?.customerId !== "customer-1") {
  throw new Error("packed Vercel Trigger failed or body overrode path params");
}
await Promise.all(scheduled);
if (queries.some((sql) => /CREATE|_migrations|_mantle_boot_state/.test(sql))) {
  throw new Error("request path repeated preparation work");
}
await client.execute("INSERT INTO app_records VALUES ('still-owned')");
if ((await client.execute("SELECT count(*) AS count FROM app_records")).rows[0]?.count !== 2) {
  throw new Error("Mantle took ownership of the application client");
}
client.close();

function compile(text) {
  const parsed = parseManifestSources({ sources: [{ sourceId: "memory:packed-vercel", text }] });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join("\\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map((item) => item.message).join("\\n"));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error(compiled.diagnostics.map((item) => item.message).join("\\n"));
  return compiled.value;
}
`;
}
