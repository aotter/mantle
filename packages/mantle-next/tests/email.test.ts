import { expect, spyOn, test } from "bun:test";
import { build } from "esbuild";
import type { EmailSender as PublicSender, EmailSendArgs as PublicArgs } from "@aotter/mantle-next/email";
import { ConsoleEmailSender, signInCodeEmail, signInLinkEmail, staffInvitationEmail, type EmailSender, type EmailSendArgs } from "../src/kernel/email.js";

test("English templates preserve the 0.2 text-only contract", () => {
  expect(signInCodeEmail("123456")).toEqual({
    subject: "Your Mantle sign-in code: 123456",
    text: "Your one-time code is 123456.\n\nIt expires shortly.\n\nIf you did not expect this email, you can ignore it.",
  });
  const url = "https://app.example/admin/sign-in?token=%3Cscript%3E";
  expect(signInLinkEmail(url)).toEqual({
    subject: "Your Mantle sign-in link",
    text: `Use this link to sign in:\n\n${url}\n\nThe link expires shortly.\n\nIf you did not expect this email, you can ignore it.`,
  });
  expect(staffInvitationEmail("staff", url)).toEqual({
    subject: "You have been invited to Mantle",
    text: `You now have staff access to Mantle.\n\nSign in with this email address to accept the invitation:\n\n${url}\n\nIf you did not expect this email, you can ignore it.`,
  });
  // These are text bodies, never HTML or raw MIME headers.
  expect(signInLinkEmail("<script>alert(1)</script>")).not.toHaveProperty("html");
});

test("sender receives locale, category and optional HTML unchanged; dev sender only logs", async () => {
  const args: EmailSendArgs = { to: "test@example.invalid", ...signInCodeEmail("123456"), locale: "zh-TW", category: "auth.email-otp.sign-in", html: "<p>App-owned HTML</p>" };
  const sent: EmailSendArgs[] = [];
  const sender: EmailSender = { async send(message) { sent.push(message); } };
  const publicSender: PublicSender = sender;
  const publicArgs: PublicArgs = args;
  // @ts-expect-error recipient locale is required by the public port
  const missingLocale: PublicArgs = { to: args.to, subject: args.subject, text: args.text };
  void missingLocale;
  await publicSender.send(publicArgs);
  expect(sent[0]).toBe(args);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await new ConsoleEmailSender().send(args);
    expect(log).toHaveBeenCalledWith(`[ConsoleEmailSender] auth.email-otp.sign-in → test@example.invalid (zh-TW)\n  subject: ${args.subject}\n  body: ${args.text}`);
    await new ConsoleEmailSender().send({ ...args, category: undefined });
    expect(log.mock.calls[1]?.[0]).toContain("[ConsoleEmailSender] email →");
  } finally { log.mockRestore(); }
});

test("published entry resolves, and unused email helpers stay out of the Worker", async () => {
  const selected = await build({ stdin: { contents: 'export { signInCodeEmail } from "@aotter/mantle-next/email"', resolveDir: process.cwd() }, write: false, bundle: true, format: "esm", platform: "neutral", metafile: true });
  expect(selected.outputFiles[0]!.text).toContain("Your Mantle sign-in code");
  expect(selected.outputFiles[0]!.text).not.toContain("ConsoleEmailSender");
  expect(selected.outputFiles[0]!.text).not.toContain("invited to Mantle");
  expect(Object.keys(selected.metafile!.inputs)).toEqual(["dist/kernel/email.js", "<stdin>"]);
  const absent = await build({ stdin: { contents: 'export { ContractError } from "@aotter/mantle-next/contracts"', resolveDir: process.cwd() }, write: false, bundle: true, format: "esm", platform: "neutral", metafile: true });
  expect(Object.keys(absent.metafile!.inputs).some(path => path.includes("email"))).toBe(false);
});
