import type { AssetServer } from "@aotter/mantle-runtime";
import type { Auth } from "../../src/auth/createAuth.js";

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
