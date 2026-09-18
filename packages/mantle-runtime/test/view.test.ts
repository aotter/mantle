import { describe, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { compileView } from "../src/infrastructure/storage/SqliteViewCompiler.js";
import {
  compileLogicalView,
  type RuntimePlan,
  type RuntimeViewPlan,
} from "../src/domain/service/RuntimePlanCompiler.js";
import { SqliteViewQueryExecutor } from "../src/infrastructure/storage/SqliteMantleStorageAdapter.js";
import {
  ExecuteViewUseCase,
  type InvokeViewGuard,
} from "../src/usecase/view/ExecuteViewUseCase.js";
import { InMemoryDatabase } from "./fakes/database.js";
import {
  runtimeDiagnostic,
  type SchemaManifest,
  type ViewManifest,
} from "@aotter/mantle-spec";
import type { DatabaseDriver } from "../src/domain/port/DatabaseDriver.js";
import { CANONICAL_MIGRATIONS } from "../src/infrastructure/boot/index.js";
import { DatabaseEntryRepository } from "../src/infrastructure/persistence/DatabaseEntryRepository.js";
import { schemaTableMigrations } from "../src/infrastructure/storage/SqliteSchemaTables.js";

function view(
  opts: Partial<ViewManifest["spec"]> & ({ from: string } | { sql: string }),
): ViewManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "View",
    metadata: { name: "v" },
    spec: { surface: "public", ...opts } as ViewManifest["spec"],
  };
}

function sqliteUseCase(
  db: DatabaseDriver,
  manifest: ViewManifest,
  guard?: InvokeViewGuard,
  schemas: readonly SchemaManifest[] = [],
): ExecuteViewUseCase {
  const planned: RuntimeViewPlan = {
    name: manifest.metadata.name,
    manifest,
    query: compileLogicalView(manifest),
  };
  const plan = {
    views: { [planned.name]: planned },
    schemas: Object.fromEntries(schemas.map((schema) => [
      schema.metadata.name,
      { name: schema.metadata.name, manifest: schema },
    ])),
  } as unknown as RuntimePlan;
  return new ExecuteViewUseCase(
    new SqliteViewQueryExecutor(db, plan),
    guard,
    plan.views,
  );
}

function nativeSchema(name: string, properties: Record<string, SchemaManifest["spec"]["schema"]>): SchemaManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Schema",
    metadata: { name },
    spec: { title: name, schema: { type: "object", properties } },
  };
}

async function seed(
  db: InMemoryDatabase,
  schema: SchemaManifest,
  rows: readonly { readonly id: string; readonly status: "draft" | "published"; readonly data: Record<string, unknown>; readonly now: number }[],
): Promise<void> {
  await db.migrations.runAll(CANONICAL_MIGRATIONS);
  await db.migrations.runAll(schemaTableMigrations([schema]));
  const repository = new DatabaseEntryRepository(db, new Map([[schema.metadata.name, schema]]));
  for (const row of rows) await repository.create({ ...row, collection: schema.metadata.name, authorId: null });
}

