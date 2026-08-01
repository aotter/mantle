import { describe, expect, it } from "vitest";
import type { Entry, SchemaManifest } from "@aotter/mantle-spec";
import {
  joinParentForList,
  joinParentIfTranslation,
} from "../src/domain/service/io/JoinedEntryReader.js";
import { DatabaseEntryRepository } from "../src/infrastructure/persistence/DatabaseEntryRepository.js";
import { InMemoryDatabase } from "./fakes/database.js";
import { postsSchema } from "./fakes/manifests.js";

function translationsSchema(): SchemaManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Schema",
    metadata: { name: "post-translations" },
    spec: {
      title: "Post translations",
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
      localized: true,
      translates: { parent: "posts", on: "slug" },
      lifecycle: "simple",
    },
  };
}

function seedEntry(
  db: InMemoryDatabase,
  args: {
    id: string;
    collection: string;
    data: Record<string, unknown>;
    status?: string;
    updated_at?: number;
  },
): void {
  db.entries.set(args.id, {
    id: args.id,
    collection: args.collection,
    status: args.status ?? "published",
    version: 1,
    data: JSON.stringify(args.data),
    author_id: null,
    created_at: 1,
    updated_at: args.updated_at ?? 2,
  });
}

describe("joinParentIfTranslation", () => {
  const schemas = new Map<string, SchemaManifest>([
    ["posts", postsSchema()],
    ["post-translations", translationsSchema()],
  ]);

  it("merges parent posts data into the translation", async () => {
    const db = new InMemoryDatabase();
    seedEntry(db, {
      id: "p1",
      collection: "posts",
      data: {
        slug: "hi",
        coverUrl: "https://example.com/cover.jpg",
        authorId: "u1",
        publishedAt: 1000,
      },
    });
    const translation = {
      id: "pt1",
      collection: "post-translations",
      locale: "en",
      status: "published" as const,
      version: 1,
      data: { slug: "hi", locale: "en", title: "Hi", body: "world" },
      createdAt: 1,
      updatedAt: 2,
    };

    const merged = await joinParentIfTranslation(new DatabaseEntryRepository(db, schemas), schemas, translation, {
      parentStatus: "published",
    });

    expect(merged.data).toMatchObject({
      slug: "hi",
      locale: "en",
      title: "Hi",
      body: "world",
      coverUrl: "https://example.com/cover.jpg",
      authorId: "u1",
      publishedAt: 1000,
    });
    // Identity of non-data fields preserved
    expect(merged.id).toBe("pt1");
    expect(merged.collection).toBe("post-translations");
    expect(merged.locale).toBe("en");
  });

  it("translation values override parent on key conflicts", async () => {
    const db = new InMemoryDatabase();
    seedEntry(db, {
      id: "p1",
      collection: "posts",
      data: { slug: "hi", title: "PARENT-TITLE", coverUrl: "p.jpg" },
    });
    const translation = {
      id: "pt1",
      collection: "post-translations",
      locale: "en",
      status: "published" as const,
      version: 1,
      data: { slug: "hi", locale: "en", title: "TRANSLATION-TITLE", body: "x" },
      createdAt: 1,
      updatedAt: 2,
    };

    const merged = await joinParentIfTranslation(new DatabaseEntryRepository(db, schemas), schemas, translation, {
      parentStatus: "published",
    });

    expect(merged.data["title"]).toBe("TRANSLATION-TITLE");
    expect(merged.data["coverUrl"]).toBe("p.jpg");
  });

  it("returns entry unchanged when its schema has no translates declaration", async () => {
    const db = new InMemoryDatabase();
    const standalone = {
      id: "p1",
      collection: "posts",
      status: "published" as const,
      version: 1,
      data: { slug: "hi", coverUrl: "p.jpg" },
      createdAt: 1,
      updatedAt: 2,
    };

    const result = await joinParentIfTranslation(new DatabaseEntryRepository(db, schemas), schemas, standalone);

    expect(result).toBe(standalone);
  });

  it("returns translation unchanged when parent is missing", async () => {
    const db = new InMemoryDatabase();
    const translation = {
      id: "pt1",
      collection: "post-translations",
      locale: "en",
      status: "published" as const,
      version: 1,
      data: { slug: "orphan", locale: "en", title: "Hi", body: "x" },
      createdAt: 1,
      updatedAt: 2,
    };

    const result = await joinParentIfTranslation(new DatabaseEntryRepository(db, schemas), schemas, translation, {
      parentStatus: "published",
    });

    expect(result).toBe(translation);
  });

  it("returns translation unchanged when join field is missing or empty", async () => {
    const db = new InMemoryDatabase();
    seedEntry(db, {
      id: "p1",
      collection: "posts",
      data: { slug: "hi", coverUrl: "p.jpg" },
    });
    const translation = {
      id: "pt1",
      collection: "post-translations",
      locale: "en",
      status: "published" as const,
      version: 1,
      data: { locale: "en", title: "Hi", body: "x" }, // no slug
      createdAt: 1,
      updatedAt: 2,
    };

    const result = await joinParentIfTranslation(new DatabaseEntryRepository(db, schemas), schemas, translation);
    expect(result).toBe(translation);
  });
});

describe("joinParentForList", () => {
  const schemas = new Map<string, SchemaManifest>([
    ["posts", postsSchema()],
    ["post-translations", translationsSchema()],
  ]);

  function makeTranslation(args: { id: string; slug: string; locale: string }): Entry {
    return {
      id: args.id,
      collection: "post-translations",
      locale: args.locale,
      status: "published",
      version: 1,
      data: { slug: args.slug, locale: args.locale, title: args.id, body: "x" },
      createdAt: 1,
      updatedAt: 2,
    };
  }

  it("dedups parent reads when many translations share a slug", async () => {
    const db = new InMemoryDatabase();
    seedEntry(db, {
      id: "p1",
      collection: "posts",
      data: { slug: "shared", coverUrl: "shared.jpg" },
    });
    seedEntry(db, {
      id: "p2",
      collection: "posts",
      data: { slug: "other", coverUrl: "other.jpg" },
    });
    const translations: Entry[] = [
      makeTranslation({ id: "t-en", slug: "shared", locale: "en" }),
      makeTranslation({ id: "t-zh", slug: "shared", locale: "zh-TW" }),
      makeTranslation({ id: "t-ja", slug: "shared", locale: "ja" }),
      makeTranslation({ id: "t-other", slug: "other", locale: "en" }),
    ];

    const merged = await joinParentForList(new DatabaseEntryRepository(db, schemas), schemas, translations, {
      parentStatus: "published",
    });

    expect(merged).toHaveLength(4);
    for (const m of merged.slice(0, 3)) {
      expect(m.data["coverUrl"]).toBe("shared.jpg");
    }
    expect(merged[3]!.data["coverUrl"]).toBe("other.jpg");
  });

  it("returns empty list for empty input", async () => {
    const db = new InMemoryDatabase();
    const result = await joinParentForList(new DatabaseEntryRepository(db, schemas), schemas, []);
    expect(result).toEqual([]);
  });

  it("returns entries unchanged when collection has no translates declaration", async () => {
    const db = new InMemoryDatabase();
    const standalone: Entry[] = [
      {
        id: "p1",
        collection: "posts",
        status: "published",
        version: 1,
        data: { slug: "hi", coverUrl: "p.jpg" },
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    const result = await joinParentForList(new DatabaseEntryRepository(db, schemas), schemas, standalone);
    expect(result).toEqual(standalone);
  });
});
