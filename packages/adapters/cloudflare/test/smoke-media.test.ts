import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type {
  CommitUploadArgs,
  CreateUploadArgs,
  Manifest,
  MediaAsset,
  MediaStorage,
  MediaVariant,
  UploadCapability,
} from "@aotter/mantle-runtime";
import type { MediaPurposePolicy } from "@aotter/mantle-spec";
import { createCmsRef } from "../src/mount/bootRuntimeOnce.js";
import { createMcpApiHandler } from "../src/mount/mountMcp.js";
import { mountServerEndpoints } from "../src/mount/mountServerEndpoints.js";
import type { Auth } from "../src/auth/createAuth.js";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import {
  StubAssetServer,
  stubAuth,
} from "./fakes/runtime-bindings.js";

/**
 * Smoke: `/admin/api/media/uploads` lifecycle (#272 multi-variant).
 *
 * Covers:
 * - 501 + MEDIA_NOT_CONFIGURED when no `mediaStorage` is bound
 * - happy-path create + commit through the multi-variant use cases
 * - mime allowlist rejection bubbles a structured diagnostic out the
 *   wire path
 * - admin session enforcement (401 when no Better Auth session)
 * - input validation rejects payloads missing the variants manifest
 */
class FakeMediaStorage implements MediaStorage {
  public createCalls: CreateUploadArgs[] = [];
  public commitCalls: CommitUploadArgs[] = [];
  public deleteCalls: string[] = [];
  /** storageKeys whose deleteObject should reject, to exercise the
   *  resilient multi-variant delete path (F2). Substring match. */
  public failDeleteKeys: string[] = [];

  async createUpload(args: CreateUploadArgs) {
    this.createCalls.push(args);
    const capabilities: UploadCapability[] = args.variants.map((v) => ({
      mimeType: v.mimeType,
      role: v.role,
      method: "PUT" as const,
      uploadUrl: `https://r2.example/${args.uploadGroupId}/${v.role}?signed=1`,
      storageKey: `${args.purpose}/${args.uploadGroupId}/${v.role}`,
      publicUrl: `https://media.example/${args.purpose}/${args.uploadGroupId}/${v.role}`,
      requiredHeaders: { "Content-Type": v.mimeType },
    }));
    return {
      uploadGroupId: args.uploadGroupId,
      capabilities,
      expiresAt: args.expiresAt,
    };
  }

  async commitUpload(args: CommitUploadArgs): Promise<MediaAsset> {
    this.commitCalls.push(args);
    const variants: MediaVariant[] = args.variants.map((v) => ({
      mimeType: v.mimeType,
      publicUrl: `https://media.example/${v.storageKey}`,
      storageKey: v.storageKey,
      byteSize: 4096,
      role: v.role,
    }));
    return {
      id: args.uploadGroupId,
      variants,
      alt: args.alt,
      caption: args.caption,
      createdAt: args.now,
    };
  }

  async getPublicUrl(args: { storageKey: string }) {
    return `https://media.example/${args.storageKey}`;
  }

  async deleteObject(args: { storageKey: string }) {
    if (this.failDeleteKeys.some((k) => args.storageKey.includes(k))) {
      throw new Error(`simulated R2 delete failure for ${args.storageKey}`);
    }
    this.deleteCalls.push(args.storageKey);
  }

}

function manifests(): Manifest[] {
  return [
    {
      apiVersion: "cms.mantle.aotter.net/v1",
      kind: "Schema",
      metadata: { name: "posts" },
      spec: {
        title: "Posts",
        schema: {
          type: "object",
          properties: {
            slug: { type: "string" },
            coverAssetId: { type: "string", "x-mantle-ref": "media_assets", "x-mcp-hint": "media-image" },
          },
          required: ["slug"],
        },
        lifecycle: "publishing",
      },
    },
  ];
}

const STAFF_USER = {
  id: "u-admin",
  email: "admin@example.test",
  name: "Admin",
  role: "owner" as const,
  githubLogin: "admin-login",
};

