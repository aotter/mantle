/**
 * Who may create an account. Better Auth calls this (through `databaseHooks.user.create.before` in auth.ts) only when a
 * verified email has no user yet; existing users and ADMIN_EMAIL always sign in. Return false to refuse sign-up (403).
 * AGENT: for invite-only or members-only sign-up, look the email up here (e.g. an allowlist Schema read through the Store).
 */
export async function allowSignUp(_env: Env, _email: string): Promise<boolean> {
  return true;
}
