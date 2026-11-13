/**
 * Application seam `managed-grant` (packages/mantle/tests/application-seams.ts): an OAuth extension grant whose tokens are issued
 * without a consent screen. Typechecked only; its behaviour is tested in auth-caller and auth-oauth-postgres. Public
 * imports only, no casts.
 */
import { oauthProvider } from "@better-auth/oauth-provider";
import { issueManagedGrant, oauthGrantExtension } from "@aotter/mantle/auth/oauth";

/** The application's own assertion check: it returns the verified user and what the assertion grants. */
export type VerifyAssertion = (
  assertion: string,
  clientId: string,
) => Promise<{
  user: Parameters<typeof issueManagedGrant>[1]["user"];
  scopes: string[];
  resource: string;
  issuer: string;
}>;

export const extensionGrant = (grantType: string, verify: VerifyAssertion) =>
  oauthProvider({
    loginPage: "/sign-in",
    consentPage: "/oauth/consent",
    extensions: [
      oauthGrantExtension,
      {
        grants: {
          [grantType]: async input => {
            const body: Record<string, string | undefined> = input.ctx.body;
            const scopes = (body.scope ?? "").split(" ").filter(Boolean);
            const { client } = await input.provider.authenticateClient({ scopes });
            const asserted = await verify(body.assertion ?? "", client.clientId);
            return issueManagedGrant(input, {
              client,
              user: asserted.user,
              scopes: scopes.filter(scope => asserted.scopes.includes(scope)),
              resources: [asserted.resource],
              issuer: asserted.issuer,
            });
          },
        },
      },
    ],
  });
