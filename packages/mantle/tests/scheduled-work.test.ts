/**
 * docs/handbook/cloudflare/deploy-and-operate.md, "Scheduled work": the page's manifests are apps/scheduled-work.yaml,
 * and its src/schedule.ts and schedule.test.ts run as written, against the generated cloudflare-d1 code on the D1
 * stand-in over bun:sqlite and against a wrangler.jsonc that lists the crons the page names.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateOrThrow, link, loadFixtureSources, writeGenerated } from "./apps/link.js";
import { d1Shim } from "./apps/d1-shim.js";

const page = resolve(import.meta.dir, "../../../docs/handbook/cloudflare/deploy-and-operate.md");
const section = async () => (await readFile(page, "utf8")).split("## Scheduled work")[1]!.split(/\n## /)[0]!;
const documents = (text: string) => text.split(/\n---\n/).map(doc => doc.replace(/^(#.*\n)+/, "").trim());
const blocks = (text: string, lang: string) =>
  [...text.matchAll(new RegExp("^```" + lang + "\\n([\\s\\S]*?)^```$", "gm"))].map(match => match[1]!);

let dir: string;
beforeAll(async () => {
  const text = await section(),
    code = blocks(text, "ts");
  await mkdir(resolve(import.meta.dir, "apps/.generated"), { recursive: true });
  dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/scheduled-work-"));
  await writeGenerated(
    join(dir, "generated"),
    await generateOrThrow("cloudflare-d1", await loadFixtureSources("scheduled-work.yaml")),
  );
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src/schedule.ts"), link(code.find(block => block.startsWith("// src/schedule.ts"))!));
  await writeFile(join(dir, "schedule.test.ts"), link(code.find(block => block.startsWith("// schedule.test.ts"))!));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the page's manifests are the scheduled-work fixture", async () => {
  expect(blocks(await section(), "yaml").flatMap(documents)).toEqual(
    documents((await loadFixtureSources("scheduled-work.yaml"))[0]!.text),
  );
});

test("the page's test passes against the triggers.crons it names, and fails when wrangler.jsonc drifts", async () => {
  const crons = JSON.parse(/"triggers": \{ "crons": (\[[^\]]*\]) \}/.exec(await section())![1]!) as string[];
  expect(crons).toEqual(["*/15 * * * *", "0 3 * * 2"]);
  const run = async (declared: string[]) => {
    await writeFile(
      join(dir, "wrangler.jsonc"),
      `{\n  // the application's Wrangler configuration\n  "name": "app",\n  "main": "src/schedule.ts",\n  "compatibility_date": "2026-09-01",\n  "triggers": { "crons": ${JSON.stringify(declared)} }\n}\n`,
    );
    return spawnSync(process.execPath, ["test", "./schedule.test.ts"], { cwd: dir, encoding: "utf8" });
  };
  const passing = await run(crons);
  expect([passing.status, passing.stdout + passing.stderr]).toMatchObject([0, expect.stringContaining("1 pass")]);
  const drifted = await run(["*/15 * * * *", "0 3 * * 1"]);
  expect([drifted.status, drifted.stdout + drifted.stderr]).toMatchObject([1, expect.stringContaining("0 3 * * 1")]);
}, 60000);

test("scheduled() runs every job of the incoming cron, reports each, and fails loudly", async () => {
  const sqlite = new Database(":memory:"),
    env = { DB: d1Shim(sqlite) };
  const files = await generateOrThrow("cloudflare-d1", await loadFixtureSources("scheduled-work.yaml"));
  sqlite.exec(files["schema.sql"]!);
  const { scheduled } = await import(join(dir, "src/schedule.ts"));
  const now = Date.now() * 1000,
    hour = 3600 * 1_000_000;
  const seed = () => {
    sqlite.run("DELETE FROM login_codes");
    sqlite.run(
      `INSERT INTO login_codes (id, version, created_at, updated_at, code, expiresat) VALUES ('old', 1, 0, 0, 'a', ${now - hour}), ('new', 1, 0, 0, 'b', ${now + hour})`,
    );
  };
  const codes = () => (sqlite.query("SELECT id FROM login_codes ORDER BY id").all() as { id: string }[]).map(r => r.id);
  const logs: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
  try {
    seed();
    await scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() }, env);
    expect(codes()).toEqual(["new"]);
    expect(logs.map(line => JSON.parse(line))).toEqual([
      { cron: "*/15 * * * *", job: "login_codes.sweepExpired", outcome: "fulfilled" },
    ]);

    // Monday 03:00 UTC is "0 3 * * 1" in POSIX and arrives as Cloudflare's "0 3 * * 2".
    seed();
    sqlite.run(
      `INSERT INTO carts (id, version, created_at, updated_at, cartstate) VALUES ('stale', 1, 0, ${now - 25 * hour}, 'open'), ('fresh', 1, 0, ${now - hour}, 'open')`,
    );
    await scheduled({ cron: "0 3 * * 2", scheduledTime: Date.now() }, env);
    expect(sqlite.query("SELECT id, cartstate FROM carts ORDER BY id").all()).toEqual([
      { id: "fresh", cartstate: "open" },
      { id: "stale", cartstate: "closed" },
    ]);
    expect(codes()).toEqual(["new"]);

    await expect(scheduled({ cron: "0 3 * * 1", scheduledTime: Date.now() }, env)).rejects.toThrow(
      'No scheduled work for cron "0 3 * * 1".',
    );

    // One job fails: the invocation rejects naming it, and the cron's other job still ran.
    seed();
    sqlite.run("DROP TABLE carts");
    logs.length = 0;
    const failure = await scheduled({ cron: "0 3 * * 2", scheduledTime: Date.now() }, env).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe('Scheduled jobs failed for "0 3 * * 2": close-stale-carts');
    expect(codes()).toEqual(["new"]);
    expect(logs.map(line => JSON.parse(line).outcome)).toEqual(["rejected", "fulfilled"]);
  } finally {
    log.mockRestore();
  }
});
