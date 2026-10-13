/** Data shown by the Admin consent/connected-apps screens. Tokens never enter this DTO. */
export interface OAuthConsentRequest { readonly clientName:string; readonly redirectUri:string; readonly scopes:readonly string[]; readonly oauthQuery:string }
export interface OAuthConsentInfo { readonly id:string; readonly clientId:string; readonly clientName:string; readonly scopes:readonly string[] }
