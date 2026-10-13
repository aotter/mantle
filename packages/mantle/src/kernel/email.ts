/** The transactional-email port (Better Auth email OTP and magic link, staff invitations). The sender decides how to branch on `locale`; `category` names the template lane. */
export interface EmailSender {
  send(args: EmailSendArgs): Promise<void>;
}

export interface EmailSendArgs {
  readonly to: string;
  readonly subject: string;
  /** Plain-text body — always required so non-HTML clients work. */
  readonly text: string;
  /** Optional HTML body. */
  readonly html?: string;
  /** BCP 47 locale the recipient is expected to read. */
  readonly locale: string;
  /** Optional categorization for templating / deliverability segmentation. */
  readonly category?: string;
}

type EmailContent = Pick<EmailSendArgs, "subject" | "text">;

function englishEmail(subject: string, lines: readonly string[]): EmailContent {
  return {
    subject,
    text: `${lines.join("\n\n")}\n\nIf you did not expect this email, you can ignore it.`,
  };
}

export function signInCodeEmail(code: string): EmailContent {
  return englishEmail(`Your Mantle sign-in code: ${code}`, [
    `Your one-time code is ${code}.`,
    "It expires shortly.",
  ]);
}

export function signInLinkEmail(url: string): EmailContent {
  return englishEmail("Your Mantle sign-in link", [
    "Use this link to sign in:",
    url,
    "The link expires shortly.",
  ]);
}

export function staffInvitationEmail(role: string, signInUrl: string): EmailContent {
  return englishEmail("You have been invited to Mantle", [
    `You now have ${role} access to Mantle.`,
    "Sign in with this email address to accept the invitation:",
    signInUrl,
  ]);
}

/**
 * Local development only: logs recipients and sign-in secrets, sends nothing.
 * Select at the application's environment boundary; never use in production.
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