describe("compileView", () => {
  it("queries Schema logical tables, flattens JSON rows, and binds SQL params", () => {
    const orders: SchemaManifest = {
      apiVersion: "cms.mantle.aotter.net/v1",
      kind: "Schema",
      metadata: { name: "orders" },
      spec: {
        title: "Orders",
        schema: {
          type: "object",
          properties: {
            orderStatus: { type: "string" },
            items: { type: "array", items: { type: "object" } },
          },
        },
      },
    };
    const db = new DatabaseSync(":memory:");
    try {
      for (const migration of CANONICAL_MIGRATIONS) db.exec(migration.sql);
      for (const migration of schemaTableMigrations([orders])) db.exec(migration.sql);
      db.prepare(`INSERT INTO orders
        (_mantle_id, _mantle_status, _mantle_version, _mantle_author_id, _mantle_created_at, _mantle_updated_at, orderStatus, items)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("o1", "published", 1, null, 1, 1, "paid", JSON.stringify([
          { title: "Tea", quantity: 2 },
          { title: "Cake", quantity: 1 },
        ]));
      const compiled = compileView(view({
        sql: `SELECT o._mantle_id AS orderId,
          json_extract(item.value, '$.title') AS title,
          json_extract(item.value, '$.quantity') AS quantity
          FROM orders AS o JOIN json_each(o.items) AS item
          WHERE o.orderStatus = :status ORDER BY item.key`,
        params: {
          type: "object",
          properties: { status: { type: "string" } },
          required: ["status"],
        },
      }), {
        params: { status: "paid" },
        search: { term: "Tea", fields: ["title"] },
        filters: [{ field: "quantity", value: "2" }],
      });
      const rows = db.prepare(compiled.sql)
        .all(...compiled.params as SQLInputValue[]);
      expect(rows).toEqual([
        { orderId: "o1", title: "Tea", quantity: 2 },
      ]);
    } finally {
      db.close();
    }
  });

  it("emits a default-projection SELECT for a bare from-only view", () => {
    const c = compileView(view({ from: "posts" }));
    expect(c.sql).toContain(`FROM "posts"`);
    expect(c.sql).toContain("LIMIT");
    expect(c.params).toEqual([]);
  });

  it("compiles `eq` filter with parameter binding", () => {
    const c = compileView(
      view({ from: "posts", filter: { eq: { field: "status", value: "published" } } }),
    );
    expect(c.params).toEqual(["published"]);
    expect(c.sql).toMatch(/status = \?/);
  });

  it("compiles comparison filters with literal and param-ref values", () => {
    const c = compileView(
      view({
        from: "stock-movements",
        params: {
          type: "object",
          properties: {
            startAt: { type: "string" },
            endAt: { type: "string" },
          },
          required: ["startAt", "endAt"],
        },
        filter: {
          and: [
            { gte: { field: "occurredAt", value: { $param: "startAt" } } },
            { lt: { field: "occurredAt", value: { $param: "endAt" } } },
            { gt: { field: "quantity", value: 0 } },
          ],
        },
      }),
      {
        params: {
          startAt: "2026-06-01T00:00:00Z",
          endAt: "2026-07-01T00:00:00Z",
        },
      },
    );
    expect(c.params).toEqual([
      "2026-06-01T00:00:00Z",
      "2026-07-01T00:00:00Z",
      0,
    ]);
    expect(c.sql).toContain(`"occurredAt" >= ?`);
    expect(c.sql).toContain(`"occurredAt" < ?`);
    expect(c.sql).toContain(`"quantity" > ?`);
  });

  it("non-reserved field uses its native column", () => {
    const c = compileView(
      view({
        from: "posts",
        filter: { eq: { field: "locale", value: "en-US" } },
      }),
    );
    expect(c.sql).toContain(`"locale" = ?`);
  });

  it("compiles `and` of multiple eqs", () => {
    const c = compileView(
      view({
        from: "posts",
        filter: {
          and: [
            { eq: { field: "status", value: "published" } },
            { eq: { field: "locale", value: "en-US" } },
          ],
        },
      }),
    );
    expect(c.params).toEqual(["published", "en-US"]);
    expect(c.sql).toMatch(/AND/);
  });

  it("compiles `or` of multiple eqs", () => {
    const c = compileView(
      view({
        from: "posts",
        filter: {
          or: [
            { eq: { field: "locale", value: "en" } },
            { eq: { field: "locale", value: "zh-TW" } },
          ],
        },
      }),
    );
    expect(c.params).toEqual(["en", "zh-TW"]);
    expect(c.sql).toContain(
      `("locale" = ?) OR ("locale" = ?)`,
    );
  });

  it("compiles nested `and` / `or` without collapsing OR into AND", () => {
    const c = compileView(
      view({
        from: "posts",
        filter: {
          and: [
            { eq: { field: "status", value: "published" } },
            {
              or: [
                { eq: { field: "locale", value: "en" } },
                { eq: { field: "locale", value: "zh-TW" } },
              ],
            },
          ],
        },
      }),
    );
    expect(c.params).toEqual(["published", "en", "zh-TW"]);
    expect(c.sql).toContain(
      `(_mantle_status = ?) AND (("locale" = ?) OR ("locale" = ?))`,
    );
  });

  it("returns the same locale-or fixture rows that IndexedDB must match (#783)", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const posts: SchemaManifest = {
        apiVersion: "cms.mantle.aotter.net/v1", kind: "Schema", metadata: { name: "posts" },
        spec: { title: "Posts", schema: { type: "object", properties: { locale: { type: "string" } } } },
      };
      for (const migration of CANONICAL_MIGRATIONS) db.exec(migration.sql);
      for (const migration of schemaTableMigrations([posts])) db.exec(migration.sql);
      const insert = db.prepare(`INSERT INTO posts
        (_mantle_id, _mantle_status, _mantle_version, _mantle_author_id, _mantle_created_at, _mantle_updated_at, locale)
        VALUES (?, ?, 1, NULL, 1, 1, ?)`);
      for (const [id, locale, status] of [
        ["en-post", "en", "published"],
        ["zh-post", "zh-TW", "published"],
        ["ja-post", "ja", "published"],
        ["en-draft", "en", "draft"],
      ] as const) {
        insert.run(id, status, locale);
      }

      const localeOr = compileView(view({
        from: "posts",
        fields: ["id"],
        filter: {
          or: [
            { eq: { field: "locale", value: "en" } },
            { eq: { field: "locale", value: "zh-TW" } },
          ],
        },
      }), {}, posts);
      const localeOrRows = db.prepare(localeOr.sql)
        .all(...localeOr.params as SQLInputValue[]) as Array<{ id: string }>;
      expect(localeOrRows.map((row) => row.id).sort()).toEqual(["en-draft", "en-post", "zh-post"]);

      const nested = compileView(view({
        from: "posts",
        fields: ["id"],
        filter: {
          and: [
            { eq: { field: "status", value: "published" } },
            {
              or: [
                { eq: { field: "locale", value: "en" } },
                { eq: { field: "locale", value: "zh-TW" } },
              ],
            },
          ],
        },
      }), {}, posts);
      const nestedRows = db.prepare(nested.sql)
        .all(...nested.params as SQLInputValue[]) as Array<{ id: string }>;
      expect(nestedRows.map((row) => row.id).sort()).toEqual(["en-post", "zh-post"]);
    } finally {
      db.close();
    }
  });

  it("orderBy + limit compile through", () => {
    const c = compileView(
      view({
        from: "posts",
        orderBy: [{ field: "updatedAt", direction: "desc" }],
        limit: 5,
      }),
    );
    expect(c.sql).toMatch(/ORDER BY _mantle_updated_at DESC/);
    expect(c.sql).toMatch(/LIMIT 5 OFFSET 0/);
  });

  it("substitutes filter param-ref sentinels from the resolved params map", () => {
    const c = compileView(
      view({
        from: "posts",
        params: {
          type: "object",
          properties: { locale: { type: "string" } },
          required: ["locale"],
        },
        filter: { eq: { field: "locale", value: { $param: "locale" } } },
      }),
      { params: { locale: "zh-TW" } },
    );
    expect(c.params).toEqual(["zh-TW"]);
    expect(c.sql).toContain(`"locale" = ?`);
  });

  it("binds the normalized site-local user id for $ctx.user filters", () => {
    const c = compileView(
      view({
        from: "orders",
        filter: { eq: { field: "userId", value: { "$ctx.user": "id" } } },
      }),
      { ctxUserId: "site-user-1" },
    );
    expect(c.params).toEqual(["site-user-1"]);
    expect(c.sql).toContain(`"userId" = ?`);
    expect(() => compileView(
      view({
        from: "orders",
        filter: { eq: { field: "userId", value: { "$ctx.user": "id" } } },
      }),
    )).toThrow(/requires ctx\.user\.id/);
  });

  it("rejects a missing required filter param", () => {
    expect(() => compileView(
      view({
        from: "posts",
        filter: {
          and: [
            { eq: { field: "status", value: "published" } },
            { eq: { field: "locale", value: { $param: "locale" } } },
          ],
        },
      }),
      { params: {} },
    )).toThrow(/requires param 'locale'/);
  });

  it("quotes hyphenated native column names", () => {
    const c = compileView(
      view({
        from: "posts",
        fields: ["hero-image"],
        filter: { eq: { field: "hero-image", value: "x" } },
      }),
    );
    expect(c.sql).toContain(`"hero-image"`);
    expect(c.sql).toMatch(/AS "hero-image"/);
    expect(c.params).toEqual(["x"]);
  });

  it("safely quotes single quotes in native column names", () => {
    const c = compileView(
      view({
        from: "posts",
        filter: { eq: { field: `foo'bar`, value: "x" } },
      }),
    );
    expect(c.sql).toContain(`"foo'bar"`);
    expect(c.params).toEqual(["x"]);
  });

  it("rejects field names that Schema validation cannot represent", () => {
    expect(() => compileView(view({
      from: "posts",
      filter: { eq: { field: `title\"; DROP TABLE posts; --`, value: "x" } },
    }))).toThrow(/unrepresentable character/);
  });

  it("clamps caller-supplied show to View.spec.limit (server-enforced cap)", () => {
    const c = compileView(view({ from: "posts", limit: 10 }), { show: 1000 });
    expect(c.effectiveShow).toBe(10);
    expect(c.sql).toMatch(/LIMIT 10 OFFSET 0/);
  });

  it("page=2 emits OFFSET = (page-1) * show", () => {
    const c = compileView(view({ from: "posts", limit: 20 }), { page: 2, show: 5 });
    expect(c.effectivePage).toBe(2);
    expect(c.effectiveShow).toBe(5);
    expect(c.sql).toMatch(/LIMIT 5 OFFSET 5/);
  });

  it("page < 1 falls back to page=1", () => {
    const c = compileView(view({ from: "posts" }), { page: 0 });
    expect(c.effectivePage).toBe(1);
  });

  it("maps orderBy direction to a closed ASC/DESC set, never the raw value (#392)", () => {
    const c = compileView(
      view({
        from: "posts",
        // Out-of-enum value that a YAML manifest could carry past the
        // compile-time "asc"|"desc" type.
        orderBy: [{ field: "id", direction: "DESC LIMIT 0 --" as "asc" }],
      }),
    );
    expect(c.sql).not.toContain("LIMIT 0 --");
    expect(c.sql).toMatch(/ORDER BY _mantle_id ASC/); // anything not "desc" → ASC
  });

  it("emits DESC only for an exact \"desc\" (#392)", () => {
    const c = compileView(view({ from: "posts", orderBy: [{ field: "id", direction: "desc" }] }));
    expect(c.sql).toMatch(/ORDER BY _mantle_id DESC/);
  });

  it("caps a huge ?page= so OFFSET stays a plain in-range integer (#397)", () => {
    const c = compileView(view({ from: "posts" }), { page: 1e21, show: 50 });
    const offset = c.sql.match(/OFFSET (\S+)/)?.[1] ?? "";
    expect(offset).not.toMatch(/e/i); // no exponential notation
    expect(Number(offset)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });
});

