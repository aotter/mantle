import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { authMethodsQueryOptions } from "../../lib/queries";
import type { AuthMethodInfo } from "../../lib/types";
import { signOut } from "../../lib/auth";

function AuthPage({
  children,
  wide = false,
}: {
  children: React.ReactNode;
  wide?: boolean;
}): React.ReactElement {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className={wide ? "w-full max-w-md" : "w-full max-w-sm"}>
        {children}
      </Card>
    </main>
  );
}

export function GateLoading(): React.ReactElement {
  return (
    <AuthPage>
      <CardHeader>
        <Skeleton className="h-4 w-24" />
      </CardHeader>
      <CardContent className="space-y-2" aria-busy="true">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </CardContent>
    </AuthPage>
  );
}

export function GateError({ error }: { error: unknown }): React.ReactElement {
  const { language } = usePreferences();
  const message = error instanceof Error ? error.message : t(language, "common.unknownError");
  return (
    <AuthPage>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">
          <h1>{t(language, "auth.error.title")}</h1>
        </CardTitle>
        <CardDescription role="alert">{message}</CardDescription>
      </CardHeader>
    </AuthPage>
  );
}

export function AccessDeniedView({
  login,
}: {
  login: string | null;
}): React.ReactElement {
  const { language } = usePreferences();
  return (
    <AuthPage wide>
      <CardHeader className="text-center">
        <div className="mx-auto mb-3 inline-flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="size-5" aria-hidden />
        </div>
        <CardTitle className="text-xl">
          <h1>{t(language, "auth.accessDenied.title")}</h1>
        </CardTitle>
        {login ? (
          <CardDescription className="font-medium text-foreground">
            GitHub: {login}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="text-center">
        <p className="mb-1 text-sm text-muted-foreground">
          {t(language, "auth.accessDenied.noStaff")}
        </p>
        <p className="mb-6 text-sm text-muted-foreground">
          {t(language, "auth.accessDenied.askOwner")}
        </p>
        <Button variant="outline" className="w-full" onClick={signOut}>
          <LogOut className="me-2 size-4" aria-hidden />
          {t(language, "common.signOut")}
        </Button>
      </CardContent>
    </AuthPage>
  );
}

// Per-section spacing. `first:` zeroes top spacing for whichever
// section the server returns first — keeps the spacing rules
// co-located with the section instead of threading an `isFirst` prop.
const SECTION_PLAIN = "first:mt-0 mt-4";
const SECTION_DIVIDED = "first:mt-0 first:border-t-0 first:pt-0 mt-6 border-t border-border pt-4";

/**
 * Normalize the post-login `?return=` target to a same-origin path.
 * Accepts only values that start with a single `/` (rejecting absolute
 * `https://…` and protocol-relative `//host` URLs), falling back to
 * `/admin`. Prevents an open redirect on the OTP success path, which
 * navigates client-side with the raw value.
 */
export function safeReturnPath(raw: string | null | undefined): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/admin";
}

/**
 * Data-driven sign-in. Fetches `/api/auth/methods` on mount; renders
 * one section per registered method. When `email-otp` is present, a
 * two-step inline form (email → OTP). When `github` is present, a
 * social button.
 *
 * Method labels come from `auth.signIn.method.<kind>.*` i18n keys. The
 * fallback chain is: current language → English → key. Adding a new
 * method (passkey, google) is a new union case + new i18n keys.
 */
export function SignInView(): React.ReactElement {
  const { language } = usePreferences();
  const params = new URLSearchParams(window.location.search);
  const ret = safeReturnPath(params.get("return"));

  const methods = useQuery<AuthMethodInfo[]>(authMethodsQueryOptions());

  return (
    <AuthPage>
      <CardHeader>
        <CardDescription>{t(language, "auth.signIn.eyebrow")}</CardDescription>
        <CardTitle className="text-xl">
          <h1>{t(language, "auth.signIn.title")}</h1>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {methods.isError ? (
          <p className="mb-4 text-sm text-destructive" role="alert">
            {t(language, "auth.signIn.methodsLoadFailed")}
          </p>
        ) : null}
        {methods.isLoading ? (
          <Skeleton className="h-9 w-full" />
        ) : null}
        {methods.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t(language, "auth.signIn.noMethods")}
          </p>
        ) : null}
        {methods.data && methods.data.length > 0 ? (
          // Wrap so each section's `first:` selectors target the first
          // method in the list, not the first child of the card.
          <div>
            {methods.data.map((m) => (
              <MethodSection
                key={
                  m.kind === "social"
                    ? `social:${m.provider}`
                    : m.kind === "oauth"
                      ? `oauth:${m.providerId}`
                      : m.kind
                }
                method={m}
                returnTo={ret}
              />
            ))}
          </div>
        ) : null}
      </CardContent>
    </AuthPage>
  );
}

