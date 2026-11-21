import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import postgres from "../../../mantle/node_modules/postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { admin as createAdmin } from "../../src/server/index.js";
import { entries } from "../../src/server/entries.js";
import { d1Shim } from "../../../mantle/tests/apps/d1-shim.js";
import { generateAdmin, writeAdminFixture } from "./generated-fixture.js";
import { admin } from "./server-native-scenarios.js";

/**
 * #2127: Admin's generic entry routes name fields in their declared spelling (`orgId`), the keys of entry `data`, on every
 * target. A storage spelling (`orgid`), another casing, or one column named in two spellings is refused with 400 before
 * any SQL, so a check never reads a value other than the one written. A date-time filter matches the stored instant
 * whatever its offset, as the Store does (ADR-0045 §5); sort names an indexed field the same way.
 */
const manifest = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: orgs}
spec:
 title: Orgs
 lifecycle: operational
 scope: "ownerId = auth.uid()"
 indexes: [[ownerId, orgCode]]
 schema:
  type: object
  required: [ownerId, orgCode]
  properties:
   ownerId: {type: string}
   orgCode: {type: string}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: tasks}
spec:
 title: Tasks
 lifecycle: operational
 scope: "ownerId = auth.uid()"
 indexes: [[ownerId, orgId, dueAt], [ownerId, startOn]]
 schema:
  type: object
  required: [ownerId, orgId, title, dueAt, startOn]
  properties:
   ownerId: {type: string}
   orgId: {type: string, x-mantle-ref: orgs}
   title: {type: string}
   dueAt: {type: string, format: date-time}
   startOn: {type: string, format: date}
   rankNo: {type: integer}
