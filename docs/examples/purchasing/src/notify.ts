import { ConsoleEmailSender, type EmailSender } from "@aotter/mantle/email";
import type { Handle } from "@aotter/mantle/driver/d1";

// AGENT: replace with a real sender before deploying (Cloudflare `send_email` binding, docs/handbook/guides/email.md).
// ConsoleEmailSender only logs; it sends nothing.
export const sender: EmailSender = new ConsoleEmailSender();

// Emails live in Better Auth's `user` table, which Views cannot read; these are plain reads of that table.
/** Active admins; Better Auth stores roles comma-separated. */
export async function adminEmails(db: Handle): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT email FROM "user" WHERE ',' || role || ',' LIKE '%,admin,%' AND (banned IS NULL OR banned = 0)`).all();
  return results.map(row => row.email);
}

/** Email failures never undo a decision that has already committed. */
export async function notify(to: string, subject: string, text: string, category: string) {
  try { await sender.send({ to, subject, text, locale: "en", category }); }
  catch (error) { console.error(`[purchasing] ${category} email failed`, error); }
}

/** Looks up the user's email and sends; a failed lookup is logged like a failed send. */
export async function notifyUser(db: Handle, userId: string, subject: string, text: string, category: string) {
  let to: string | undefined;
  try { to = (await db.prepare(`SELECT email FROM "user" WHERE id = ?`).bind(userId).all()).results[0]?.email; }
  catch (error) { console.error(`[purchasing] ${category} recipient lookup failed`, error); }
  if (to) await notify(to, subject, text, category);
}