function staffAuth(): Auth {
  return {
    ...stubAuth,
    getSession: async () => ({
      session: { id: "sess-1", userId: STAFF_USER.id, expiresAt: new Date(Date.now() + 60_000) },
      user: STAFF_USER,
    }),
    getUserRole: async () => "owner",
  };
}

interface Harness {
  app: Hono;
  storage: FakeMediaStorage | null;
}

function postCoverPolicy(): MediaPurposePolicy {
  return {
    name: "post-cover",
    required: ["image/avif", "image/webp", "image/jpeg"],
    maxBytes: {
      "image/avif": 200_000,
      "image/webp": 300_000,
      "image/jpeg": 500_000,
    },
  };
}

function harness(opts: {
  withMedia: boolean;
  auth: Auth;
  /** Declared media purposes; defaults to a single post-cover policy
   *  with the three-format requirement so existing happy-path tests
   *  satisfy fail-closed purpose enforcement (#262) + the variants
   *  invariant (#272). */
  mediaPurposes?: readonly MediaPurposePolicy[];
}): Harness {
  const storage = opts.withMedia ? new FakeMediaStorage() : null;
  const ref = createCmsRef({
    manifests: manifests(),
    siteDefaults: {
      media: { purposes: opts.mediaPurposes ?? [postCoverPolicy()] },
    },
    bindings: {
      db: new InMemoryDatabase(),
      assets: new StubAssetServer(),
      ...(storage ? { mediaStorage: storage } : {}),
    },
    auth: opts.auth,
  });
  const app = new Hono();
  mountServerEndpoints(app, ref);
  return { app, storage };
}

const THREE_VARIANT_BODY = {
  filename: "cover.jpg",
  purpose: "post-cover",
  variants: [
    { mimeType: "image/avif", byteSize: 60_000, role: "alternate" },
    { mimeType: "image/webp", byteSize: 80_000, role: "alternate" },
    { mimeType: "image/jpeg", byteSize: 110_000, role: "primary" },
  ],
};

