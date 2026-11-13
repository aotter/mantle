/**
 * Better Auth on `cloudflare-postgres` in workerd: local Wrangler with a Hyperdrive binding, running the handbook's
 * `src/db.ts` and `src/auth.ts` (cloudflare/postgres-hyperdrive.md) unchanged. One Better Auth instance per isolate,
 * one postgres.js client per request. Local Wrangler connects directly to PostgreSQL, so Hyperdrive's pooling is not
 * exercised here.
 */
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateFromSources } from "../src/infrastructure/generateAuth.js";
import { loadFixtureSources, writeGenerated } from "./apps/link.js";

const url = process.env.MANTLE_NEXT_WORKER_PG_URL;
const base = resolve(import.meta.dir, "..");

/** The page's `// src/<name>.ts` blocks, by file name. */
async function handbookFiles() {
  const page = await readFile(resolve(base, "../../docs/handbook/cloudflare/postgres-hyperdrive.md"), "utf8");
  return Object.fromEntries(
    [...page.matchAll(/^```ts\n(\/\/ (src\/[\w-]+\.ts)[\s\S]*?)^```$/gm)].map(([, code, name]) => [name!, code!]),
  );
}

const worker = `import { authLoader, resolveCaller } from "@aotter/mantle/auth";
import { authRoutes } from "@aotter/mantle/auth/routes";
import { withAuthTasks } from "@aotter/mantle/auth/hardening";
import { surfaceFailure } from "@aotter/mantle/contracts";
import { requestDb, withRequestDb } from "./src/db.ts";
import { procedures } from "./generated/generated.ts";
let auth, requests = 0, constructions = 0;
export default {
  fetch: (request, env, ctx) => withRequestDb(env, async () => {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ready");
    requests++;
    auth ??= authLoader(() => import("./src/auth.ts").then(m => (constructions++, m.createAuth(env))));
    try {
      const own = await withAuthTasks(ctx.waitUntil.bind(ctx), () => authRoutes(auth, { methods: [{ kind: "email-otp" }] })(request));
      if (own) return own;
      const caller = await resolveCaller(request, auth);
      const result = path === "/book" ? await procedures.book(requestDb, caller, await request.json()) : undefined;
      return Response.json({ caller, result, requests, constructions });
    } catch (error) {
      return surfaceFailure(error);
    }
  }),
};
`;

