import { describe, expect, expectTypeOf, it } from "vitest";
import { DiagnosticError, type SchemaManifest } from "@aotter/mantle-spec";
import {
  ArchiveUseCase,
  CreateDraftUseCase,
  DeleteEntryUseCase,
  GetEntryUseCase,
  ListEntriesUseCase,
  RequestPublishUseCase,
  UnpublishUseCase,
  UpdateDraftUseCase,
} from "../src/usecase/content/index.js";
import type { Clock } from "../src/domain/port/Clock.js";
import type { EntryRepository } from "../src/domain/port/EntryRepository.js";
import type { IdGenerator } from "../src/domain/port/IdGenerator.js";
import type { SiteConfigRepository } from "../src/domain/port/SiteConfigRepository.js";
import type { ListEntriesResponse } from "../src/usecase/dto/content/index.js";
import { EntryVersionConflict, type EntryRow } from "../src/domain/model/EntryRow.js";
import { InMemoryEntryRepository } from "./fakes/in-memory-store.js";
import { postsSchema } from "./fakes/manifests.js";

const postsSchemaWithBindings: SchemaManifest = {
  ...postsSchema(),
  spec: {
    ...postsSchema().spec,
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        slug: { type: "string" },
        authorId: { type: "string", "x-mantle-bind": "ctx.user" },
        publishedAt: { type: "number", "x-mantle-bind": "now" },
      },
      required: ["title"],
    },
  },
};

interface Harness {
  store: InMemoryEntryRepository;
  schemas: ReadonlyMap<string, SchemaManifest>;
  clock: Clock;
  idgen: IdGenerator;
  createDraft: CreateDraftUseCase;
  updateDraft: UpdateDraftUseCase;
  getEntry: GetEntryUseCase;
  listEntries: ListEntriesUseCase;
  requestPublish: RequestPublishUseCase;
  unpublish: UnpublishUseCase;
  archive: ArchiveUseCase;
  deleteEntry: DeleteEntryUseCase;
}

function harness(opts: {
  schemas?: ReadonlyMap<string, SchemaManifest>;
  siteConfig?: SiteConfigRepository;
} = {}): Harness {
  const store = new InMemoryEntryRepository();
  const schemas = opts.schemas ?? new Map([[postsSchema().metadata.name, postsSchema()]]);
  let nextId = 1;
  const clock: Clock = { now: () => 1_000_000_000_000 };
  const idgen: IdGenerator = { next: () => `post-${nextId++}` };
  return {
    store,
    schemas,
    clock,
    idgen,
    createDraft: new CreateDraftUseCase(store, schemas, clock, idgen, opts.siteConfig),
    updateDraft: new UpdateDraftUseCase(store, schemas, clock, opts.siteConfig),
    getEntry: new GetEntryUseCase(store),
    listEntries: new ListEntriesUseCase(store, schemas),
    requestPublish: new RequestPublishUseCase(store, schemas, clock, undefined, opts.siteConfig),
    unpublish: new UnpublishUseCase(store, schemas, clock),
    archive: new ArchiveUseCase(store, schemas, clock),
    deleteEntry: new DeleteEntryUseCase(store),
  };
}

