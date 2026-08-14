import { describe, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { compileView } from "../src/domain/service/ViewSqlCompiler.js";
import { ExecuteViewUseCase } from "../src/usecase/view/ExecuteViewUseCase.js";
import { InMemoryDatabase } from "./fakes/database.js";
import {
  runtimeDiagnostic,
  buildSchemaSqlView,
  type SchemaManifest,
  type ViewManifest,
} from "@aotter/mantle-spec";
import type { DatabaseDriver } from "../src/domain/port/DatabaseDriver.js";

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
      db.exec(`CREATE TABLE entries (
        id TEXT, collection TEXT, status TEXT, version INTEGER, data TEXT,
        author_id TEXT, created_at INTEGER, updated_at INTEGER
      )`);
      db.exec(buildSchemaSqlView(orders).createSql);
      db.prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        "o1", "orders", "published", 1,
        JSON.stringify({
          orderStatus: "paid",
          items: [
            { title: "Tea", quantity: 2 },
            { title: "Cake", quantity: 1 },
          ],
        }),
        null, 1, 1,
      );
      const compiled = compileView(view({
        sql: `SELECT o.id AS orderId,
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
    expect(c.sql).toContain("FROM entries WHERE collection = ?");
    expect(c.sql).toContain("LIMIT");
    expect(c.params).toEqual(["posts"]);
  });

  it("compiles `eq` filter with parameter binding", () => {
    const c = compileView(
      view({ from: "posts", filter: { eq: { field: "status", value: "published" } } }),
    );
    expect(c.params).toEqual(["posts", "published"]);
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
      "stock-movements",
      "2026-06-01T00:00:00Z",
      "2026-07-01T00:00:00Z",
      0,
    ]);
    expect(c.sql).toContain(`json_extract(data, '$."occurredAt"') >= ?`);
    expect(c.sql).toContain(`json_extract(data, '$."occurredAt"') < ?`);
    expect(c.sql).toContain(`json_extract(data, '$."quantity"') > ?`);
  });

  it("non-reserved field uses json_extract", () => {
    const c = compileView(
      view({
        from: "posts",
        filter: { eq: { field: "locale", value: "en-US" } },
      }),
    );
    expect(c.sql).toContain(`json_extract(data, '$."locale"') = ?`);
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
    expect(c.params).toEqual(["posts", "published", "en-US"]);
    expect(c.sql).toMatch(/AND/);
  });

  it("orderBy + limit compile through", () => {
    const c = compileView(
      view({
        from: "posts",
        orderBy: [{ field: "updatedAt", direction: "desc" }],
        limit: 5,
      }),
    );
    expect(c.sql).toMatch(/ORDER BY updated_at DESC/);
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
    expect(c.params).toEqual(["posts", "zh-TW"]);
    expect(c.sql).toContain(`json_extract(data, '$."locale"') = ?`);
  });

  it("binds the normalized site-local user id for $ctx.user filters", () => {
    const c = compileView(
      view({
        from: "orders",
        filter: { eq: { field: "userId", value: { "$ctx.user": "id" } } },
      }),
      { ctxUserId: "site-user-1" },
    );
    expect(c.params).toEqual(["orders", "site-user-1"]);
    expect(c.sql).toContain(`json_extract(data, '$."userId"') = ?`);
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

  it("accepts hyphenated field names via quoted JSON paths (#210 PR14 / codex CX3)", () => {
    // Schema property keys are arbitrary JSON strings per RFC 8259;
    // the prior identifier-only allowlist rejected legitimate
    // manifests at query time. Now we always quote the path + alias.
    const c = compileView(
      view({
        from: "posts",
        fields: ["hero-image"],
        filter: { eq: { field: "hero-image", value: "x" } },
      }),
    );
    expect(c.sql).toContain(`json_extract(data, '$."hero-image"')`);
    expect(c.sql).toMatch(/AS "hero-image"/);
    expect(c.params).toEqual(["posts", "x"]);
  });

  it("safely escapes single quotes in field names without rejecting them", () => {
    // Outer SQL literal uses `'...'` so inner `'` doubles to `''`;
    // the field still resolves to the original key at JSON path time.
    const c = compileView(
      view({
        from: "posts",
        filter: { eq: { field: `foo'bar`, value: "x" } },
      }),
    );
    expect(c.sql).toContain(`json_extract(data, '$."foo''bar"')`);
    expect(c.params).toEqual(["posts", "x"]);
  });

  it("rejects field names containing `\"`, `\\`, or NUL (SQLite JSON path can't resolve them)", () => {
    // SQLite JSON1 path syntax `$."key"` has no documented escape for
    // an inner `"` or `\`. Codex CX3 follow-up: previously this PR
    // tried to escape via doubling but SQLite returns NULL for such
    // paths. Reject instead — Schema authors don't write these.
    for (const bad of [`foo"bar`, `foo\\bar`, "foo\0bar"]) {
      expect(() =>
        compileView(
          view({ from: "posts", filter: { eq: { field: bad, value: "x" } } }),
        ),
      ).toThrow(/unrepresentable character|NUL|"|\\/);
    }
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
    expect(c.sql).toMatch(/ORDER BY id ASC/); // anything not "desc" → ASC
  });

  it("emits DESC only for an exact \"desc\" (#392)", () => {
    const c = compileView(view({ from: "posts", orderBy: [{ field: "id", direction: "desc" }] }));
    expect(c.sql).toMatch(/ORDER BY id DESC/);
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
    const result = await new ExecuteViewUseCase(new InMemoryDatabase()).execute({
      view: view({
        from: "orders",
        filter: { eq: { field: "userId", value: { "$ctx.user": "id" } } },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: { code: "UNAUTHENTICATED", phase: "runtime" },
    });
  });

  it("returns only rows owned by the normalized ctx.user", async () => {
    const db = new InMemoryDatabase();
    for (const [id, userId, status, placedAt] of [
      ["o1", "user-a", "published", 3],
      ["o2", "user-b", "published", 2],
      ["o3", "user-a", "draft", 1],
    ] as const) {
      db.entries.set(id, {
        id,
        collection: "orders",
        status,
        version: 1,
        data: JSON.stringify({ userId, placedAt }),
        author_id: null,
        created_at: placedAt,
        updated_at: placedAt,
      });
    }
    const useCase = new ExecuteViewUseCase(db);
    const result = await useCase.execute({
      view: view({
        from: "orders",
        fields: ["id"],
        requires: { auth: { all: ["ctx.user"] } },
        filter: {
          and: [
            { eq: { field: "status", value: "published" } },
            { eq: { field: "userId", value: { "$ctx.user": "id" } } },
          ],
        },
      }),
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
    const useCase = new ExecuteViewUseCase(db, undefined, new Map([["settings", schema]]));

    const result = await useCase.execute({
      view: view({
        from: "settings",
        fields: ["enabled", "disabled", "optional", "config", "tags", "count"],
      }),
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
    db.entries.set("p1", {
      id: "p1",
      collection: "posts",
      status: "published",
      version: 1,
      data: JSON.stringify({ title: "Hi" }),
      author_id: null,
      created_at: 1,
      updated_at: 2,
    });
    db.entries.set("p2", {
      id: "p2",
      collection: "posts",
      status: "draft",
      version: 1,
      data: JSON.stringify({ title: "Drafty" }),
      author_id: null,
      created_at: 1,
      updated_at: 3,
    });
    const useCase = new ExecuteViewUseCase(db);
    const result = await useCase.execute({
      view: view({
        from: "posts",
        filter: { eq: { field: "status", value: "published" } },
      }),
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
    db.entries.set("m1", {
      id: "m1",
      collection: "stock-movements",
      status: "published",
      version: 1,
      data: JSON.stringify({ occurredAt: "2026-06-10T00:00:00Z", quantity: 3 }),
      author_id: null,
      created_at: 1,
      updated_at: 1,
    });
    db.entries.set("m2", {
      id: "m2",
      collection: "stock-movements",
      status: "published",
      version: 1,
      data: JSON.stringify({ occurredAt: "2026-07-02T00:00:00Z", quantity: 5 }),
      author_id: null,
      created_at: 2,
      updated_at: 2,
    });
    db.entries.set("m3", {
      id: "m3",
      collection: "stock-movements",
      status: "published",
      version: 1,
      data: JSON.stringify({ occurredAt: "2026-06-15T00:00:00Z", quantity: -1 }),
      author_id: null,
      created_at: 3,
      updated_at: 3,
    });

    const useCase = new ExecuteViewUseCase(db);
    const result = await useCase.execute({
      view: view({
        from: "stock-movements",
        filter: {
          and: [
            { gte: { field: "occurredAt", value: "2026-06-01T00:00:00Z" } },
            { lt: { field: "occurredAt", value: "2026-07-01T00:00:00Z" } },
            { gt: { field: "quantity", value: 0 } },
          ],
        },
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rows.map((r) => (r as { id: string }).id)).toEqual(["m1"]);
  });

  it("rejects an auth-gated View when ctx is missing (UNAUTHENTICATED)", async () => {
    const db = new InMemoryDatabase();
    const useCase = new ExecuteViewUseCase(db);
    const result = await useCase.execute({
      view: view({
        from: "posts",
        requires: { auth: { all: ["ctx.user"] } },
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe("UNAUTHENTICATED");
  });

  it("denies an auth-gated View when the predicate fails (AUTH_DENIED)", async () => {
    const db = new InMemoryDatabase();
    const useCase = new ExecuteViewUseCase(db);
    const result = await useCase.execute({
      view: view({
        from: "posts",
        requires: { auth: { all: [{ "ctx.staff": ["owner"] }] } },
      }),
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
    db.entries.set("p1", {
      id: "p1",
      collection: "posts",
      status: "published",
      version: 1,
      data: JSON.stringify({ title: "Hi" }),
      author_id: null,
      created_at: 1,
      updated_at: 2,
    });
    const useCase = new ExecuteViewUseCase(db);
    const result = await useCase.execute({
      view: view({
        from: "posts",
        requires: { auth: { all: [{ "ctx.staff": ["owner"] }] } },
      }),
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
    const useCase = new ExecuteViewUseCase(db, async (request) => {
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
    for (let i = 1; i <= 4; i++) {
      db.entries.set(`p${i}`, {
        id: `p${i}`,
        collection: "posts",
        status: "published",
        version: 1,
        data: JSON.stringify({ title: `t${i}` }),
        author_id: null,
        created_at: i,
        updated_at: i,
      });
    }
    const useCase = new ExecuteViewUseCase(db);
    const result = await useCase.execute({
      view: view({ from: "posts" }),
      options: { show: 2 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rows).toHaveLength(2);
    expect(result.result.hasMore).toBe(true);
  });
});
