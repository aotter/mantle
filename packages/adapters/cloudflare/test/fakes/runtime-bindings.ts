import type {
  AssetServer,
  KvCache,
  KvListResult,
  KvPutOptions,
} from "@aotter/mantle-runtime";
import type { Auth } from "../../src/auth/createAuth.js";

export class InMemoryKv implements KvCache {
  private store = new Map<string, string>();
  private ttl = new Map<string, number | undefined>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string, opts?: KvPutOptions): Promise<void> {
    this.store.set(key, value);
    this.ttl.set(key, opts?.expirationTtl);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.ttl.delete(key);
  }
  async list(prefix: string): Promise<KvListResult> {
    return {
      keys: [...this.store.keys()].filter((k) => k.startsWith(prefix)),
      cursor: null,
    };
  }
  _ttl(key: string): number | undefined {
    return this.ttl.get(key);
  }
}

export class StubAssetServer implements AssetServer {
  async fetch(_req: Request): Promise<Response | null> {
    return null;
  }
}

/** Auth fake that denies every session — for tests that exercise the
 *  public surface without going through Better Auth. */
export const stubAuth: Auth = {
  basePath: "/api/auth",
  handler: async () => new Response(null, { status: 404 }),
  getSession: async () => null,
  getUserRole: async () => null,
  getProviderAccessToken: async () => {
    throw new Error("stub auth has no linked provider token");
  },
  verifyOAuthAccessToken: async () => ({
    ok: false,
    status: 401,
    reason: "invalid-token",
  }),
  methods: [],
  listLinkedAccounts: async () => [],
  unlinkAccount: async () => false,
  listUsers: async () => [],
  setUserRole: async () => false,
  inviteUser: async () => ({ kind: "created", id: "stub-invite-id" }),
  revokeInvite: async () => false,
  registerOAuthClient: async () => {
    throw new Error("stub auth cannot register OAuth clients");
  },
};
