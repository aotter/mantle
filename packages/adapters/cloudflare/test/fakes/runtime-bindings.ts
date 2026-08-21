import type { AdminAssetServer } from "@aotter/mantle-admin";
import type { Auth } from "../../src/auth/createAuth.js";

export class StubAssetServer implements AdminAssetServer {
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
  getOAuthConsentRequest: async () => null,
  completeOAuthConsent: async () => {
    throw new Error("stub auth has no OAuth consent flow");
  },
  methods: [],
  listLinkedAccounts: async () => [],
  unlinkAccount: async () => false,
  listUsers: async () => [],
  listMembers: async () => ({ items: [], previousCursor: null, nextCursor: null }),
  setUserRole: async () => false,
  inviteUser: async () => ({ kind: "created", id: "stub-invite-id" }),
  revokeInvite: async () => false,
  registerOAuthClient: async () => {
    throw new Error("stub auth cannot register OAuth clients");
  },
};