describe("CreateDraftUseCase", () => {
  it("creates a row in 'draft' status with version=1", async () => {
    const h = harness();
    const row = await h.createDraft.execute({
      collection: "posts",
      data: { title: "Hello" },
      authorId: "user-1",
    });
    expect(row.status).toBe("draft");
    expect(row.version).toBe(1);
    expect(row.data).toEqual({ title: "Hello" });
    expect(await h.store.get(row.id)).toEqual(row);
  });

  it("rejects an unknown collection with NOT_FOUND", async () => {
    const h = harness();
    await expect(
      h.createDraft.execute({ collection: "ghost", data: {}, authorId: null }),
    ).rejects.toBeInstanceOf(DiagnosticError);
  });

  it("saves an incomplete draft but blocks publishing it (required enforced at publish)", async () => {
    const h = harness(); // postsSchema requires `title`
    // Empty draft is allowed — a work-in-progress entry with `title` blank.
    const row = await h.createDraft.execute({
      collection: "posts",
      data: {},
      authorId: "user-1",
    });
    expect(row.status).toBe("draft");
    expect(row.data).toEqual({});
    // Publishing re-validates in full: the missing required field bites here.
    await expect(h.requestPublish.execute({ id: row.id })).rejects.toMatchObject({
      diagnostic: { code: "INPUT_VALIDATION_FAILED", path: "/title" },
    });
  });

  it("still type-checks present fields on an incomplete draft", async () => {
    const h = harness();
    // partial drops `required`, not type-safety: a wrong-typed value is rejected.
    await expect(
      h.createDraft.execute({
        collection: "posts",
        data: { title: 123 },
        authorId: null,
      }),
    ).rejects.toMatchObject({
      diagnostic: { code: "INPUT_VALIDATION_FAILED", path: "/title" },
    });
  });

  it("strips reserved metadata keys from caller-supplied data", async () => {
    const h = harness();
    const row = await h.createDraft.execute({
      collection: "posts",
      data: {
        title: "Hello",
        id: "spoofed-id",
        status: "published",
        version: 99,
        expectedVersion: 99,
        createdAt: 0,
        updatedAt: 0,
        authorId: "spoofed-author",
      },
      authorId: "user-1",
    });
    expect(row.id).not.toBe("spoofed-id");
    expect(row.status).toBe("draft");
    expect(row.version).toBe(1);
    expect(row.data).toEqual({ title: "Hello" });
  });

  it("projects Schema fields and stamps x-mantle-bind values", async () => {
    const h = harness({
      schemas: new Map([[postsSchemaWithBindings.metadata.name, postsSchemaWithBindings]]),
    });
    const row = await h.createDraft.execute({
      collection: "posts",
      data: {
        title: "Hello",
        slug: "hello",
        unknown: "drop-me",
        authorId: "spoofed-author",
        publishedAt: 123,
      },
      authorId: "user-1",
    });
    expect(row.data).toEqual({
      title: "Hello",
      slug: "hello",
      authorId: "user-1",
      publishedAt: 1_000_000_000_000,
    });
  });

  it("rejects data that fails the Schema after projection", async () => {
    const schema = {
      ...postsSchema(),
      spec: {
        ...postsSchema().spec,
        schema: {
          type: "object" as const,
          properties: {
            title: { type: "string" as const },
            slug: { type: "string" as const, pattern: "^[a-z0-9-]+$" },
          },
          required: ["title", "slug"],
        },
      },
    };
    const h = harness({ schemas: new Map([[schema.metadata.name, schema]]) });
    await expect(
      h.createDraft.execute({
        collection: "posts",
        data: { title: "Hello", slug: "Not A Slug" },
        authorId: null,
      }),
    ).rejects.toMatchObject({
      diagnostic: { code: "INPUT_VALIDATION_FAILED", path: "/slug" },
    });
  });

  it("rejects invalid email format in Schema-backed authoring paths", async () => {
    const schema: SchemaManifest = {
      apiVersion: "cms.mantle.aotter.net/v1",
      kind: "Schema",
      metadata: { name: "contact-messages" },
      spec: {
        title: "Contact messages",
        schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string", format: "email" },
            message: { type: "string" },
          },
          required: ["name", "email", "message"],
        },
        lifecycle: "simple",
      },
    };
    const h = harness({ schemas: new Map([[schema.metadata.name, schema]]) });
    await expect(
      h.createDraft.execute({
        collection: "contact-messages",
        data: { name: "A", email: "not-email", message: "Hi" },
        authorId: null,
      }),
    ).rejects.toMatchObject({
      diagnostic: { code: "INPUT_VALIDATION_FAILED", path: "/email" },
    });
  });

  it("enforces Schema uniqueIndexes on create", async () => {
    const schema = {
      ...postsSchema(),
      spec: {
        ...postsSchema().spec,
        schema: {
          type: "object" as const,
          properties: {
            title: { type: "string" as const },
            slug: { type: "string" as const, pattern: "^[a-z0-9-]+$" },
          },
          required: ["title", "slug"],
        },
        uniqueIndexes: [["slug"]],
      },
    };
    const h = harness({ schemas: new Map([[schema.metadata.name, schema]]) });
    await h.createDraft.execute({
      collection: "posts",
      data: { title: "One", slug: "same" },
      authorId: null,
    });
    await expect(
      h.createDraft.execute({
        collection: "posts",
        data: { title: "Two", slug: "same" },
        authorId: null,
      }),
    ).rejects.toMatchObject({
      diagnostic: { code: "CONFLICT", path: "usecase/CreateDraft/posts/uniqueIndexes/0" },
    });
  });

  it("rejects localized entries whose locale is not enabled on the site", async () => {
    const schema: SchemaManifest = {
      apiVersion: "cms.mantle.aotter.net/v1",
      kind: "Schema",
      metadata: { name: "post-translations" },
      spec: {
        title: "Post translations",
        localized: true,
        schema: {
          type: "object",
          properties: {
            slug: { type: "string" },
            locale: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
          },
          required: ["slug", "locale", "title", "body"],
        },
        lifecycle: "simple",
      },
    };
    const h = harness({
      schemas: new Map([[schema.metadata.name, schema]]),
      siteConfig: fakeSiteConfig(["en", "zh-TW"]),
    });
    await expect(
      h.createDraft.execute({
        collection: "post-translations",
        data: { slug: "hello", locale: "klingon-tlh", title: "Qapla", body: "..." },
        authorId: null,
      }),
    ).rejects.toMatchObject({
      diagnostic: {
        code: "INPUT_VALIDATION_FAILED",
        path: "usecase/CreateDraft/post-translations/locale",
      },
    });
  });

  it("accepts localized entries when site.locales is empty (subsystem off, ADR-0010)", async () => {
    const schema: SchemaManifest = {
      apiVersion: "cms.mantle.aotter.net/v1",
      kind: "Schema",
      metadata: { name: "post-translations" },
      spec: {
        title: "Post translations",
        localized: true,
        schema: {
          type: "object",
          properties: {
            slug: { type: "string" },
            locale: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
          },
          required: ["slug", "locale", "title", "body"],
        },
        lifecycle: "simple",
      },
    };
    const h = harness({
      schemas: new Map([[schema.metadata.name, schema]]),
      siteConfig: fakeSiteConfig([]),
    });
    const row = await h.createDraft.execute({
      collection: "post-translations",
      data: { slug: "hello", locale: "en", title: "Hi", body: "..." },
      authorId: null,
    });
    expect(row.collection).toBe("post-translations");
    expect((row.data as { locale: string }).locale).toBe("en");
  });
});

