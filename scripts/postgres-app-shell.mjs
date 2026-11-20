#!/usr/bin/env node
// Turns a `mantle init` app (the D1 app shell, an example copied on top) in the current directory into the same app on
// `cloudflare-postgres`, for check-examples.mjs: a Hyperdrive binding instead of D1 (local Wrangler connects it directly
// to CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE), the handbook's src/db.ts (one postgres.js client per
// request, `requestDb` for objects built once per isolate) with Better Auth on `requestDb`, and `env.DB` set to the
// request's own client, so app code that reads `env.DB` (an example's routes) gets a new client on every request and one
// that keeps it for the isolate fails on the next request.
// The smoke kit applies the schema to a fresh database under MANTLE_NEXT_WORKER_PG_URL and drops it afterwards.
// Every edit must match the shell's text exactly once; a shell change that moves it fails here, not later.
import { readFileSync, writeFileSync } from "node:fs";

const edit = (file, ...pairs) => {
  let text = readFileSync(file, "utf8");
  for (let at = 0; at < pairs.length; at += 2) {
    const [from, to] = [pairs[at], pairs[at + 1]];
    // a non-global regex's match() is one match plus its groups: count every match, then replace the one
    const count =
      typeof from === "string"
        ? text.split(from).length - 1
        : [...text.matchAll(new RegExp(from.source, from.flags.replace("g", "") + "g"))].length;
    if (count !== 1) throw new Error(`postgres-app-shell: ${file} has ${count} matches for ${from}, expected 1`);
    text = text.replace(from, to);
  }
  writeFileSync(file, text);
};

// The handbook's src/db.ts, from the installed package, plus the current client itself for `env.DB`.
const page = readFileSync("node_modules/@aotter/mantle/docs/handbook/cloudflare/postgres-hyperdrive.md", "utf8");
const db = /^```ts\n(\/\/ src\/db\.ts[\s\S]*?)^```$/m.exec(page)?.[1];
if (!db) throw new Error("postgres-app-shell: no src/db.ts block in the handbook's postgres-hyperdrive page");
writeFileSync("src/db.ts", `${db}\n/** The current request's own client. */\nexport { current as requestClient };\n`);
writeFileSync(
  "src/env.d.ts",
  `// cloudflare-postgres: src/index.ts sets DB to the request's postgres.js client.\ninterface Env { DB: import("@aotter/mantle/contracts").Postgres }\n`,
);
writeFileSync(
  "src/index.ts",
  `import { fetchService } from "./service.js";
import { scheduled } from "./schedule.js";
import { requestClient, withRequestDb } from "./db.js";

type Bindings = Omit<Env, "DB">;
export default {
  fetch: (request: Request, env: Bindings, context: ExecutionContext) =>
    withRequestDb(env, () => fetchService(request, { ...env, DB: requestClient() }, context)),
  scheduled: (controller: ScheduledController, env: Bindings, context: ExecutionContext) =>
    context.waitUntil(withRequestDb(env, () => scheduled(controller, { ...env, DB: requestClient() }))),
} satisfies ExportedHandler<Bindings>;
`,
);
// Better Auth is built once per isolate from the env it is given: service.ts gives it `requestDb`. auth.ts itself imports
// nothing new, as `mantle generate --auth` loads it with Node, which does not map `./db.js` to db.ts.
edit(
  "src/auth.ts",
  "import { d1Adapter } from",
  "import { postgresAdapter } from",
  "import { d1BootstrapAdmin } from",
  "import { postgresBootstrapAdmin } from",
  "d1BootstrapAdmin(env.DB,",
  "postgresBootstrapAdmin(env.DB,",
  "d1Adapter(env.DB)",
  "postgresAdapter(env.DB)",
);
edit(
  "src/service.ts",
  'import type { Handle } from "@aotter/mantle/driver/d1";',
  'import type { Postgres as Handle } from "@aotter/mantle/contracts";\nimport { requestDb } from "./db.js";',
  "m.createAuth(env)",
  "m.createAuth({ ...env, DB: requestDb })",
  ".d1Identity(db,",
  ".postgresIdentity(db,",
);
edit(
  "wrangler.jsonc",
  /"d1_databases": \[\s*\{\s*"binding": "DB",\s*"database_name": "mantle-app"\s*\}\s*\]/,
  '"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "00000000000000000000000000000001" }]',
);
writeFileSync(
  "postgres-database.mjs",
  `// A fresh database under MANTLE_NEXT_WORKER_PG_URL with the given SQL files applied; drop() deletes it.
import { readFileSync } from "node:fs";
import postgres from "postgres";

export async function createDatabase(files) {
  if (!process.env.MANTLE_NEXT_WORKER_PG_URL) throw new Error("MANTLE_NEXT_WORKER_PG_URL is not set");
  const name = \`mantle_example_\${crypto.randomUUID().replaceAll("-", "")}\`;
  const admin = postgres(process.env.MANTLE_NEXT_WORKER_PG_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(\`CREATE DATABASE \${name}\`);
  const url = new URL(process.env.MANTLE_NEXT_WORKER_PG_URL);
  url.pathname = \`/\${name}\`;
  const db = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const drop = async () => {
    await db.end();
    await admin.unsafe(\`DROP DATABASE IF EXISTS \${name} WITH (FORCE)\`);
    await admin.end();
  };
  try {
    for (const file of files) await db.unsafe(readFileSync(file, "utf8"));
  } catch (error) {
    await drop();
    throw error;
  }
  return { url: url.toString(), sql: command => db.unsafe(command), drop };
}
`,
);
edit(
  "smoke-kit.mjs",
  /  for \(const file of \["generated\/schema\.sql".*\n.*\n.*\n  \}\n/,
  `  const postgres = await (await import("./postgres-database.mjs")).createDatabase(["generated/schema.sql", ...(existsSync("seed.sql") ? ["seed.sql"] : [])]);
  env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = postgres.url;
`,
  /  const sql = async command => \{\n.*\n.*\n  \};\n/,
  "  const sql = command => postgres.sql(command);\n",
  "    rmSync(state, { recursive: true, force: true });\n",
  "    rmSync(state, { recursive: true, force: true });\n    await postgres.drop();\n",
);
console.log("postgres-app-shell: converted to cloudflare-postgres");
