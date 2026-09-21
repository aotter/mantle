import type { EmailSendArgs } from "@aotter/mantle-runtime";

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