describe("UpdateDraftUseCase", () => {
  it("merges data and bumps version on a draft row", async () => {
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "v1" },
      authorId: null,
    });
    const updated = await h.updateDraft.execute({
      id: created.id,
      expectedVersion: 1,
      data: { title: "v2", slug: "v2" },
    });
    expect(updated.data).toEqual({ title: "v2", slug: "v2" });
    expect(updated.version).toBe(2);
  });

  it("rejects update on non-draft entries", async () => {
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    await h.requestPublish.execute({ id: created.id });
    await expect(
      h.updateDraft.execute({ id: created.id, expectedVersion: 2, data: { title: "y" } }),
    ).rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
  });

  it("returns NOT_FOUND for unknown id", async () => {
    const h = harness();
    await expect(
      h.updateDraft.execute({ id: "missing", expectedVersion: 1, data: {} }),
    ).rejects.toMatchObject({ diagnostic: { code: "NOT_FOUND" } });
  });

  it("OCC mismatch raises CONFLICT", async () => {
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    await expect(
      h.updateDraft.execute({ id: created.id, expectedVersion: 99, data: {} }),
    ).rejects.toMatchObject({ diagnostic: { code: "CONFLICT" } });
  });

  it("strips reserved metadata keys on update merge", async () => {
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "v1" },
      authorId: null,
    });
    const updated = await h.updateDraft.execute({
      id: created.id,
      expectedVersion: 1,
      data: {
        title: "v2",
        id: "spoofed",
        status: "archived",
        version: 999,
        authorId: "evil",
      },
    });
    expect(updated.id).toBe(created.id);
    expect(updated.status).toBe("draft");
    expect(updated.version).toBe(2);
    expect(updated.data).toEqual({ title: "v2" });
  });

  it("preserves existing x-mantle-bind values on update", async () => {
    const h = harness({
      schemas: new Map([[postsSchemaWithBindings.metadata.name, postsSchemaWithBindings]]),
    });
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "v1", slug: "v1" },
      authorId: "user-1",
    });
    const updated = await h.updateDraft.execute({
      id: created.id,
      expectedVersion: 1,
      data: {
        title: "v2",
        authorId: "spoofed-author",
        publishedAt: 123,
      },
    });
    expect(updated.data).toEqual({
      title: "v2",
      slug: "v1",
      authorId: "user-1",
      publishedAt: 1_000_000_000_000,
    });
  });

  it("enforces Schema uniqueIndexes on update while excluding the current row", async () => {
    const schema = {
      ...postsSchema(),
      spec: {
        ...postsSchema().spec,
        schema: {
          type: "object" as const,
          properties: {
            title: { type: "string" as const },
            slug: { type: "string" as const },
          },
          required: ["title", "slug"],
        },
        uniqueIndexes: [["slug"]],
      },
    };
    const h = harness({ schemas: new Map([[schema.metadata.name, schema]]) });
    const first = await h.createDraft.execute({
      collection: "posts",
      data: { title: "One", slug: "one" },
      authorId: null,
    });
    const second = await h.createDraft.execute({
      collection: "posts",
      data: { title: "Two", slug: "two" },
      authorId: null,
    });
    await expect(
      h.updateDraft.execute({
        id: first.id,
        expectedVersion: 1,
        data: { title: "One updated", slug: "one" },
      }),
    ).resolves.toMatchObject({ data: { slug: "one" } });
    await expect(
      h.updateDraft.execute({
        id: second.id,
        expectedVersion: 1,
        data: { slug: "one" },
      }),
    ).rejects.toMatchObject({
      diagnostic: { code: "CONFLICT", path: `usecase/UpdateDraft/${second.id}/uniqueIndexes/0` },
    });
  });
});

