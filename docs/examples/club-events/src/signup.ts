import { store } from "../generated/generated.js";
import { handlers } from "./handlers.js";

/** Members-only sign-up: an email may create an account only when officers listed it in the `members` Schema (Admin). */
export async function allowSignUp(env: Env, email: string): Promise<boolean> {
  // No user exists yet, so the lookup runs as an application-created system caller (never wire input).
  const members = store(env.DB, { kind: "system", reason: "sign-up allowlist" }, { handlers }).collection("members");
  return (await members.count({ email: email.toLowerCase() })) > 0;
}
