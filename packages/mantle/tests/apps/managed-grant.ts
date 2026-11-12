/**
 * A test stand-in for an adopter's extension grant. It is NOT assertion validation: the "assertion" is the user's email, trusted
 * as is. A real handler verifies a signed assertion (for example an ID-JAG) against its own trusted issuer before this point.
 */
import type { oauthProvider } from "@better-auth/oauth-provider";
import { issueManagedGrant } from "../../src/auth/oauth.js";

export const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** Mints a token through the provider's shared path with a handler-chosen `mantle_managed_grant` claim and no record. */
export const FORGED = "urn:example:forged-managed-claim";
export const ISSUER = "https://idp.example.test";

type Extension = NonNullable<Parameters<typeof oauthProvider>[0]["extensions"]>[number];

/** Test hook: runs inside `issueManagedGrant` just before Better Auth issues the tokens, to land an event mid-issuance. */
export const inFlight: { run?: () => Promise<void> } = {};

export const managedGrantTestExtension: Extension = {
  grants: {
    [JWT_BEARER]: async input => {
      const body = input.ctx.body as Record<string, string>;
      const scopes = (body.scope ?? "").split(" ").filter(Boolean);
      const { client } = await input.provider.authenticateClient({ requireCredentials: false, scopes });
      const found = await input.ctx.context.internalAdapter.findUserByEmail(body.assertion ?? "");
      if (!found) throw input.ctx.error("BAD_REQUEST", { error: "invalid_grant" });
      const { provider } = input;
      const issueTokens: typeof provider.issueTokens = async params => {
        await inFlight.run?.();
        return provider.issueTokens(params);
      };
      return issueManagedGrant(
        { ...input, provider: { ...provider, issueTokens } },
        {
          client,
          user: found.user,
          scopes,
          resources: [body.resource!],
          issuer: ISSUER,
        },
      );
    },
    [FORGED]: async input => {
      const body = input.ctx.body as Record<string, string>;
      const scopes = (body.scope ?? "").split(" ").filter(Boolean);
      const { client } = await input.provider.authenticateClient({ requireCredentials: false, scopes });
      const found = await input.ctx.context.internalAdapter.findUserByEmail(body.assertion ?? "");
      return input.provider.issueTokens({
        client,
        user: found!.user,
        scopes,
        resources: [body.resource!],
        accessTokenClaims: { mantle_managed_grant: body.forge },
      });
    },
  },
};

/** A token request for either grant above, as a public client presents it. */
export const managedTokenRequest = (
  baseURL: string,
  fields: { grantType?: string; clientId: string; email: string; scope: string; resource: string; forge?: string },
) =>
  fetch(`${baseURL}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: fields.grantType ?? JWT_BEARER,
      client_id: fields.clientId,
      assertion: fields.email,
      scope: fields.scope,
      resource: fields.resource,
      ...(fields.forge ? { forge: fields.forge } : {}),
    }),
  });
