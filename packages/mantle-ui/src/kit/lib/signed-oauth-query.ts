/**
 * Better Auth's OAuth provider sends the browser to the sign-in page with the authorization request signed (`sig`,
 * and `ba_param` naming each signed field). Sending only those fields back as `oauth_query` with the sign-in continues
 * the authorization (to consent) instead of ending at the page's own destination. A service's own member sign-in
 * page needs this as much as Admin's does. `undefined` when the page was not reached from an authorization.
 */
export function signedOAuthQuery(search: string): string | undefined {
  const params = new URLSearchParams(search);
  if (!params.has("sig")) return undefined;
  const signedNames = new Set(params.getAll("ba_param"));
  if (signedNames.size === 0) return undefined;
  const signed = new URLSearchParams();
  for (const [key, value] of params) {
    if (key === "sig" || key === "ba_param" || signedNames.has(key)) {
      signed.append(key, value);
    }
  }
  return signed.toString();
}
