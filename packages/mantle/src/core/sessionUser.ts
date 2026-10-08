/**
 * The user a request's cookie session already carried, kept beside the Caller the resolver made from it: Admin's `/me` shows it
 * instead of reading the user row again. Internal (not exported from `core/index`); the Caller's shape stays the wire contract.
 */
import type { Caller } from "./caller.js";

export interface SessionUser {
  readonly email: string;
  readonly name: string;
  readonly image: string | null;
  readonly githubLogin: string | null;
}

const byCaller = new WeakMap<Caller, SessionUser>();

export const rememberSessionUser = (caller: Caller, user: SessionUser): Caller => (byCaller.set(caller, user), caller);
export const sessionUserOf = (caller: Caller): SessionUser | undefined => byCaller.get(caller);
