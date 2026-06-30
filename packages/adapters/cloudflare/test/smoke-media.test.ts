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
  InMemoryKv,
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

  async deleteObject() {
    /* noop */
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
        lifecycle: "simple",
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
    handler: stubAuth.handler,
    getSession: async () => ({
      session: { id: "sess-1", userId: STAFF_USER.id, expiresAt: new Date(Date.now() + 60_000) },
      user: STAFF_USER,
    }),
    getUserRole: async () => "owner",
    methods: [],
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
      kv: new InMemoryKv(),
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

  it("commit returns MEDIA_UPLOAD_EXPIRED when the uploadGroupId has no KV record", async () => {
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
        kv: new InMemoryKv(),
        assets: new StubAssetServer(),
        mediaStorage: storage,
      },
      auth: staffAuth(),
    });
    const handler = createMcpApiHandler({ ref, surface: "staff" });
    const props = { props: { userId: STAFF_USER.id, role: "owner" } };

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

function jsonRpcReq(method: string, params?: unknown): Request {
  return new Request("https://example.test/mcp/staff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("smoke: MCP staff gating reads live role (#388)", () => {
  it("revokes /mcp/staff access when the live role is removed, same bearer token", async () => {
    let liveRole: string | null = "owner";
    const ref = createCmsRef({
      manifests: manifests(),
      bindings: {
        db: new InMemoryDatabase(),
        kv: new InMemoryKv(),
        assets: new StubAssetServer(),
      },
      auth: {
        handler: stubAuth.handler,
        getSession: async () => ({
          session: { id: "sess-1", userId: STAFF_USER.id, expiresAt: new Date(Date.now() + 60_000) },
          user: STAFF_USER,
        }),
        // The operator-controlled live role; flips mid-test.
        getUserRole: async () => liveRole,
        methods: [],
      } as unknown as Auth,
    });
    const handler = createMcpApiHandler({ ref, surface: "staff" });
    // props.role is the role frozen into the grant at consent time.
    const props = { props: { userId: STAFF_USER.id, role: "owner" } };

    const ok = await handler.fetch!(
      jsonRpcReq("tools/list"),
      {},
      props as unknown as ExecutionContext,
    );
    expect(ok.status).toBe(200);

    // Operator revokes staff. The token still carries role:"owner" in
    // its grant props, but the live D1 role is now null.
    liveRole = null;
    const denied = await handler.fetch!(
      jsonRpcReq("tools/list"),
      {},
      props as unknown as ExecutionContext,
    );
    expect(denied.status).toBe(403);
  });
});
