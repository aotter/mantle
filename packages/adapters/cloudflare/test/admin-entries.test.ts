import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Manifest } from "@aotter/mantle-spec";
import { createCmsRef } from "../src/mount/bootRuntimeOnce.js";
import { mountServerEndpoints } from "../src/mount/mountServerEndpoints.js";
import type { Auth } from "../src/auth/createAuth.js";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import {
  StubAssetServer,
  stubAuth,
} from "./fakes/runtime-bindings.js";

/** `/admin/api/entries` search param + `/admin/api/entries/export`
 *  CSV export contract (#423, #427). Auth is a scripted staff session
 *  — see `mount-staff-admin.test.ts` for the owner/editor gating
 *  tests; here we only need "is staff" to exercise the entries
 *  routes. */

function manifests(): Manifest[] {
  const apiVersion = "cms.mantle.aotter.net/v1" as const;
  return [
    {
      apiVersion,
      kind: "Schema",
      metadata: { name: "posts" },
      spec: {
        title: "Posts",
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            slug: { type: "string" },
          },
          required: ["slug"],
        },
        lifecycle: "publishing",
      },
    },
  ];
}

function sessionAsStaff() {
  return async () => ({
    session: { id: "s-1", userId: "user-1", expiresAt: new Date(Date.now() + 60_000) },
    user: {
      id: "user-1",
      email: "tester@example.com",
      name: "Tester",
      role: "editor",
      githubLogin: null,
    },
  });
}

function testAuth(authOverride?: Partial<Auth>): Auth {
  const getSession = authOverride?.getSession ?? sessionAsStaff();
  return {
    ...stubAuth,
    ...authOverride,
    getSession,
    getUserRole:
      authOverride?.getUserRole ??
      (async (userId) => {
        const session = await getSession(new Request("https://example.test/"));
        return session?.user.id === userId ? (session.user.role ?? null) : null;
      }),
  };
}

function harness(
  seed?: (db: InMemoryDatabase) => void,
  authOverride?: Partial<Auth>,
  manifestSet: Manifest[] = manifests(),
) {
  const db = new InMemoryDatabase();
  if (seed) seed(db);
  const auth = testAuth(authOverride);
  const ref = createCmsRef({
    manifests: manifestSet,
    bindings: {
      db,
      assets: new StubAssetServer(),
    },
    auth,
  });
  const app = new Hono();
  mountServerEndpoints(app, ref);
  return { app, db };
}

function relatedManifests(): Manifest[] {
  const apiVersion = "cms.mantle.aotter.net/v1" as const;
  const schema = (
    name: string,
    properties: Record<string, { type: "string"; "x-mantle-ref"?: string }>,
    required: string[] = [],
  ): Manifest => ({
    apiVersion,
    kind: "Schema",
    metadata: { name },
    spec: {
      title: name,
      schema: { type: "object", properties, required },
      lifecycle: "publishing",
    },
  });
  return [
    schema("parents", {
      key: { type: "string" },
    }),
    schema("comments", { parentId: { type: "string", "x-mantle-ref": "parents" } }, ["parentId"]),
    schema("reactions", { parentId: { type: "string", "x-mantle-ref": "parents" } }),
    schema("legacy-children", { parentKey: { type: "string" } }),
  ];
}

