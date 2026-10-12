# Transactional email

Import the optional email port from `@aotter/mantle/email`. OSS supplies
`EmailSender`, `EmailSendArgs`, English `signInCodeEmail`, `signInLinkEmail`
and `staffInvitationEmail` templates, and `ConsoleEmailSender` for local
development. Mantle Cloud wires email sending and email OTP by default; OSS
applications select and configure their sender and Better Auth plugins.

`send({ to, subject, text, html?, locale, category? })` returns `Promise<void>`.
The templates return `{ subject, text }`, with the same English text as 0.2;
they do not translate or consume `locale`. Pass the recipient's locale through
to the sender, which can select localized templates. Existing categories are
`auth.email-otp.<type>`, `auth.magic-link.sign-in` and `auth.staff-invitation`.

## Application wiring

```ts
import { emailOTP } from "better-auth/plugins";
import { signInCodeEmail, staffInvitationEmail, type EmailSender } from "@aotter/mantle/email";

const locale = (request?: Request) =>
  request?.headers.get("accept-language")?.split(",")[0]?.split(";")[0]?.trim() || "en";

// Include this plugin in the app's Better Auth options.
export const emailPlugin = (sender: EmailSender) => emailOTP({
  storeOTP: "hashed",
  sendVerificationOTP: ({ email, otp, type }, ctx) => sender.send({
    to: email, ...signInCodeEmail(otp), locale: locale(ctx?.request),
    category: `auth.email-otp.${type}`,
  }),
});

// Use the configured, trusted application origin, never an incoming Host or
// Origin header. The application grants the OSS "staff" role before sending.
export const inviteEmail = (sender: EmailSender, origin: string, to: string, language: string) =>
  sender.send({
    to, ...staffInvitationEmail("staff", new URL("/admin/sign-in", origin).href),
    locale: language, category: "auth.staff-invitation",
  });
```

For magic links, pass Better Auth's generated URL to `signInLinkEmail(url)`;
configure Better Auth's `baseURL` and `trustedOrigins` to prevent untrusted
callback destinations. Templates preserve their input as plain text and never
interpret it as HTML. If a sender supplies `html`, it owns escaping untrusted
text and attributes and validating link destinations. Pass structured fields
to the provider; do not interpolate them into raw MIME headers.

Use `new ConsoleEmailSender()` only in explicitly selected local development.
It logs recipients, codes and links and sends nothing; never select it in
production or log live messages in a production sender. Provider failures
reject the promise; the application owns error handling and retry policy.

**Never let the response wait for the send.** Better Auth calls
`sendVerificationOTP` for `email-verification` and `forget-password` only when
the user exists, so a response that waits for the provider reveals whether an
account exists. Configure Better Auth's `advanced.backgroundTasks.handler` (on
Workers, `ctx.waitUntil`) so the send runs after the response, as 0.2 did; the
generated `auth.ts` template wires it (#1499).

## Cloudflare Email Service binding

Use a verified sender and a Cloudflare Email Service `send_email` binding.
The binding composes the message natively; no mail SDK or MIME builder is needed.

```jsonc
{ "send_email": [{ "name": "EMAIL" }] }
```

```ts
import type { SendEmail } from "@cloudflare/workers-types";
import type { EmailSender } from "@aotter/mantle/email";

interface Env { EMAIL: SendEmail; EMAIL_FROM: string }
export const emailSender = (env: Env): EmailSender => ({
  async send({ to, subject, text, html }) {
    await env.EMAIL.send({ from: env.EMAIL_FROM, to, subject, text, html });
  },
});
```

The English example ignores `locale` and `category`; a localized provider may
use both. The binding's verified sender and recipient restrictions still apply.
This example does not provision a sender, enable an auth method or send mail
without application wiring.