function MethodSection({
  method,
  returnTo,
}: {
  method: AuthMethodInfo;
  returnTo: string;
}): React.ReactElement {
  // Exhaustive switch — adding a kind to AuthMethodInfo without
  // adding a case here is a TS error. `social` covers all OAuth
  // providers (per Better Auth's socialProviders block); the
  // `provider` discriminator picks the button label.
  switch (method.kind) {
    case "social":
      return <SocialSignInSection provider={method.provider} returnTo={returnTo} />;
    case "oauth":
      return (
        <OAuthSignInSection
          providerId={method.providerId}
          displayName={method.displayName ?? method.providerId}
          returnTo={returnTo}
        />
      );
    case "email-otp":
      return <EmailOtpSection returnTo={returnTo} />;
    case "magic-link":
      return <MagicLinkSection returnTo={returnTo} />;
    default: {
      const _exhaustive: never = method;
      return <UnknownMethodSection kind={(_exhaustive as { kind: string }).kind} />;
    }
  }
}

/**
 * Display-name table for Better Auth's social provider ids. Brand
 * names don't translate, so this stays language-agnostic — the
 * surrounding "Continue with …" template is the only translated
 * piece. Mirrors the `SocialProviderId` union in
 * `@aotter/mantle-cloudflare`; kept here (not split into a
 * shared constants file) because adapters and the SPA evolve
 * independently — the only consumer is one call site below.
 */
const SOCIAL_PROVIDER_DISPLAY_NAME: Readonly<Record<string, string>> = {
  github: "GitHub",
  google: "Google",
  apple: "Apple",
  "microsoft-entra-id": "Microsoft",
  facebook: "Facebook",
  discord: "Discord",
  twitter: "Twitter / X",
  linkedin: "LinkedIn",
  spotify: "Spotify",
  twitch: "Twitch",
  gitlab: "GitLab",
  tiktok: "TikTok",
  reddit: "Reddit",
  kick: "Kick",
  vk: "VK",
  naver: "Naver",
  kakao: "Kakao",
  line: "LINE",
  slack: "Slack",
  atlassian: "Atlassian",
  zoom: "Zoom",
  notion: "Notion",
  figma: "Figma",
  linear: "Linear",
  vercel: "Vercel",
  paypal: "PayPal",
  huggingface: "Hugging Face",
  cognito: "Cognito",
  salesforce: "Salesforce",
  polar: "Polar",
  railway: "Railway",
  roblox: "Roblox",
  paybin: "Paybin",
  wechat: "WeChat",
  dropbox: "Dropbox",
};

/**
 * Generic social-provider button. Label = template
 * `auth.signIn.method.social.button` substituted with the provider's
 * display name. Brand names don't translate; only the wrapper does.
 * Unknown ids (a provider Better Auth adds before the SPA rebuilds)
 * render with the raw id as the substitution.
 */
function SocialSignInSection({
  provider,
  returnTo,
}: {
  provider: string;
  returnTo: string;
}): React.ReactElement {
  const { language } = usePreferences();
  const displayName = SOCIAL_PROVIDER_DISPLAY_NAME[provider] ?? provider;
  const startSocial = async (): Promise<void> => {
    const res = await fetch("/api/auth/sign-in/social", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, callbackURL: returnTo }),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { url?: string };
    if (data.url) window.location.href = data.url;
  };
  return (
    <div className={SECTION_PLAIN}>
      <Button onClick={() => void startSocial()} className="w-full">
        {t(language, "auth.signIn.method.social.button", { provider: displayName })}
      </Button>
    </div>
  );
}

function OAuthSignInSection({
  providerId,
  displayName,
  returnTo,
}: {
  providerId: string;
  displayName: string;
  returnTo: string;
}): React.ReactElement {
  const { language } = usePreferences();
  const startOAuth = async (): Promise<void> => {
    const res = await fetch("/api/auth/sign-in/oauth2", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, callbackURL: returnTo }),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { url?: string };
    if (data.url) window.location.href = data.url;
  };
  return (
    <div className={SECTION_PLAIN}>
      <Button onClick={() => void startOAuth()} className="w-full">
        {t(language, "auth.signIn.method.oauth.button", { provider: displayName })}
      </Button>
    </div>
  );
}