(url ? test : test.skip)(
  "Better Auth on PostgreSQL in workerd: one instance per isolate, a client per request",
  async () => {
    const database = `auth_worker_${crypto.randomUUID().replaceAll("-", "")}`,
      admin = new SQL(url!);
    const target = new URL(url!);
    target.pathname = `/${database}`;
    const dir = await mkdtemp(join(base, "tests/apps/.auth-postgres-")),
      state = await mkdtemp(join(tmpdir(), "mantle-auth-postgres-"));
    const port = await new Promise<number>(done => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => done(port));
      });
    });
    const origin = `http://127.0.0.1:${port}`,
      email = "officer@example.test";
    const env = {
      BETTER_AUTH_SECRET: "auth-worker-fixture-secret-0123456789abcdef",
      PUBLIC_ORIGIN: origin,
      ADMIN_EMAIL: email,
    };
    let wrangler: ReturnType<typeof spawn> | undefined, log: Awaited<ReturnType<typeof open>> | undefined;
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const db = new SQL(target.toString(), { max: 1 });
    try {
      for (const [name, code] of Object.entries(await handbookFiles())) {
        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, name), code);
      }
      const { authOptions } = await import(join(dir, "src/auth.ts"));
      const generated = await generateFromSources({
        target: "cloudflare-postgres",
        sources: { sources: await loadFixtureSources("app-transaction.yaml") },
        auth: authOptions(env),
      });
      if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
      await writeGenerated(join(dir, "generated"), generated.files, false);
      await db.unsafe(generated.files["schema.sql"]!);
      await writeFile(join(dir, "worker.ts"), worker);
      const config = join(state, "wrangler.json");
      await writeFile(
        config,
        JSON.stringify({
          name: "mantle-auth-postgres-local",
          main: join(dir, "worker.ts"),
          compatibility_date: "2026-09-28",
          compatibility_flags: ["nodejs_compat"],
          vars: env,
          hyperdrive: [
            { binding: "HYPERDRIVE", id: "00000000000000000000000000000001", localConnectionString: target.toString() },
          ],
        }),
      );
      log = await open(join(state, "wrangler.log"), "w");
      wrangler = spawn(
        "node",
        [
          join(base, "node_modules/wrangler/bin/wrangler.js"),
          "dev",
          "--local",
          "--config",
          config,
          "--ip",
          "127.0.0.1",
          "--port",
          String(port),
          "--inspector-port",
          "0",
          "--persist-to",
          join(state, "state"),
        ],
        {
          cwd: base,
          detached: true,
          env: {
            ...process.env,
            WRANGLER_SEND_METRICS: "false",
            NO_PROXY: "127.0.0.1,localhost",
            no_proxy: "127.0.0.1,localhost",
          },
          stdio: ["ignore", log.fd, log.fd],
        },
      );
      let ready = false;
      for (let attempt = 0; attempt < 60 && !ready; attempt++) {
        if (wrangler.exitCode !== null) throw Error(await readFile(join(state, "wrangler.log"), "utf8"));
        try {
          ready = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok;
        } catch {}
        if (!ready) await new Promise(done => setTimeout(done, 1000));
      }
      expect(ready).toBe(true);

      const call = async (path: string, init: { body?: unknown; cookie?: string } = {}) => {
        const response = await fetch(`${origin}${path}`, {
          method: init.body ? "POST" : "GET",
          headers: {
            origin,
            ...(init.body ? { "content-type": "application/json" } : {}),
            ...(init.cookie ? { cookie: init.cookie } : {}),
          },
          body: init.body ? JSON.stringify(init.body) : undefined,
          signal: AbortSignal.timeout(30000),
        });
        return { response, body: (await response.json()) as any };
      };
      // Email-OTP sign-in; the verified ADMIN_EMAIL user becomes admin through postgresBootstrapAdmin (a transaction).
      const sent = await call("/api/auth/email-otp/send-verification-otp", { body: { email, type: "sign-in" } });
      expect(sent.response.status).toBe(200);
      const [{ value }] = await db.unsafe("SELECT value FROM verification WHERE identifier = $1", [
        `sign-in-otp-${email}`,
      ]);
      const signedIn = await call("/api/auth/sign-in/email-otp", { body: { email, otp: String(value).split(":")[0] } });
      expect(signedIn.response.status).toBe(200);
      const cookie = signedIn.response.headers
        .getSetCookie()
        .map(set => set.split(";")[0])
        .join("; ");
      expect(cookie).toContain("better-auth.session_token=");

      // Three cookie-authenticated requests in the same isolate: one Better Auth instance, a new client each time.
      const seen: number[] = [];
      for (let round = 0; round < 3; round++) {
        const me = await call("/me", { cookie });
        expect(me.response.status).toBe(200);
        expect(me.body.caller).toMatchObject({ kind: "user", subject: signedIn.body.user.id, admin: true });
        expect(me.body.constructions).toBe(1);
        seen.push(me.body.requests);
      }
      expect(seen[2]! - seen[0]!).toBe(2);

      // An authenticated write: a two-statement generated Procedure in a serializable transaction.
      const booked = await call("/book", { body: { item: "desk" }, cookie });
      expect(booked.response.status).toBe(200);
      expect(booked.body.result.results).toHaveLength(2);
      const rows = await db.unsafe("SELECT item FROM bookings WHERE owner = $1 ORDER BY item", [signedIn.body.user.id]);
      expect(rows.map((row: { item: string }) => row.item)).toEqual(["desk", "receipt"]);

      const anonymous = await call("/me");
      expect(anonymous.body.caller).toEqual({ kind: "anonymous" });
      expect(anonymous.body.constructions).toBe(1);
    } catch (error) {
      if (log) console.error(await readFile(join(state, "wrangler.log"), "utf8"));
      throw error;
    } finally {
      if (wrangler && wrangler.exitCode === null) {
        const ended = once(wrangler, "exit");
        try {
          process.kill(-wrangler.pid!, "SIGTERM");
        } catch {}
        await ended;
      }
      await log?.close();
      await db.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.close();
      await rm(dir, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  },
  120000,
);
