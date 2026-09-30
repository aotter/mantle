/** What the consent screen and the connected-apps list need of an OAuth provider, and the member list's cursor (Admin's, used by the identity provider). */

export interface OAuthConsentRequest {
  readonly clientName: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /** Signed provider query returned unchanged with the consent decision. */
  readonly oauthQuery: string;
}

export interface OAuthConsentInfo {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly scopes: readonly string[];
}

const PREFIX = "m:";

export function encodeMemberCursor(createdAt: string, id: string): string {
  return `${PREFIX}${encodeURIComponent(JSON.stringify([createdAt, id]))}`;
}

export function decodeMemberCursor(cursor: string): readonly [string, string] | null {
  if (!cursor.startsWith(PREFIX)) return null;
  try {
    const v = JSON.parse(decodeURIComponent(cursor.slice(PREFIX.length))) as unknown;
    return Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && !Number.isNaN(Date.parse(v[0])) && typeof v[1] === "string" && v[1] ? [v[0], v[1]] : null;
  } catch {
    return null;
  }
}