describe("RequestPublishUseCase (simple lifecycle)", () => {
  it("flips draft → published with status guard", async () => {
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    const published = await h.requestPublish.execute({ id: created.id });
    expect(published.status).toBe("published");
    expect(published.version).toBe(2);
  });

  it("rejects already-published entries (illegal transition)", async () => {
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    await h.requestPublish.execute({ id: created.id });
    await expect(h.requestPublish.execute({ id: created.id })).rejects.toBeInstanceOf(
      DiagnosticError,
    );
  });

  it("OCC: transitionStatus rejects publish flip when expectedVersion is stale (repo contract)", async () => {
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "v1" },
      authorId: null,
    });
    expect(created.version).toBe(1);
    await h.updateDraft.execute({
      id: created.id,
      expectedVersion: 1,
      data: { title: "v2-unvalidated" },
    });
    await expect(
      h.store.transitionStatus({
        id: created.id,
        collection: "posts",
        to: "published",
        expectedStatus: "draft",
        expectedVersion: 1,
        now: 1,
      }),
    ).rejects.toBeInstanceOf(EntryVersionConflict);
  });

  it("OCC: RequestPublishUseCase propagates the version guard end-to-end", async () => {
    // Race-simulating wrapper: bumps the row's version between
    // entries.get() and entries.transitionStatus() so the snapshot
    // RequestPublish read becomes stale by the time the flip runs.
    // Without H7 (passing expectedVersion through), this test would
    // publish stale-but-passed data; with H7 it must surface a
    // conflict diagnostic.
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "v1" },
      authorId: null,
    });
    const inner = h.store;
    const racing: EntryRepository = {
      ...inner,
      create: inner.create.bind(inner),
      update: inner.update.bind(inner),
      delete: inner.delete.bind(inner),
      archive: inner.archive.bind(inner),
      list: inner.list.bind(inner),
      findByDataField: inner.findByDataField.bind(inner),
      findByDataFields: inner.findByDataFields.bind(inner),
      transitionStatus: inner.transitionStatus.bind(inner),
      get: async (id) => {
        const row = await inner.get(id);
        if (row && row.id === created.id) {
          await inner.update({
            id,
            collection: row.collection,
            expectedVersion: row.version,
            data: { title: "raced-edit" },
            now: 1,
          });
        }
        return row;
      },
    };
    const racingPublish = new RequestPublishUseCase(racing, h.schemas, h.clock);
    await expect(racingPublish.execute({ id: created.id })).rejects.toBeInstanceOf(
      DiagnosticError,
    );
  });

  it("LIFECYCLE_NOT_IN_V010 if Schema is editorial", async () => {
    const editorialSchema: SchemaManifest = {
      ...postsSchema(),
      spec: { ...postsSchema().spec, lifecycle: "editorial" as const },
    };
    const h = harness({
      schemas: new Map([[editorialSchema.metadata.name, editorialSchema]]),
    });
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    await expect(h.requestPublish.execute({ id: created.id })).rejects.toMatchObject({
      diagnostic: { code: "LIFECYCLE_NOT_IN_V010" },
    });
  });

  it("rejects publishing a translated child without a published parent", async () => {
    const h = harness({ schemas: translatedSchemas() });
    const child = await h.createDraft.execute({
      collection: "post-translations",
      data: { slug: "ghost", locale: "en", title: "Ghost", body: "Missing parent" },
      authorId: null,
    });

    await expect(h.requestPublish.execute({ id: child.id })).rejects.toMatchObject({
      diagnostic: {
        code: "TRANSLATES_PARENT_UNKNOWN",
        value: {
          child: "post-translations",
          parent: "posts",
          field: "slug",
          value: "ghost",
        },
      },
    });
  });

  it("requires the translated parent to be published, not just drafted", async () => {
    const h = harness({ schemas: translatedSchemas() });
    await h.createDraft.execute({
      collection: "posts",
      data: { title: "Parent", slug: "draft-parent" },
      authorId: null,
    });
    const child = await h.createDraft.execute({
      collection: "post-translations",
      data: { slug: "draft-parent", locale: "en", title: "Draft parent", body: "Body" },
      authorId: null,
    });

    await expect(h.requestPublish.execute({ id: child.id })).rejects.toMatchObject({
      diagnostic: { code: "TRANSLATES_PARENT_UNKNOWN" },
    });
  });

  it("publishes a translated child once its parent is published", async () => {
    const h = harness({ schemas: translatedSchemas() });
    const parent = await h.createDraft.execute({
      collection: "posts",
      data: { title: "Parent", slug: "hello" },
      authorId: null,
    });
    await h.requestPublish.execute({ id: parent.id });
    const child = await h.createDraft.execute({
      collection: "post-translations",
      data: { slug: "hello", locale: "en", title: "Hello", body: "World" },
      authorId: null,
    });

    const published = await h.requestPublish.execute({ id: child.id });
    expect(published.status).toBe("published");
  });
});

