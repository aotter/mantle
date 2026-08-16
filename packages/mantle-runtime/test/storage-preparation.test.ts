import {
  linkManifestSet,
  parseManifestSources,
  type LinkedManifestSet,
} from "@aotter/mantle-spec";
import { describe, expect, it } from "vitest";
import type {
  MantleStorageAdapter,
  PreparedMantleStorage,
  ViewQueryExecutor,
} from "../src/domain/port/index.js";
import {
  compileRuntimePlan,
  type RuntimePlan,
} from "../src/domain/service/RuntimePlanCompiler.js";
import { SqliteMantleStorageAdapter } from "../src/infrastructure/storage/SqliteMantleStorageAdapter.js";
import {
  BootValidationError,
  prepareDeployment,
} from "../src/usecase/boot/ValidateBootUseCase.js";
import { InMemoryDatabase } from "./fakes/database.js";
import { InMemoryEntryRepository } from "./fakes/in-memory-store.js";

describe("prepareDeployment", () => {
  it("prepares an official adapter over an existing database handle once", async () => {
    const db = new InMemoryDatabase();
    const plan = compilePlan(declarativeManifest);
    const adapter = new SqliteMantleStorageAdapter(db, { locales: ["en"] });
    const prepared = await prepareDeployment(plan, adapter);

    expect(await prepared.localePolicy?.readLocales()).toEqual(["en"]);

    await prepared.entries.create({
      id: "post-1",
      collection: "posts",
      status: "published",
      data: { title: "Hello" },
      authorId: null,
      now: 1,
    });
    const result = await prepared.views.execute<{ id: string; title: string }>({
      view: "published-posts",
    });
    expect(result.rows).toEqual([{ id: "post-1", title: "Hello" }]);

    const before = db.executions.length;
    await prepareDeployment(plan, adapter);
    expect(db.executions.slice(before).map(({ sql }) => sql)).toEqual([
      "SELECT fingerprint FROM _mantle_boot_state WHERE id = ? LIMIT 1",
    ]);
  });

  it("accepts application-owned semantic ports without a table mapping DSL", async () => {
    const entries = new InMemoryEntryRepository();
    const views: ViewQueryExecutor = {
      async execute(request) {
        const page = await entries.list({
          collection: "posts",
          status: "published",
          limit: request.show,
        });
        return {
          rows: page.rows.map((row) => ({ id: row.id, title: row.data["title"] })),
          page: request.page ?? 1,
          show: request.show ?? 50,
          hasMore: page.nextCursor !== undefined,
        };
      },
    };
    const storage: MantleStorageAdapter = {
      async prepare() {
        return { entries, views };
      },
    };
    const prepared = await prepareDeployment(compilePlan(declarativeManifest), storage);

    await prepared.entries.create({
      id: "app-post",
      collection: "posts",
      status: "published",
      data: { title: "Application table" },
      authorId: "app-user",
      now: 2,
    });
    expect((await prepared.views.execute({ view: "published-posts" })).rows).toEqual([
      { id: "app-post", title: "Application table" },
    ]);
    expect(await prepared.entries.readPublished()).toEqual([
      expect.objectContaining({ id: "app-post", data: { title: "Application table" } }),
    ]);
  });

  it("rejects an unsupported native dialect before touching storage", async () => {
    let called = false;
    const storage: MantleStorageAdapter = {
      async prepare(): Promise<PreparedMantleStorage> {
        called = true;
        throw new Error("must not prepare");
      },
    };

    await expect(prepareDeployment(compilePlan(nativeManifest), storage))
      .rejects.toMatchObject<Partial<BootValidationError>>({
        diagnostics: [expect.objectContaining({
          code: "VIEW_DIALECT_UNSUPPORTED",
          phase: "boot",
          value: "sqlite",
        })],
      });
    expect(called).toBe(false);
  });

  it("checks handler and selected-route readiness before touching storage", async () => {
    let called = false;
    const storage: MantleStorageAdapter = {
      async prepare(): Promise<PreparedMantleStorage> {
        called = true;
        throw new Error("must not prepare");
      },
    };

    await expect(prepareDeployment(compilePlan(handlerManifest), storage, {
      handlerNames: [],
      reservedHttpPathPrefixes: ["/api/app"],
    }))
      .rejects.toMatchObject({
        diagnostics: [
          expect.objectContaining({ code: "HANDLER_NOT_REGISTERED" }),
          expect.objectContaining({ code: "TRIGGER_PATH_INVALID" }),
        ],
      });
    expect(called).toBe(false);
  });

  it("lets a read-only embedding omit unrelated Procedure handlers", async () => {
    const prepared = await prepareDeployment(
      compilePlan(handlerManifest),
      new SqliteMantleStorageAdapter(new InMemoryDatabase()),
    );

    expect(prepared.views).toBeDefined();
  });
});

function compilePlan(text: string): RuntimePlan {
  const linked = parseAndLink(text);
  const compiled = compileRuntimePlan(linked);
  if (!compiled.ok) throw new Error("expected compiled storage fixture");
  return compiled.value;
}

function parseAndLink(text: string): LinkedManifestSet {
  const parsed = parseManifestSources({
    sources: [{ sourceId: "memory:storage", text }],
  });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map((item) => item.message).join("\n"));
  return linked.value;
}

const declarativeManifest = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema:
    type: object
    properties:
      title: { type: string }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: published-posts }
spec:
  surface: public
  from: posts
  fields: [id, title]
  filter: { eq: { field: status, value: published } }
`;

const nativeManifest = `apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: native-report }
spec:
  surface: staff
  sql: SELECT 1 AS value
`;

const handlerManifest = `apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: app-handler }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: appHandler }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: app-route }
spec:
  source: { kind: http, method: POST, path: /api/app/run }
  target: { procedure: app-handler }
`;
