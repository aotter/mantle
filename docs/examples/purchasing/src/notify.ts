import { ConsoleEmailSender, type EmailSender } from "@aotter/mantle/email";
import { env } from "cloudflare:workers";

// AGENT: replace with a real sender before deploying (Cloudflare `send_email` binding, docs/handbook/guides/email.md).
// ConsoleEmailSender only logs; it sends nothing.
export const sender: EmailSender = new ConsoleEmailSender();

// Recipients come from Better Auth through Mantle's server-side read (no session, no SQL on Better Auth's tables).
// Loaded lazily: Better Auth stays out of the Worker's startup graph.
const identity = async () => (await import("@aotter/mantle/auth/identity")).readIdentity((await import("./auth.js")).createAuth(env));

/** Active admins (Better Auth adminRoles / adminUserIds). */
export async function adminEmails(): Promise<string[]> {
  return (await (await identity()).admins()).map(user => user.email);
}

/** Email failures never undo a decision that has already committed. */
export async function notify(to: string, subject: string, text: string, category: string) {
  try { await sender.send({ to, subject, text, locale: "en", category }); }
  catch (error) { console.error(`[purchasing] ${category} email failed`, error); }
}

/** Looks up the user's email and sends; a failed lookup is logged like a failed send. */
export async function notifyUser(userId: string, subject: string, text: string, category: string) {
  let to: string | undefined;
  try { to = (await (await identity()).user(userId))?.email; }
  catch (error) { console.error(`[purchasing] ${category} recipient lookup failed`, error); }
  if (to) await notify(to, subject, text, category);
}