describe("smoke: /admin/api/media/uploads", () => {
  it("returns 501 + MEDIA_NOT_CONFIGURED when no mediaStorage is bound", async () => {
    const h = harness({ withMedia: false, auth: staffAuth() });
    const res = await h.app.request("/admin/api/media/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(THREE_VARIANT_BODY),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { diagnostic: { code: string } };
    expect(body.diagnostic.code).toBe("MEDIA_NOT_CONFIGURED");
  });

  it("returns 401 when there is no admin session", async () => {
    const h = harness({ withMedia: true, auth: stubAuth });
    const res = await h.app.request("/admin/api/media/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(THREE_VARIANT_BODY),
    });
    expect(res.status).toBe(401);
  });

  it("happy path: create returns uploadGroupId + per-variant capabilities", async () => {
    const h = harness({ withMedia: true, auth: staffAuth() });
    const res = await h.app.request("/admin/api/media/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(THREE_VARIANT_BODY),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      uploadGroupId: string;
      capabilities: Array<{ mimeType: string; method: string; uploadUrl: string }>;
    };
    expect(typeof body.uploadGroupId).toBe("string");
    expect(body.capabilities).toHaveLength(3);
    expect(body.capabilities.map((c) => c.mimeType).sort()).toEqual([
      "image/avif",
      "image/jpeg",
      "image/webp",
    ]);
    for (const cap of body.capabilities) {
      expect(cap.method).toBe("PUT");
      expect(cap.uploadUrl).toContain("https://r2.example/");
    }
    expect(h.storage!.createCalls).toHaveLength(1);
  });

  it("rejects disallowed mime with structured diagnostic", async () => {
    const h = harness({
      withMedia: true,
      auth: staffAuth(),
      mediaPurposes: [
        {
          name: "post-cover",
          required: ["application/octet-stream"],
          maxBytes: { "application/octet-stream": 200_000 },
        },
      ],
    });
    const res = await h.app.request("/admin/api/media/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "x.exe",
        purpose: "post-cover",
        variants: [
          { mimeType: "application/octet-stream", byteSize: 100, role: "primary" },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; diagnostic: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.diagnostic.code).toBe("MEDIA_MIME_REJECTED");
  });

  it("rejects undeclared purpose with MEDIA_PURPOSE_REJECTED", async () => {
    const h = harness({ withMedia: true, auth: staffAuth() });
    const res = await h.app.request("/admin/api/media/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...THREE_VARIANT_BODY, purpose: "mcp-e2e" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; diagnostic: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.diagnostic.code).toBe("MEDIA_PURPOSE_REJECTED");
  });

  it("rejects upload when no purposes declared (fail-closed)", async () => {
    const h = harness({ withMedia: true, auth: staffAuth(), mediaPurposes: [] });
    const res = await h.app.request("/admin/api/media/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(THREE_VARIANT_BODY),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { diagnostic: { code: string } };
    expect(body.diagnostic.code).toBe("MEDIA_PURPOSE_REJECTED");
  });

  it("rejects request missing variants array with INPUT_VALIDATION_FAILED", async () => {
    const h = harness({ withMedia: true, auth: staffAuth() });
    const res = await h.app.request("/admin/api/media/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "x.png", purpose: "post-cover" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; diagnostic: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.diagnostic.code).toBe("INPUT_VALIDATION_FAILED");
  });

  it("commit returns MEDIA_UPLOAD_EXPIRED when the uploadGroupId has no pending record", async () => {
    const h = harness({ withMedia: true, auth: staffAuth() });
    const res = await h.app.request("/admin/api/media/uploads/missing/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { diagnostic: { code: string } };
    expect(body.diagnostic.code).toBe("MEDIA_UPLOAD_EXPIRED");
  });

  it("create + commit roundtrip returns the populated MediaAsset", async () => {
    const h = harness({ withMedia: true, auth: staffAuth() });
    const createRes = await h.app.request("/admin/api/media/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(THREE_VARIANT_BODY),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { uploadGroupId: string };

    const commitRes = await h.app.request(
      `/admin/api/media/uploads/${created.uploadGroupId}/commit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alt: "the cover" }),
      },
    );
    expect(commitRes.status).toBe(200);
    const asset = (await commitRes.json()) as {
      id: string;
      variants: Array<{ role: string; mimeType: string; publicUrl: string }>;
      alt?: string;
    };
    expect(asset.id).toBe(created.uploadGroupId);
    expect(asset.variants).toHaveLength(3);
    expect(asset.variants.find((v) => v.role === "primary")?.mimeType).toBe("image/jpeg");
    expect(asset.alt).toBe("the cover");
    expect(h.storage!.commitCalls).toHaveLength(1);
  });
});

describe("smoke: MCP media tool catalog", () => {
  it("refreshes create_media_upload purpose enum when site_config changes", async () => {
    const db = new InMemoryDatabase();
    const storage = new FakeMediaStorage();
    const initialPolicies: MediaPurposePolicy[] = [postCoverPolicy()];
    const ref = createCmsRef({
      manifests: manifests(),
      siteDefaults: { media: { purposes: initialPolicies } },
      bindings: {
        db,
        assets: new StubAssetServer(),
        mediaStorage: storage,
      },
      auth: staffAuth(),
    });
    const handler = createMcpApiHandler({ ref, surface: "staff" });
    const props = {
      props: {
        userId: STAFF_USER.id,
        clientId: "mcp-client",
        scopes: ["mcp"],
      },
    };

    const first = await handler.fetch!(
      jsonRpcReq("tools/list"),
      {},
      props as unknown as ExecutionContext,
    );
    const firstBody = (await first.json()) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: { properties?: Record<string, Record<string, unknown>> };
        }>;
      };
    };
    const firstNames = firstBody.result.tools.map((t) => t.name);
    expect(firstNames).toContain("create_media_upload");
    expect(firstNames).toContain("commit_media_upload");
    expect(firstNames).not.toContain("upload_media_variant");
    expect(
      firstBody.result.tools.find((t) => t.name === "create_media_upload")
        ?.inputSchema.properties?.purpose?.enum,
    ).toEqual(["post-cover"]);

    const updated: MediaPurposePolicy = {
      name: "product-gallery",
      required: ["image/avif", "image/webp", "image/jpeg"],
      maxBytes: {
        "image/avif": 250_000,
        "image/webp": 400_000,
        "image/jpeg": 600_000,
      },
    };
    db.siteConfig.set("mediaPurposes", JSON.stringify([updated]));

    const second = await handler.fetch!(
      jsonRpcReq("tools/list"),
      {},
      props as unknown as ExecutionContext,
    );
    const secondBody = (await second.json()) as typeof firstBody;
    expect(
      secondBody.result.tools.find((t) => t.name === "create_media_upload")
        ?.inputSchema.properties?.purpose?.enum,
    ).toEqual(["product-gallery"]);
  });
});

/** Create + commit one asset through the wire path, returning its id.
 *  The FakeMediaStorage commit persists a full MediaAsset row to the
 *  InMemoryDatabase, so the library endpoints then read it back. */
async function seedAsset(
  app: Hono,
  opts: { alt?: string; caption?: string } = {},
): Promise<string> {
  const createRes = await app.request("/admin/api/media/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(THREE_VARIANT_BODY),
  });
  const { uploadGroupId } = (await createRes.json()) as { uploadGroupId: string };
  await app.request(`/admin/api/media/uploads/${uploadGroupId}/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alt: opts.alt, caption: opts.caption }),
  });
  return uploadGroupId;
}

describe("media library: /admin/api/media", () => {
  it("401 on all four verbs without a staff session", async () => {
    const h = harness({ withMedia: true, auth: stubAuth });
    const list = await h.app.request("/admin/api/media");
    const get = await h.app.request("/admin/api/media/some-id");
    const patch = await h.app.request("/admin/api/media/some-id", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alt: "x" }),
    });
    const del = await h.app.request("/admin/api/media/some-id", { method: "DELETE" });
    expect(list.status).toBe(401);
    expect(get.status).toBe(401);
    expect(patch.status).toBe(401);
    expect(del.status).toBe(401);
  });

  it("501 + MEDIA_NOT_CONFIGURED on all four verbs when no mediaStorage is bound", async () => {
    const h = harness({ withMedia: false, auth: staffAuth() });
    for (const req of [
      h.app.request("/admin/api/media"),
      h.app.request("/admin/api/media/some-id"),
      h.app.request("/admin/api/media/some-id", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alt: "x" }),
      }),
      h.app.request("/admin/api/media/some-id", { method: "DELETE" }),
    ]) {
      const res = await req;
      expect(res.status).toBe(501);
      const body = (await res.json()) as { diagnostic: { code: string } };
      expect(body.diagnostic.code).toBe("MEDIA_NOT_CONFIGURED");
    }
  });

  it("lists committed assets newest-first with primary variant surfaced", async () => {
    const h = harness({ withMedia: true, auth: staffAuth() });
    await seedAsset(h.app, { alt: "first" });
    await seedAsset(h.app, { alt: "second" });
    const res = await h.app.request("/admin/api/media");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        primaryUrl: string | null;
        mime: string | null;
        byteSize: number | null;
        alt: string | null;
        variants: Array<{ role: string }>;
      }>;
      next_cursor: string | null;
    };
    expect(body.items).toHaveLength(2);
    expect(body.next_cursor).toBeNull();
    const item = body.items[0]!;
    expect(item.mime).toBe("image/jpeg");
    expect(item.primaryUrl).toContain("https://media.example/");
    expect(item.byteSize).toBe(4096);
    expect(item.variants).toHaveLength(3);
  });

  it("paginates via next_cursor / cursor", async () => {
    const h = harness({ withMedia: true, auth: staffAuth() });
    await seedAsset(h.app);
    await seedAsset(h.app);
    await seedAsset(h.app);
    const first = await h.app.request("/admin/api/media?limit=2");
    const firstBody = (await first.json()) as {
      items: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.next_cursor).not.toBeNull();

    const second = await h.app.request(
      `/admin/api/media?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor!)}`,
    );
    const secondBody = (await second.json()) as {
      items: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.next_cursor).toBeNull();
    // No overlap between pages.
    const firstIds = new Set(firstBody.items.map((i) => i.id));
    expect(secondBody.items.every((i) => !firstIds.has(i.id))).toBe(true);
  });

  it("filters by search over alt/caption/id", async () => {
    const h = harness({ withMedia: true, auth: staffAuth() });
    await seedAsset(h.app, { alt: "sunset over the bay" });
    await seedAsset(h.app, { alt: "product shot" });
    const res = await h.app.request("/admin/api/media?search=sunset");
    const body = (await res.json()) as { items: Array<{ alt: string | null }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.alt).toBe("sunset over the bay");
  });

  it("GET /:id returns one asset; 404 for a missing id", async () => {
    const h = harness({ withMedia: true, auth: staffAuth() });
    const id = await seedAsset(h.app, { alt: "hello" });
    const ok = await h.app.request(`/admin/api/media/${id}`);
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { id: string; alt: string | null };
    expect(okBody.id).toBe(id);
    expect(okBody.alt).toBe("hello");

    const missing = await h.app.request("/admin/api/media/does-not-exist");
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as { diagnostic: { code: string } };
    expect(body.diagnostic.code).toBe("MEDIA_ASSET_NOT_FOUND");
  });

  it("PATCH updates alt/caption and leaves variants intact", async () => {
    const h = harness({ withMedia: true, auth: staffAuth() });
    const id = await seedAsset(h.app, { alt: "before", caption: "keep me" });
    const res = await h.app.request(`/admin/api/media/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alt: "after" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      alt: string | null;
      caption: string | null;
      variants: Array<unknown>;
    };
    expect(body.alt).toBe("after");
    expect(body.caption).toBe("keep me");
    expect(body.variants).toHaveLength(3);

    // Persisted: a fresh GET reflects the patch.
    const after = await h.app.request(`/admin/api/media/${id}`);
    const afterBody = (await after.json()) as { alt: string | null };
    expect(afterBody.alt).toBe("after");
  });

  it("PATCH rejects non-string alt with INPUT_VALIDATION_FAILED", async () => {
    const h = harness({ withMedia: true, auth: staffAuth() });
    const id = await seedAsset(h.app);
    const res = await h.app.request(`/admin/api/media/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alt: 123 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { diagnostic: { code: string } };
    expect(body.diagnostic.code).toBe("INPUT_VALIDATION_FAILED");
  });

  it("PATCH a missing id returns 404 MEDIA_ASSET_NOT_FOUND", async () => {
    const h = harness({ withMedia: true, auth: staffAuth() });
    const res = await h.app.request("/admin/api/media/nope", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alt: "x" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { diagnostic: { code: string } };
    expect(body.diagnostic.code).toBe("MEDIA_ASSET_NOT_FOUND");
  });

  it("DELETE removes the D1 row and calls deleteObject for every variant", async () => {
    const h = harness({ withMedia: true, auth: staffAuth() });
    const id = await seedAsset(h.app);
    const res = await h.app.request(`/admin/api/media/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean; variantsRemoved: number };
    expect(body.deleted).toBe(true);
    expect(body.variantsRemoved).toBe(3);
    // One deleteObject call per variant.
    expect(h.storage!.deleteCalls).toHaveLength(3);
    // Row is gone: a follow-up GET 404s.
    const after = await h.app.request(`/admin/api/media/${id}`);
    expect(after.status).toBe(404);
  });

  it("DELETE a missing id returns 404 MEDIA_ASSET_NOT_FOUND", async () => {
    const h = harness({ withMedia: true, auth: staffAuth() });
    const res = await h.app.request("/admin/api/media/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { diagnostic: { code: string } };
    expect(body.diagnostic.code).toBe("MEDIA_ASSET_NOT_FOUND");
  });

  it("DELETE stays resilient: one variant's deleteObject rejecting still drops the row + deletes the other variants (F2)", async () => {
    const h = harness({ withMedia: true, auth: staffAuth() });
    const id = await seedAsset(h.app);
    // Fail only the primary variant's object delete. The other two
    // variants must still be deleted and the D1 row must still be gone.
    h.storage!.failDeleteKeys = ["/primary"];
    const res = await h.app.request(`/admin/api/media/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean; variantsRemoved: number };
    expect(body.deleted).toBe(true);
    expect(body.variantsRemoved).toBe(3);
    // The two non-failing variants were still deleted (the loop did not
    // abort on the primary's rejection).
    expect(h.storage!.deleteCalls).toHaveLength(2);
    expect(h.storage!.deleteCalls.every((k) => !k.endsWith("/primary"))).toBe(true);
    // Row is gone despite the object-delete failure: a follow-up GET 404s.
    const after = await h.app.request(`/admin/api/media/${id}`);
    expect(after.status).toBe(404);
  });
});

