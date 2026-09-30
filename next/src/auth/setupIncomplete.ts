/** The fail-closed `MantleAuth` for a service whose sign-in is not configured yet. */

export type { OAuthProviderExtension } from "@better-auth/oauth-provider";
export type { AuthUserInfo, InviteUserResult, ListMembersArgs, MemberListResult, MemberUserInfo, StaffUserInfo } from "../admin/identity.js";

import { normalizeAuthBasePath } from "./methods.js";
import type { MantleAuth } from "./types.js";

export interface SetupIncompleteAuthOptions {
  readonly basePath?: string;
  readonly message?: string;
  readonly response?: () => Response | Promise<Response>;
}

/**
 * Safe Auth facade for first-deploy/bootstrap windows where an
 * adopter's public Worker should boot before staff sign-in providers
 * have been provisioned. Auth-gated routes should still be blocked by
 * the consumer; this facade never authenticates anyone.
 */
export function createSetupIncompleteAuth(
  options: SetupIncompleteAuthOptions = {},
): MantleAuth {
  const basePath = normalizeAuthBasePath(options.basePath);
  const message = options.message ?? "Auth is not configured yet.";
  const response =
    options.response ??
    (() =>
      Response.json(
        { error: "setup_incomplete", message },
        { status: 503, headers: { "cache-control": "private, no-store" } },
      ));
  const auth: MantleAuth = {
    basePath,
    handler: async () => response(),
    getSession: async () => null,
    getUserRole: async () => null,
    getUser: async () => null,
    getProviderAccessToken: async () => {
      throw new Error(message);
    },
    verifyOAuthAccessToken: async () => ({
      ok: false,
      status: 401,
      reason: "invalid-token",
    }),
    getOAuthConsentRequest: async () => null,
    completeOAuthConsent: async () => {
      throw new Error(message);
    },
    methods: [],
    listLinkedAccounts: async () => [],
    unlinkAccount: async () => false,
    listUsers: async () => [],
    listMembers: async () => ({ items: [], previousCursor: null, nextCursor: null }),
    setUserRole: async () => false,
    inviteUser: async () => {
      throw new Error(message);
    },
    revokeInvite: async () => false,
    deleteUser: async () => false,
    registerOAuthClient: async () => {
      throw new Error(message);
    },
  };
  return auth;
}

/** Pin the session-bound Better Auth request and secret-minimizing response mapping. */