function EmailOtpSection({ returnTo }: { returnTo: string }): React.ReactElement {
  const { language } = usePreferences();
  const [step, setStep] = React.useState<"email" | "otp">("email");
  const [email, setEmail] = React.useState("");
  const [otp, setOtp] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Wraps an async submit handler so each call site gets identical
  // busy / error-reset bookkeeping. `busy` clears in `finally` even
  // when the verify path reloads — the unmount that follows nav
  // discards the queued state update.
  const withBusy = async (run: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } finally {
      setBusy(false);
    }
  };

  const sendOtp = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!email) return;
    void withBusy(async () => {
      const res = await fetch("/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, type: "sign-in" }),
      });
      if (!res.ok) {
        setError(t(language, "auth.signIn.method.email-otp.sendFailed"));
        return;
      }
      setStep("otp");
    });
  };

  const verifyOtp = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!otp) return;
    void withBusy(async () => {
      const res = await fetch("/api/auth/sign-in/email-otp", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otp }),
      });
      if (!res.ok) {
        setError(t(language, "auth.signIn.method.email-otp.verifyFailed"));
        return;
      }
      // Navigate to the original return URL. The session cookie is
      // already set on the response, so the next request to
      // `returnTo` is authenticated and the gate routes accordingly.
      // Plain reload() would land back on /admin/sign-in — the
      // pathname is unchanged, the gate sees us on the sign-in page
      // and renders SignInView again instead of routing through.
      window.location.assign(returnTo);
    });
  };

  return (
    <div className={SECTION_DIVIDED}>
      <p className="mb-2 text-sm text-muted-foreground">
        {t(language, "auth.signIn.method.email-otp.body")}
      </p>
      {step === "email" ? (
        <form onSubmit={sendOtp} className="space-y-2">
          <label htmlFor="signin-email" className="sr-only">
            {t(language, "auth.signIn.method.email-otp.emailLabel")}
          </label>
          <Input
            id="signin-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            placeholder={t(language, "auth.signIn.method.email-otp.emailPlaceholder")}
            required
            autoComplete="email"
          />
          <Button type="submit" className="w-full" disabled={busy || !email}>
            {t(language, "auth.signIn.method.email-otp.sendButton")}
          </Button>
        </form>
      ) : (
        <form onSubmit={verifyOtp} className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t(language, "auth.signIn.method.email-otp.sentTo", { email })}
          </p>
          <label htmlFor="signin-otp" className="sr-only">
            {t(language, "auth.signIn.method.email-otp.otpLabel")}
          </label>
          <Input
            id="signin-otp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={otp}
            onChange={(e) => setOtp(e.currentTarget.value)}
            placeholder={t(language, "auth.signIn.method.email-otp.otpPlaceholder")}
            required
          />
          <Button type="submit" className="w-full" disabled={busy || !otp}>
            {t(language, "auth.signIn.method.email-otp.verifyButton")}
          </Button>
          <button
            type="button"
            onClick={() => setStep("email")}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {t(language, "auth.signIn.method.email-otp.back")}
          </button>
        </form>
      )}
      {error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>
      ) : null}
    </div>
  );
}

function MagicLinkSection({ returnTo }: { returnTo: string }): React.ReactElement {
  const { language } = usePreferences();
  const [email, setEmail] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Mirrors EmailOtpSection's withBusy: identical busy / error-reset
  // bookkeeping per submit. Kept inline (not module-scope) because the
  // two sections have independent state setters; lifting it would
  // require passing setBusy/setError in, which is more wiring than
  // duplication saved.
  const withBusy = async (run: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } finally {
      setBusy(false);
    }
  };

  const sendLink = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!email) return;
    void withBusy(async () => {
      const res = await fetch("/api/auth/sign-in/magic-link", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, callbackURL: returnTo }),
      });
      if (!res.ok) {
        setError(t(language, "auth.signIn.method.magic-link.sendFailed"));
        return;
      }
      setSent(true);
    });
  };

  return (
    <div className={SECTION_DIVIDED}>
      <p className="mb-2 text-sm text-muted-foreground">
        {t(language, "auth.signIn.method.magic-link.body")}
      </p>
      {sent ? (
        <div className="space-y-2">
          <p className="text-sm text-foreground">
            {t(language, "auth.signIn.method.magic-link.sentTo", { email })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(language, "auth.signIn.method.magic-link.clickHint")}
          </p>
          <button
            type="button"
            onClick={() => {
              setSent(false);
              setEmail("");
            }}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {t(language, "auth.signIn.method.magic-link.anotherEmail")}
          </button>
        </div>
      ) : (
        <form onSubmit={sendLink} className="space-y-2">
          <label htmlFor="signin-mlink-email" className="sr-only">
            {t(language, "auth.signIn.method.magic-link.emailLabel")}
          </label>
          <Input
            id="signin-mlink-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            placeholder={t(language, "auth.signIn.method.magic-link.emailPlaceholder")}
            required
            autoComplete="email"
          />
          <Button type="submit" className="w-full" disabled={busy || !email}>
            {t(language, "auth.signIn.method.magic-link.sendButton")}
          </Button>
        </form>
      )}
      {error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>
      ) : null}
    </div>
  );
}

function UnknownMethodSection({ kind }: { kind: string }): React.ReactElement {
  const { language } = usePreferences();
  return (
    <p className="mt-4 text-xs text-muted-foreground">
      {t(language, "auth.signIn.unknownMethod", { kind })}
    </p>
  );
}
