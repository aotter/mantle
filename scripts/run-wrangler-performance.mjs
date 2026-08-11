import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { benchmarkHttpRoutes } from "../packages/mantle-runtime/dist/testing.js";

const root = resolve(import.meta.dirname, "..");
const config = join(
  root,
  "packages/adapters/cloudflare/test/performance/wrangler.jsonc",
);
const persistence = await mkdtemp(join(tmpdir(), "mantle-wrangler-performance-"));
const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const output = [];
const worker = spawn(
  "pnpm",
  [
    "--filter",
    "@aotter/mantle-cloudflare",
    "exec",
    "wrangler",
    "dev",
    "--config",
    config,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    persistence,
    "--log-level",
    "warn",
    "--show-interactive-dev-session=false",
  ],
  {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
worker.stdout.on("data", (chunk) => output.push(String(chunk)));
worker.stderr.on("data", (chunk) => output.push(String(chunk)));

try {
  await waitUntilReady(`${baseUrl}/__health`, worker);
  await seed(100);
  const small = await benchmarkHttpRoutes({
    targets: [{ name: "api-100", url: `${baseUrl}/api/views/recent-posts` }],
    rounds: 10,
    warmup: 2,
  });

  await seed(10_000);
  const crowded = await benchmarkHttpRoutes({
    targets: [{ name: "api-10000", url: `${baseUrl}/api/views/recent-posts` }],
    rounds: 10,
    warmup: 2,
  });
  const misses = await benchmarkHttpRoutes({
    targets: [{
      name: "page-miss-10000",
      url: (iteration) => `${baseUrl}/en/posts/post-${iteration * 5}`,
    }],
    rounds: 10,
    warmup: 2,
  });
  const admin = await benchmarkHttpRoutes({
    targets: [
      {
        name: "admin-first-10000",
        url: `${baseUrl}/admin/api/entries?collection=posts&limit=20`,
      },
      {
        name: "admin-late-10000",
        url: `${baseUrl}/admin/api/entries?collection=posts&limit=20&cursor=e%3A1000%3Apost-1000`,
      },
      {
        name: "admin-published-late-10000",
        url: `${baseUrl}/admin/api/entries?collection=posts&status=published&limit=20&cursor=e%3A1000%3Apost-1000`,
      },
    ],
    rounds: 10,
    warmup: 2,
  });
  const smallRows = metric(small, "rowsRead");
  const crowdedRows = metric(crowded, "rowsRead");
  const crowdedQueries = metric(crowded, "queryCount");
  const missRows = metric(misses, "rowsRead");
  const missQueries = metric(misses, "queryCount");
  const adminQueryMax = Math.max(...admin.results.map((result) => result.queryCount?.max ?? Infinity));
  const adminRowsP95 = Math.max(...admin.results.map((result) => result.rowsRead?.p95 ?? Infinity));
  const gates = {
    crowdedRowsReadBounded: crowdedRows.p95 <= Math.max(100, smallRows.p95 * 4),
    publicApiUsesOneQuery: crowdedQueries.max <= 1,
    pageMissStaysBounded: missQueries.max <= 2 && missRows.p95 <= 10,
    adminListUsesOneQuery: adminQueryMax <= 1,
    adminListRowsReadBounded: adminRowsP95 <= 100,
  };
  const report = {
    version: 1,
    environment: "wrangler-local",
    datasets: [100, 10_000],
    results: [
      ...small.results,
      ...crowded.results,
      ...misses.results,
      ...admin.results,
    ],
    gates,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (Object.values(gates).includes(false)) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  if (output.length > 0) process.stderr.write(output.join(""));
  process.exitCode = 1;
} finally {
  worker.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => worker.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  await rm(persistence, { recursive: true, force: true });
}

async function seed(rows) {
  const response = await checkedFetch(`${baseUrl}/__seed?until=${rows}`);
  const body = await response.json();
  if (body.rows !== rows) throw new Error(`seed expected ${rows} rows; got ${body.rows}`);
}

async function checkedFetch(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response;
}

function metric(report, name) {
  const value = report.results[0]?.[name];
  if (!value) throw new Error(`${report.results[0]?.name ?? "route"} omitted ${name}`);
  return value;
}

async function waitUntilReady(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Wrangler is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("wrangler did not become ready within 30 seconds");
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => error ? rejectClose(error) : resolveClose()));
  if (port === 0) throw new Error("failed to allocate a local port");
  return port;
}