`;

const urls = {
  "bun-sqlite": undefined,
  "cloudflare-d1": undefined,
  "bun-postgres": process.env.MANTLE_NEXT_BUN_PG_URL,
  "cloudflare-postgres": process.env.MANTLE_NEXT_WORKER_PG_URL,
} as const;
for (const [target, url] of Object.entries(urls) as [keyof typeof urls, string | undefined][]) {
  const pg = target.endsWith("postgres");
  (!pg || url ? test : test.skip)(
    `${target}: Admin entry routes take and return declared field names; other spellings are refused before SQL`,
    async () => {
      const files = await generateAdmin(target, manifest),
        dir = await mkdtemp(join(import.meta.dir, "../../../mantle/tests/apps/.admin-declared-"));
      const namespace = "admin_declared_" + crypto.randomUUID().replaceAll("-", "");
      const sqlite = pg ? undefined : new Database(":memory:");
      const db: any =
        target === "bun-postgres"
          ? new SQL(url!, { max: 1 })
          : target === "cloudflare-postgres"
            ? postgres(url!, { max: 1, connection: { search_path: namespace }, onnotice: () => {} })
            : target === "cloudflare-d1"
              ? d1Shim(sqlite!)
              : sqlite;
      try {
        await writeAdminFixture(dir, files);
        if (pg) {
          await db.unsafe(`CREATE SCHEMA ${namespace}`);
          if (target === "bun-postgres") await db.unsafe(`SET search_path TO ${namespace}`);
          await db.unsafe(files["schema.sql"]!);
        } else sqlite!.exec(files["schema.sql"]!);
        const { adminBindings } = await import(join(dir, "admin-bindings.ts")),
          bindings = adminBindings();
        let statements = 0;
        const adapter = {
          ...bindings.adapter,
          read: (...args: any[]) => (statements++, bindings.adapter.read(...args)),
          procedure: (...args: any[]) => (statements++, bindings.adapter.procedure(...args)),
        };
        const fetch = createAdmin(bindings.metadata, bindings.views, bindings.operations, {
          db: () => db,
          caller: () => admin,
          routes: entries(bindings.schemas, adapter),
        });
        const ask = async (path: string, method = "GET", input?: unknown) => {
          const response = (await fetch(
            new Request("https://app.test/admin/api" + path, {
              method,
              headers: { origin: "https://app.test" },
              body: input === undefined ? undefined : JSON.stringify(input),
            }),
            {},
          ))!;
          return { status: response.status, body: await response.json() };
        };
        /** A refusal: its status and message, and how many statements it ran. */
        const refused = async (path: string, method = "GET", input?: unknown) => {
          const before = statements,
            { status, body } = await ask(path, method, input);
          return [status, body.error?.message, statements - before];
        };
        const titles = async (query: string) =>
          (await ask("/entries?collection=tasks&" + query)).body.items.map((i: any) => i.data.title);

        const org = (await ask("/entries", "POST", { collection: "orgs", data: { orgCode: "o1" } })).body.entry;
        const a = { orgId: org.id, title: "a", dueAt: "2026-10-11T00:00:01.5Z", startOn: "2026-10-20", rankNo: 1 };
        const created = await ask("/entries", "POST", { collection: "tasks", data: a });
        expect([created.status, created.body.entry.data]).toEqual([
          200,
          { ...a, dueAt: "2026-10-11T00:00:01.500000Z" },
        ]);
        const first = created.body.entry;
        // the instant, not its spelling: +02:00 is stored as UTC
        const b = (
          await ask("/entries", "POST", {
            collection: "tasks",
            data: { ...a, title: "b", dueAt: "2026-10-13T00:00:00+02:00", startOn: "2026-10-19" },
          })
        ).body.entry;
        expect([b.data.dueAt, b.data.startOn]).toEqual(["2026-10-12T22:00:00.000000Z", "2026-10-19"]);

        // Writes: the storage spelling, another casing and two spellings of one column are 400, before SQL.
        const unknown = [400, "Unknown field.", 0];
        expect(
          await refused("/entries", "POST", {
            collection: "tasks",
            data: { orgid: org.id, title: "c", dueat: "2026-10-11T00:00:02Z", starton: "2026-10-21" },
          }),
        ).toEqual([400, "Required field is missing.", 0]);
        for (const data of [
          { ...a, orgid: org.id },
          { ...a, dueat: "2027-01-01T00:00:00Z" },
          { ...a, OrgId: org.id },
        ])
          expect(await refused("/entries", "POST", { collection: "tasks", data })).toEqual(unknown);
        const patch = (data: object) =>
          refused(`/entries/${first.id}?collection=tasks`, "PATCH", { expectedVersion: first.version, data });
        // A PATCH reads the row first (an unchanged echo of a translation parent's field is dropped), then refuses: one
        // read, no write.
        for (const data of [
          { dueat: "2026-10-13T00:00:00Z" },
          { dueAt: "2026-10-13T00:00:00Z", dueat: "2026-10-14T00:00:00Z" },
        ])
          expect(await patch(data)).toEqual([400, "Unknown field.", 1]);
        expect(await patch({ startOn: "2026-02-30" })).toEqual([400, "Expected a valid date.", 1]);
        const patched = await ask(`/entries/${first.id}?collection=tasks`, "PATCH", {
          expectedVersion: first.version,
          data: { dueAt: "2026-10-12T08:00:00+08:00" },
        });
        expect(patched.body.entry.data.dueAt).toBe("2026-10-12T00:00:00.000000Z");
        // the scoped reference check reads the declared field's own value: a dangling one writes nothing
        const dangling = await ask("/entries", "POST", { collection: "tasks", data: { ...a, orgId: "missing" } });
        expect([dangling.status, dangling.body.error.code]).toEqual([409, "CONFLICT"]);
        expect(await titles("sort=updatedAt")).toEqual(["a", "b"]);

        // Filters: declared names; a date-time matches the same instant in any offset, a date only as a date.
        expect(await titles(`filter_field=orgId&filter_value=${org.id}&sort=startOn&direction=asc`)).toEqual([
          "b",
          "a",
        ]);
        expect(
          await titles(`filter_field=dueAt&filter_value=${encodeURIComponent("2026-10-12T08:00:00+08:00")}`),
        ).toEqual(["a"]);
        const instants = encodeURIComponent(JSON.stringify(["2026-10-12T00:00:00Z", "2026-10-13T00:00:00+02:00"]));
        expect(await titles(`filter_field=dueAt&filter_values=${instants}&sort=startOn&direction=asc`)).toEqual([
          "b",
          "a",
        ]);
        expect(await titles("filter_field=startOn&filter_value=2026-10-19")).toEqual(["b"]);
        expect(await titles("filter_field=rankNo&filter_value=1&sort=startOn&direction=asc")).toEqual(["b", "a"]);
        for (const field of ["orgid", "ORGID", "dueat", "starton"])
          expect(await refused(`/entries?collection=tasks&filter_field=${field}&filter_value=x`)).toEqual([
            400,
            "Unknown scalar filter field.",
            0,
          ]);
        for (const [field, value, message] of [
          ["dueAt", "2026-10-12", "Expected a valid date-time."],
          ["dueAt", "2026-10-12T00:00:00.0000001Z", "Expected a valid date-time."],
          ["startOn", "2026-10-20T00:00:00Z", "Expected a valid date."],
          ["rankNo", "1.5", "Expected a finite, safe number."],
        ] as const)
          expect(
            await refused(`/entries?collection=tasks&filter_field=${field}&filter_value=${encodeURIComponent(value)}`),
          ).toEqual([400, message, 0]);

        // Sort: an indexed declared name, paged by its cursor; the storage spelling is 400.
        const page = await ask("/entries?collection=tasks&sort=startOn&direction=asc&limit=1");
        const next = await ask(
          `/entries?collection=tasks&sort=startOn&direction=asc&limit=1&cursor=${encodeURIComponent(page.body.next_cursor)}`,
        );
        expect([...page.body.items, ...next.body.items].map((i: any) => i.data.startOn)).toEqual([
          "2026-10-19",
          "2026-10-20",
        ]);
        for (const sort of ["starton", "orgid", "created_at"])
          expect(await refused(`/entries?collection=tasks&sort=${sort}`)).toEqual([
            400,
            "Unknown indexed sort or direction.",
            0,
          ]);

        // What comes back is declared too: entry data, reference titles, related lists and the CSV header.
        const editor = (await ask(`/entries/${first.id}?collection=tasks`)).body;
        expect(Object.keys(editor.entry.data)).toEqual(["orgId", "title", "dueAt", "startOn", "rankNo"]);
        expect(editor.refTitles).toEqual({ orgId: { [org.id]: { collection: "orgs", id: org.id, title: "o1" } } });
        const related = (await ask(`/entries/${org.id}?collection=orgs`)).body.related;
        expect(related.map((r: any) => [r.relationship.childField, r.entries.length])).toEqual([["orgId", 2]]);
        const csv = (await fetch(new Request("https://app.test/admin/api/entries/export?collection=tasks"), {}))!;
        expect((await csv.text()).split("\r\n")[0]).toBe("id,version,updated_at,orgId,title,dueAt,startOn,rankNo");
      } finally {
        if (pg) {
          await db.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
          if (target === "bun-postgres") await db.close();
          else await db.end();
        } else sqlite!.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    30000,
  );
}
