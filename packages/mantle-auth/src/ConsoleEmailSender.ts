import type { EmailSender, EmailSendArgs } from "@aotter/mantle-runtime";

/**
 * Dev convenience: writes the email to `console.log` instead of
 * sending it. Use this in `wrangler dev` to read OTP codes off the
 * Worker logs without wiring a real sender.
 *
 * **Never wire this in production.** Boot diagnostics will not stop
 * you — Better Auth is happy to call `sender.send()` either way —
 * but real recipients won't get the email. Wrap in an env-gated
 * factory at the adapter wiring site.
 */
export class ConsoleEmailSender implements EmailSender {
  async send(args: EmailSendArgs): Promise<void> {
    const { to, subject, text, locale, category } = args;
    console.log(
      `[ConsoleEmailSender] ${category ?? "email"} → ${to} (${locale})\n` +
        `  subject: ${subject}\n` +
        `  body: ${text}`,
    );
  }
}