function jsonRpcReq(method: string, params?: unknown): Request {
  return new Request("https://example.test/mcp/staff", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

/**
 * F1 (#438): the public MCP surface must NOT expose Views declared
 * `surface: "staff"`. `mountMcp.ts` filters `ref.manifests` by
 * `m.spec.surface === surface` before handing them to the
 * dispatcher; without that filter a staff View leaked into the public
 * `/mcp` tools/list AND became callable via `tools/call query_view_*`.
 */
describe("MCP View surface gating (#438)", () => {
  function viewManifests(): Manifest[] {
    return [
      ...manifests(),
      {
        apiVersion: "cms.mantle.aotter.net/v1",
        kind: "View",
        metadata: { name: "public-posts" },
        spec: { from: "posts", surface: "public", limit: 10 },
      },
      {
        apiVersion: "cms.mantle.aotter.net/v1",
        kind: "View",
        metadata: { name: "staff-report" },
        spec: { from: "posts", surface: "staff", limit: 10 },
      },
    ] as Manifest[];
  }

  function viewRef(auth: Auth = staffAuth()) {
    return createCmsRef({
      manifests: viewManifests(),
      siteDefaults: {
        brand: "Example Shop",
        origin: "https://shop.example",
        icons: [
          { src: "/site-icon.png", mimeType: "image/png", sizes: ["64x64"] },
          { src: "/site-icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
        ],
        media: { purposes: [postCoverPolicy()] },
      },
      bindings: {
        db: new InMemoryDatabase(),
        assets: new StubAssetServer(),
      },
      auth,
    });
  }

  const props = {
    props: {
      userId: STAFF_USER.id,
      clientId: "mcp-client",
      scopes: ["mcp"],
    },
  };

  async function toolNames(surface: "public" | "staff"): Promise<string[]> {
    const handler = createMcpApiHandler({ ref: viewRef(), surface });
    const res = await handler.fetch!(
      jsonRpcReq("tools/list"),
      {},
      props as unknown as ExecutionContext,
    );
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    return body.result.tools.map((t) => t.name);
  }

  it("public surface lists the public View but NOT the staff View", async () => {
    const names = await toolNames("public");
    expect(names).toContain("query_view_public_posts");
    expect(names).not.toContain("query_view_staff_report");
  });

  it("projects the canonical site identity into current MCP server metadata", async () => {
    const handler = createMcpApiHandler({ ref: viewRef(), surface: "public" });
    const response = await handler.fetch!(
      jsonRpcReq("initialize"),
      {},
      props as unknown as ExecutionContext,
    );
    const body = (await response.json()) as {
      result: { protocolVersion: string; serverInfo: Record<string, unknown> };
    };
    expect(body.result.protocolVersion).toBe("2025-11-25");
    expect(body.result.serverInfo).toMatchObject({
      name: "aotter.mantle.public",
      title: "Example Shop",
      websiteUrl: "https://shop.example",
      icons: [
        {
          src: "https://shop.example/site-icon.png",
          mimeType: "image/png",
          sizes: ["64x64"],
        },
        {
          src: "https://shop.example/site-icon.svg",
          mimeType: "image/svg+xml",
          sizes: ["any"],
        },
      ],
    });
  });

  it("returns a standards-compatible 403 challenge when the MCP scope is missing", async () => {
    const handler = createMcpApiHandler({ ref: viewRef(), surface: "public" });
    const res = await handler.fetch!(
      jsonRpcReq("tools/list"),
      {},
      {
        props: {
          userId: STAFF_USER.id,
          clientId: "mcp-client",
          scopes: ["accounts:read"],
        },
      } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain("insufficient_scope");
    expect(res.headers.get("www-authenticate")).toContain('scope="mcp"');
  });

  it.each([undefined, "mcp"])("fails closed for malformed token scopes: %s", async (scopes) => {
    const handler = createMcpApiHandler({ ref: viewRef(), surface: "public" });
    const res = await handler.fetch!(
      jsonRpcReq("tools/list"),
      {},
      {
        props: {
          userId: STAFF_USER.id,
          clientId: "mcp-client",
          ...(scopes === undefined ? {} : { scopes }),
        },
      } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(403);
  });

  it("public surface tools/call for a staff View returns unknown-tool", async () => {
    const handler = createMcpApiHandler({ ref: viewRef(), surface: "public" });
    const res = await handler.fetch!(
      jsonRpcReq("tools/call", { name: "query_view_staff_report", arguments: {} }),
      {},
      props as unknown as ExecutionContext,
    );
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
      error?: { message?: string };
    };
    // The dispatcher reports an unknown tool either as a JSON-RPC error
    // or an isError tool result naming the tool; either way the staff
    // View must not be routable on the public surface.
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("query_view_staff_report");
    expect(serialized.toLowerCase()).toContain("unknown");
  });

  it("staff surface lists and calls the staff View but not the public View (#332)", async () => {
    const names = await toolNames("staff");
    expect(names).not.toContain("query_view_public_posts");
    expect(names).toContain("query_view_staff_report");
    expect(names).toContain("create_draft_posts");

    const handler = createMcpApiHandler({ ref: viewRef(), surface: "staff" });
    const res = await handler.fetch!(
      jsonRpcReq("tools/call", { name: "query_view_staff_report", arguments: {} }),
      {},
      props as unknown as ExecutionContext,
    );
    const body = (await res.json()) as {
      result?: { content?: Array<{ text?: string }> };
      error?: unknown;
    };
    expect(body.error).toBeUndefined();
    expect(JSON.parse(body.result?.content?.[0]?.text ?? "{}")).toMatchObject({
      rows: [],
    });
  });

  it("re-reads staff role on every MCP call so demotion takes effect immediately (#388)", async () => {
    let role: string | null = "owner";
    const liveAuth: Auth = {
      ...staffAuth(),
      getUserRole: async () => role,
    };
    const handler = createMcpApiHandler({ ref: viewRef(liveAuth), surface: "staff" });
    const first = await handler.fetch!(
      jsonRpcReq("tools/list"),
      {},
      props as unknown as ExecutionContext,
    );
    expect(first.status).toBe(200);

    role = null;
    const afterDemotion = await handler.fetch!(
      jsonRpcReq("tools/list"),
      {},
      props as unknown as ExecutionContext,
    );
    expect(afterDemotion.status).toBe(403);
    expect(afterDemotion.headers.get("www-authenticate")).toContain(
      "insufficient_scope",
    );
  });
});
