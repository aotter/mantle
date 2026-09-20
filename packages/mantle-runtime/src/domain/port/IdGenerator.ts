/**
 * `IdGenerator` — abstracted id source for entries / lifecycle events /
 * sessions / media bearer tokens / R2
 * object keys.
 *
 * # Security invariant
 *
 * **Production injections MUST be cryptographically random** (CSPRNG-
 * backed, ≥122 bits of entropy). Several call sites use the result as
 * a bearer-token-equivalent — for example, `R2MediaStorage` returns
 * the generated `uploadId` to the client and accepts it back on
 * commit; an attacker who can guess pending `uploadId`s can commit
 * someone else's upload. `R2MediaStorage` also derives R2 object keys
 * from this generator, so a predictable id leaks pre-commit storage
 * key locations.
 *
 * The default `RandomUuidGenerator` (UUID v4 via Web Crypto) satisfies
 * this. Counter-based / sortable / "debuggable" alternatives MUST be
 * confined to test code — never wired into a production runtime or adapter.
 */
export interface IdGenerator {
  next(): string;
}

/** Default production id source. UUID v4, ~122 bits CSPRNG entropy
 *  via the Workers / Node Web Crypto API. Safe for bearer tokens,
 *  R2 object keys, and primary keys. */
export const RandomUuidGenerator: IdGenerator = { next: () => crypto.randomUUID() };