function relatedRow(
  id: string,
  collection: string,
  status: "draft" | "published" | "archived",
  data: Record<string, unknown>,
  updatedAt: number,
) {
  return {
    id,
    collection,
    status,
    version: 1,
    data: JSON.stringify(data),
    author_id: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

function row(id: string, data: Record<string, unknown>, updatedAt = 1) {
  return {
    id,
    collection: "posts",
    status: "draft",
    version: 1,
    data: JSON.stringify(data),
    author_id: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

describe("GET /admin/api/entries?search=", () => {
  it("reuses the role already loaded with the session", async () => {
    let roleReads = 0;
    const { app } = harness(undefined, {
      getUserRole: async () => {
        roleReads++;
        return "editor";
      },
    });
    const res = await app.request("/admin/api/entries?collection=posts");
    expect(res.status).toBe(200);
    expect(roleReads).toBe(0);
  });

  it("filters rows whose id or data matches the search term", async () => {
    const { app } = harness((db) => {
      db.entries.set("p1", row("p1", { title: "Hello world", slug: "hello" }));
      db.entries.set("p2", row("p2", { title: "Goodbye", slug: "goodbye" }));
    });
    const res = await app.request("/admin/api/entries?collection=posts&search=hello");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe("p1");
  });

  it("matches on id even when the term isn't in the data blob", async () => {
    const { app } = harness((db) => {
      db.entries.set("special-id", row("special-id", { title: "x", slug: "x" }));
      db.entries.set("other", row("other", { title: "y", slug: "y" }));
    });
    const res = await app.request("/admin/api/entries?collection=posts&search=special");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe("special-id");
  });

  it("composes with status filtering", async () => {
    const { app, db } = harness((database) => {
      database.entries.set("p1", row("p1", { title: "Hello world", slug: "hello" }));
    });
    db.entries.get("p1")!.status = "published";
    const res = await app.request(
      "/admin/api/entries?collection=posts&search=hello&status=draft",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(0);
  });

  it("returns no rows when the search term matches nothing", async () => {
    const { app } = harness((db) => {
      db.entries.set("p1", row("p1", { title: "Hello world", slug: "hello" }));
    });
    const res = await app.request("/admin/api/entries?collection=posts&search=nope");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });
});

describe("GET /admin/api/entries/export", () => {
  it("streams a BOM-prefixed CSV with a header row and one row per entry", async () => {
    const { app } = harness((db) => {
      db.entries.set("p1", row("p1", { title: "Hello world", slug: "hello" }, 100));
    });
    const res = await app.request("/admin/api/entries/export?collection=posts");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="posts.csv"',
    );
    // `Response.text()` decodes via `TextDecoder`, which strips a
    // leading BOM per the Encoding spec — assert on the raw bytes
    // instead so the assertion reflects what's actually on the wire
    // (Excel needs the BOM bytes, not what a BOM-stripping consumer
    // sees).
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toBe("id,status,version,updated_at,title,slug");
    expect(lines[1]).toBe("p1,draft,1,100,Hello world,hello");
  });

  it("streams every row across multiple internal pages", async () => {
    const { app } = harness((db) => {
      for (let i = 0; i < 5; i++) {
        db.entries.set(`p${i}`, row(`p${i}`, { title: `t${i}`, slug: `s${i}` }, i));
      }
    });
    const res = await app.request("/admin/api/entries/export?collection=posts");
    const text = await res.text();
    const lines = text.trim().split("\r\n");
    // header + 5 data rows
    expect(lines).toHaveLength(6);
  });

  it("404s on an unknown collection", async () => {
    const { app } = harness();
    const res = await app.request("/admin/api/entries/export?collection=ghost");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { diagnostic: { code: string } };
    expect(body.diagnostic.code).toBe("NOT_FOUND");
  });

  it("404s when collection is missing entirely", async () => {
    const { app } = harness();
    const res = await app.request("/admin/api/entries/export");
    expect(res.status).toBe(404);
  });

  it("401s with no session", async () => {
    const { app } = harness(undefined, { getSession: async () => null });
    const res = await app.request("/admin/api/entries/export?collection=posts");
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/api/entries/:id related entries", () => {
  it("uses explicit refs, keeps all-status ordering, and caps each section at 50 rows", async () => {
    const { app, db } = harness((database) => {
      database.entries.set(
        "parent",
        relatedRow("parent", "parents", "draft", {
          key: "alpha",
        }, 1),
      );
      for (let index = 0; index < 55; index += 1) {
        database.entries.set(
          `string-${index}`,
          relatedRow(
            `string-${index}`,
            "comments",
            index % 2 === 0 ? "published" : "archived",
            { parentId: "parent" },
            index,
          ),
        );
      }
      database.entries.set(
        "reaction-a",
        relatedRow("reaction-a", "reactions", "draft", { parentId: "parent" }, 100),
      );
      database.entries.set(
        "reaction-z",
        relatedRow("reaction-z", "reactions", "archived", { parentId: "parent" }, 100),
      );
      database.entries.set(
        "legacy",
        relatedRow("legacy", "legacy-children", "published", { parentKey: "alpha" }, 1),
      );
    }, undefined, relatedManifests());

    const res = await app.request("/admin/api/entries/parent");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      related: Array<{
        collection: {
          name: string;
          parent: { collection: string; parentField: string; childField: string } | null;
        };
        entries: Array<{ id: string; status: string }>;
      }>;
    };
    const byCollection = new Map(
      body.related.map((section) => [section.collection.name, section.entries]),
    );
    const strings = byCollection.get("comments")!;
    expect(strings).toHaveLength(50);
    expect(strings.slice(0, 2).map(({ id }) => id)).toEqual(["string-54", "string-53"]);
    expect(new Set(strings.map(({ status }) => status))).toEqual(
      new Set(["published", "archived"]),
    );
    expect(byCollection.get("reactions")?.map(({ id }) => id)).toEqual([
      "reaction-z",
      "reaction-a",
    ]);
    expect(body.related.find(({ collection }) => collection.name === "comments")?.collection.parent)
      .toEqual({ collection: "parents", parentField: "id", childField: "parentId" });
    expect(body.related.find(({ collection }) => collection.name === "reactions")?.collection.parent)
      .toBeNull();
    expect(byCollection.has("legacy-children")).toBe(false);
    const relatedReads = db.executions.filter(({ sql }) =>
      sql.includes("ORDER BY updated_at DESC, id DESC LIMIT 50")
    );
    expect(relatedReads).toHaveLength(2);
    expect(relatedReads.every(({ sql }) =>
      sql.includes("json_extract(data, ?) = ?")
    )).toBe(true);
  });
});
