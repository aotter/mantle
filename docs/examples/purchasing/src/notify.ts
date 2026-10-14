import { ConsoleEmailSender, type EmailSender } from "@aotter/mantle/email";
import type { Handle } from "@aotter/mantle/driver/d1";

// AGENT: replace with a real sender before deploying (Cloudflare `send_email` binding, docs/handbook/guides/email.md).
// ConsoleEmailSender only logs; it sends nothing.
export const sender: EmailSender = new ConsoleEmailSender();

// Emails live in Better Auth's `user` table, which Views cannot read; these are plain reads of that table.
export async function emailOf(db: Handle, userId: string): Promise<string | undefined> {
  const [row] = (await db.prepare(`SELECT email FROM "user" WHERE id = ?`).bind(userId).all()).results;
  return row?.email;
}

/** Better Auth stores roles comma-separated. */
export async function adminEmails(db: Handle): Promise<string[]> {
  const { results } = await db.prepare(`SELECT email FROM "user" WHERE ',' || role || ',' LIKE '%,admin,%'`).all();
  return results.map(row => row.email);
}

/** Email failures never undo a decision that has already committed. */
export async function notify(to: string | undefined, subject: string, text: string, category: string) {
  if (!to) return;
  try { await sender.send({ to, subject, text, locale: "en", category }); }
  catch (error) { console.error(`[purchasing] ${category} email failed`, error); }
}