function translatedSchemas(): ReadonlyMap<string, SchemaManifest> {
  const parent = postsSchema();
  const child: SchemaManifest = {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Schema",
    metadata: { name: "post-translations" },
    spec: {
      title: "Post translations",
      localized: true,
      translates: { parent: "posts", on: "slug" },
      schema: {
        type: "object",
        properties: {
          slug: { type: "string" },
          locale: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["slug", "locale", "title", "body"],
      },
      lifecycle: "simple",
    },
  };
  return new Map([
    [parent.metadata.name, parent],
    [child.metadata.name, child],
  ]);
}

function fakeSiteConfig(locales: readonly string[]): SiteConfigRepository {
  return {
    seed: async () => undefined,
    load: async () => ({
      brand: "Test",
      title: "Test",
      description: "Test",
      origin: "https://example.com",
      locales,
    }),
    readLocales: async () => locales,
  };
}

describe("UnpublishUseCase", () => {
  it("flips published back to draft", async () => {
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    await h.requestPublish.execute({ id: created.id });
    const reverted = await h.unpublish.execute({ id: created.id });
    expect(reverted.status).toBe("draft");
  });

  it("rejects unpublish on draft (illegal transition)", async () => {
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    await expect(h.unpublish.execute({ id: created.id })).rejects.toBeInstanceOf(
      DiagnosticError,
    );
  });

  it("flips archived back to draft (via canTransition, not hand-coded string list)", async () => {
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    const archived = await h.archive.execute({ id: created.id, expectedVersion: 1 });
    const reverted = await h.unpublish.execute({ id: created.id });
    expect(archived.status).toBe("archived");
    expect(reverted.status).toBe("draft");
  });
});

describe("ArchiveUseCase", () => {
  it("flips draft → archived (simple lifecycle allows direct archive)", async () => {
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    const archived = await h.archive.execute({ id: created.id, expectedVersion: 1 });
    expect(archived.status).toBe("archived");
  });

  it("flips published → archived", async () => {
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    const published = await h.requestPublish.execute({ id: created.id });
    const archived = await h.archive.execute({
      id: created.id,
      expectedVersion: published.version,
    });
    expect(archived.status).toBe("archived");
  });

  it("ignores caller-supplied stale expectedVersion (OCC pinned to internal read; #210 PR12 H3)", async () => {
    // PR12: ArchiveUseCase now pins OCC to existing.version (the row
    // it just read), not request.expectedVersion. A caller supplying
    // a stale version still succeeds as long as no concurrent write
    // raced — because the guard and chokepoint check the same snapshot.
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    expect(created.version).toBe(1);
    // Bump the version via update so caller's view of version=1 is stale.
    await h.updateDraft.execute({
      id: created.id,
      expectedVersion: 1,
      data: { title: "y" },
    });
    // request.expectedVersion is now ignored — archive picks up the
    // real version internally and succeeds.
    const archived = await h.archive.execute({ id: created.id, expectedVersion: 1 });
    expect(archived.status).toBe("archived");
  });
});

describe("GetEntryUseCase / ListEntriesUseCase / DeleteEntryUseCase", () => {
  it("GetEntryUseCase returns the row when collection matches", async () => {
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    const fetched = await h.getEntry.execute({ id: created.id, collection: "posts" });
    expect(fetched.id).toBe(created.id);
  });

  it("GetEntryUseCase rejects when collection asserted but doesn't match", async () => {
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    await expect(
      h.getEntry.execute({ id: created.id, collection: "other" }),
    ).rejects.toMatchObject({ diagnostic: { code: "NOT_FOUND" } });
  });

  // Contract pin. If execute()'s return type drifts back to a wrapper
  // object (or executePage() loses its cursor-shape), this trips
  // `pnpm typecheck` in same-repo CI — before a downstream consumer
  // like a starter ever sees the regression. Counterpart to
  // mantle-starters' bump-from-sdk validate gate, with faster feedback.
  it("ListEntriesUseCase type contract: execute → flat array, executePage → cursored", () => {
    const h = harness();
    expectTypeOf(h.listEntries.execute)
      .returns
      .resolves
      .toEqualTypeOf<readonly EntryRow[]>();
    expectTypeOf(h.listEntries.executePage)
      .returns
      .resolves
      .toEqualTypeOf<ListEntriesResponse<EntryRow>>();
  });

  it("ListEntriesUseCase.execute() returns a flat readonly array (app-code shape)", async () => {
    const h = harness();
    await h.createDraft.execute({ collection: "posts", data: { title: "a" }, authorId: null });
    await h.createDraft.execute({ collection: "posts", data: { title: "b" }, authorId: null });
    const result = await h.listEntries.execute({ collection: "posts" });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    // App code does `.find` / `.filter` directly — no `.rows` unwrap.
    const found = result.find((r) => (r.data as { title?: string }).title === "a");
    expect(found).toBeDefined();
  });

  it("ListEntriesUseCase filters by status", async () => {
    const h = harness();
    const a = await h.createDraft.execute({ collection: "posts", data: { title: "a" }, authorId: null });
    await h.createDraft.execute({ collection: "posts", data: { title: "b" }, authorId: null });
    await h.requestPublish.execute({ id: a.id });
    const drafts = await h.listEntries.execute({ collection: "posts", status: "draft" });
    expect(drafts).toHaveLength(1);
    const published = await h.listEntries.execute({ collection: "posts", status: "published" });
    expect(published).toHaveLength(1);
  });

  it("ListEntriesUseCase.executePage() returns nextCursor when there are more rows", async () => {
    const h = harness();
    for (let i = 1; i <= 5; i++) {
      await h.createDraft.execute({ collection: "posts", data: { title: `t${i}` }, authorId: null });
    }
    const first = await h.listEntries.executePage({ collection: "posts", limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const second = await h.listEntries.executePage({
      collection: "posts",
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.rows).toHaveLength(2);
    expect(second.nextCursor).toBeDefined();
    const third = await h.listEntries.executePage({
      collection: "posts",
      limit: 2,
      cursor: second.nextCursor,
    });
    expect(third.rows).toHaveLength(1);
    expect(third.nextCursor).toBeUndefined();
    // Pages should not overlap.
    const allIds = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id);
    expect(new Set(allIds).size).toBe(5);
  });

  it("ListEntriesUseCase.execute() only returns the first page (silent cap)", async () => {
    const h = harness();
    for (let i = 1; i <= 5; i++) {
      await h.createDraft.execute({ collection: "posts", data: { title: `t${i}` }, authorId: null });
    }
    // execute() does NOT walk cursors. Caller-supplied limit applies.
    const flat = await h.listEntries.execute({ collection: "posts", limit: 2 });
    expect(flat).toHaveLength(2);
    // Authors who need full walking use executePage() + nextCursor.
  });

  it("ListEntriesUseCase clamps caller-supplied limit to MAX_LIMIT (500)", async () => {
    const h = harness();
    let listArgs: { limit?: number } | null = null;
    const original = h.store.list.bind(h.store);
    h.store.list = async (args) => {
      listArgs = args;
      return original(args);
    };
    await h.listEntries.execute({ collection: "posts", limit: 999_999 });
    expect(listArgs).not.toBeNull();
    expect(listArgs!.limit).toBe(500);
    await h.listEntries.execute({ collection: "posts", limit: -10 });
    expect(listArgs!.limit).toBe(50);
    await h.listEntries.execute({ collection: "posts" });
    expect(listArgs!.limit).toBe(50);
  });

  it("DeleteEntryUseCase removes the row", async () => {
    const h = harness();
    const created = await h.createDraft.execute({
      collection: "posts",
      data: { title: "x" },
      authorId: null,
    });
    const result = await h.deleteEntry.execute({ id: created.id });
    expect(result.removed).toBe(true);
    expect(await h.store.get(created.id)).toBeNull();
  });

  it("DeleteEntryUseCase surfaces NOT_FOUND on missing ids", async () => {
    const h = harness();
    await expect(h.deleteEntry.execute({ id: "ghost" })).rejects.toMatchObject({
      diagnostic: { code: "NOT_FOUND" },
    });
  });
});