describe("ExecuteViewUseCase", () => {
  it("returns UNAUTHENTICATED when an identity-bound View reaches runtime without ctx.user", async () => {
    const manifest = view({
      from: "orders",
      filter: { eq: { field: "userId", value: { "$ctx.user": "id" } } },
    });
    const result = await sqliteUseCase(new InMemoryDatabase(), manifest).execute({
      view: manifest,
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: { code: "UNAUTHENTICATED", phase: "runtime" },
    });
  });

  it("returns only rows owned by the normalized ctx.user", async () => {
    const db = new InMemoryDatabase();
    const orders = nativeSchema("orders", {
      userId: { type: "string" },
      placedAt: { type: "integer" },
    });
    await seed(db, orders, [
      ["o1", "user-a", "published", 3],
      ["o2", "user-b", "published", 2],
      ["o3", "user-a", "draft", 1],
    ].map(([id, userId, status, placedAt]) => ({
      id: id as string,
      status: status as "draft" | "published",
      data: { userId, placedAt },
      now: placedAt as number,
    })));
    const manifest = view({
      from: "orders",
      fields: ["id"],
      requires: { auth: { all: ["ctx.user"] } },
      filter: {
        and: [
          { eq: { field: "status", value: "published" } },
          { eq: { field: "userId", value: { "$ctx.user": "id" } } },
        ],
      },
    });
    const useCase = sqliteUseCase(db, manifest, undefined, [orders]);
    const result = await useCase.execute({
      view: manifest,
      ctx: {
        user: { id: "user-a" },
        staff: null,
        env: {},
        request: new Request("https://example.test/api/views/my-orders"),
        waitUntil: () => {},
      },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostic));
    expect(result.result.rows).toEqual([{ id: "o1" }]);
  });

  it("normalizes SQLite JSON projections to the generated View row shape", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => [{
            enabled: 1,
            disabled: 0,
            optional: null,
            config: '{"version":1}',
            tags: '["one","two"]',
            count: 1,
          }],
        }),
      }),
    } as unknown as DatabaseDriver;
    const schema: SchemaManifest = {
      apiVersion: "cms.mantle.aotter.net/v1",
      kind: "Schema",
      metadata: { name: "settings" },
      spec: {
        title: "Settings",
        schema: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            disabled: { type: "boolean" },
            optional: { type: ["boolean", "null"] },
            config: { type: ["object", "null"] },
            tags: { type: "array" },
            count: { type: "integer" },
          },
        },
        localized: false,
        lifecycle: "operational",
      },
    };
    const manifest = view({
      from: "settings",
      fields: ["enabled", "disabled", "optional", "config", "tags", "count"],
    });
    const useCase = sqliteUseCase(db, manifest, undefined, [schema]);
    const result = await useCase.execute({
      view: manifest,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rows).toEqual([
      {
        enabled: true,
        disabled: false,
        optional: null,
        config: { version: 1 },
        tags: ["one", "two"],
        count: 1,
      },
    ]);
  });

  it("returns published entries for a status=published filter", async () => {
    const db = new InMemoryDatabase();
    const posts = nativeSchema("posts", { title: { type: "string" } });
    await seed(db, posts, [
      { id: "p1", status: "published", data: { title: "Hi" }, now: 2 },
      { id: "p2", status: "draft", data: { title: "Drafty" }, now: 3 },
    ]);
    const manifest = view({
      from: "posts",
      filter: { eq: { field: "status", value: "published" } },
    });
    const useCase = sqliteUseCase(db, manifest, undefined, [posts]);
    const result = await useCase.execute({
      view: manifest,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rows).toHaveLength(1);
    expect((result.result.rows[0] as { id: string }).id).toBe("p1");
    expect(result.result.page).toBe(1);
    expect(result.result.hasMore).toBe(false);
  });

  it("returns entries matching comparison filter ranges", async () => {
    const db = new InMemoryDatabase();
    const movements = nativeSchema("stock-movements", {
      occurredAt: { type: "string" }, quantity: { type: "integer" },
    });
    await seed(db, movements, [
      { id: "m1", status: "published", data: { occurredAt: "2026-06-10T00:00:00Z", quantity: 3 }, now: 1 },
      { id: "m2", status: "published", data: { occurredAt: "2026-07-02T00:00:00Z", quantity: 5 }, now: 2 },
      { id: "m3", status: "published", data: { occurredAt: "2026-06-15T00:00:00Z", quantity: -1 }, now: 3 },
    ]);

    const manifest = view({
      from: "stock-movements",
      filter: {
        and: [
          { gte: { field: "occurredAt", value: "2026-06-01T00:00:00Z" } },
          { lt: { field: "occurredAt", value: "2026-07-01T00:00:00Z" } },
          { gt: { field: "quantity", value: 0 } },
        ],
      },
    });
    const useCase = sqliteUseCase(db, manifest, undefined, [movements]);
    const result = await useCase.execute({
      view: manifest,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rows.map((r) => (r as { id: string }).id)).toEqual(["m1"]);
  });

  it("rejects an auth-gated View when ctx is missing (UNAUTHENTICATED)", async () => {
    const db = new InMemoryDatabase();
    const manifest = view({
      from: "posts",
      requires: { auth: { all: ["ctx.user"] } },
    });
    const useCase = sqliteUseCase(db, manifest);
    const result = await useCase.execute({
      view: manifest,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("UNAUTHENTICATED");
  });

  it("denies an auth-gated View when the predicate fails (AUTH_DENIED)", async () => {
    const db = new InMemoryDatabase();
    const manifest = view({
      from: "posts",
      requires: { auth: { all: [{ "ctx.staff": ["owner"] }] } },
    });
    const useCase = sqliteUseCase(db, manifest);
    const result = await useCase.execute({
      view: manifest,
      ctx: {
        user: { id: "u1" },
        staff: null,
        env: {},
        request: new Request("https://example.com/"),
        waitUntil: () => {},
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("AUTH_DENIED");
  });

  it("allows an auth-gated View when the staff role matches", async () => {
    const db = new InMemoryDatabase();
    const posts = nativeSchema("posts", { title: { type: "string" } });
    await seed(db, posts, [{ id: "p1", status: "published", data: { title: "Hi" }, now: 2 }]);
    const manifest = view({
      from: "posts",
      requires: { auth: { all: [{ "ctx.staff": ["owner"] }] } },
    });
    const useCase = sqliteUseCase(db, manifest, undefined, [posts]);
    const result = await useCase.execute({
      view: manifest,
      ctx: {
        user: { id: "u1" },
        staff: { id: "u1", role: "owner" },
        env: {},
        request: new Request("https://example.com/"),
        waitUntil: () => {},
      },
    });
    expect(result.ok).toBe(true);
  });

  it("authenticates, validates params, then invokes the dynamic guard before querying", async () => {
    const db = new InMemoryDatabase();
    const calls: string[] = [];
    const guardedView = view({
      from: "posts",
      params: {
        type: "object",
        properties: { accountId: { type: "string" } },
        required: ["accountId"],
      },
      requires: {
        auth: { all: ["ctx.auth"] },
        guard: { procedure: "requirePaid" },
      },
    });
    const useCase = sqliteUseCase(db, guardedView, async (request) => {
      calls.push(`guard:${String(request.input["accountId"])}`);
      return {
        ok: false,
        diagnostic: runtimeDiagnostic({
          code: "ENTITLEMENT_REQUIRED",
          severity: "error",
          path: "site:entitlement",
          message: "payment required",
        }),
      };
    });

    const anonymous = await useCase.execute({
      view: guardedView,
      options: { params: {} },
      ctx: { user: null, staff: null, env: {} },
    });
    expect(anonymous.ok).toBe(false);
    if (!anonymous.ok) expect(anonymous.diagnostic.code).toBe("UNAUTHENTICATED");
    expect(calls).toEqual([]);

    const ctx = {
      user: null,
      staff: null,
      auth: {
        credential: "api-key" as const,
        credentialId: "key-1",
        clientId: null,
        scopes: [] as readonly string[],
      },
      env: {},
    };
    const invalid = await useCase.execute({
      view: guardedView,
      options: { params: {} },
      ctx,
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.diagnostic.code).toBe("INPUT_VALIDATION_FAILED");
    expect(calls).toEqual([]);

    const denied = await useCase.execute({
      view: guardedView,
      options: { params: { accountId: "acct-1" } },
      ctx,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.diagnostic.code).toBe("ENTITLEMENT_REQUIRED");
    expect(calls).toEqual(["guard:acct-1"]);
  });

  it("hasMore=true when result fills the requested page exactly", async () => {
    const db = new InMemoryDatabase();
    const posts = nativeSchema("posts", { title: { type: "string" } });
    await seed(db, posts, Array.from({ length: 4 }, (_, index) => ({
      id: `p${index + 1}`, status: "published" as const,
      data: { title: `t${index + 1}` }, now: index + 1,
    })));
    const manifest = view({ from: "posts" });
    const useCase = sqliteUseCase(db, manifest, undefined, [posts]);
    const result = await useCase.execute({
      view: manifest,
      options: { show: 2 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rows).toHaveLength(2);
    expect(result.result.hasMore).toBe(true);
  });
});
