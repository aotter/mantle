import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, LogOut } from "lucide-react";
import { Button } from "../../ui/button";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";

export function GateLoading(): React.ReactElement {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="glass-card w-full max-w-sm p-6">
        <div className="mb-4 h-4 w-24 animate-pulse rounded bg-muted" />
        <div className="space-y-2">
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      </div>
    </div>
  );
}

export function GateError({ error }: { error: unknown }): React.ReactElement {
  const { language } = usePreferences();
  const message = error instanceof Error ? error.message : "Unknown error.";
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="glass-card animate-rise w-full max-w-sm p-8 text-center">
        <h1 className="mb-2 text-xl">{t(language, "auth.error.title")}</h1>
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

export function AccessDeniedView({
  login,
}: {
  login: string | null;
}): React.ReactElement {
  const { language } = usePreferences();
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="glass-card animate-rise w-full max-w-md p-8 text-center">
        <div className="mx-auto mb-3 inline-flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="size-5" aria-hidden />
        </div>
        <h1 className="mb-2 text-xl">{t(language, "auth.accessDenied.title")}</h1>
        {login ? (
          <p className="mb-1 text-sm font-medium text-foreground">
            GitHub: {login}
          </p>
        ) : null}
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
      </div>
    </div>
  );
}

// Mirrors `AuthMethodInfo` exported from `@aotter/mantle-cloudflare`
// (see `createAuth.ts`). Duplicated here because the admin SPA is built
// adapter-agnostic and can't import from the adapter package; the
// `/api/auth/methods` endpoint is the wire contract between them.
type AuthMethodInfo =
  | { kind: "email-otp" }
  | { kind: "magic-link" }
  | { kind: "social"; provider: string }
  | { kind: "oauth"; providerId: string; displayName?: string };

// Shared input styling for the email-otp form. Lives at module scope
// so we don't reallocate the string on every render and so a future
// `ui/input` component can swap in by replacing this one constant.
const INPUT_CLASS =
  "w-full rounded border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// Per-section spacing. `first:` zeroes top spacing for whichever
// section the server returns first — keeps the spacing rules
// co-located with the section instead of threading an `isFirst` prop.
const SECTION_PLAIN = "first:mt-0 mt-4";
const SECTION_DIVIDED = "first:mt-0 first:border-t-0 first:pt-0 mt-6 border-t border-border pt-4";

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
  const ret = params.get("return") ?? "/admin";

  const methods = useQuery<AuthMethodInfo[]>({
    queryKey: ["auth-methods"],
    queryFn: async () => {
      const res = await fetch("/api/auth/methods", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { methods?: AuthMethodInfo[] };
      return data.methods ?? [];
    },
    retry: false,
  });

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="glass-card animate-rise w-full max-w-sm p-8">
        <p className="label-eyebrow mb-2">{t(language, "auth.signIn.eyebrow")}</p>
        <h1 className="mb-2 text-xl">{t(language, "auth.signIn.title")}</h1>

        {methods.isError ? (
          <p className="mb-4 text-sm text-destructive">
            {t(language, "auth.signIn.methodsLoadFailed")}
          </p>
        ) : null}
        {methods.isLoading ? (
          <div className="space-y-2">
            <div className="h-9 w-full animate-pulse rounded bg-muted" />
          </div>
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
      </div>
    </div>
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
          <input
            id="signin-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            placeholder={t(language, "auth.signIn.method.email-otp.emailPlaceholder")}
            required
            autoComplete="email"
            className={INPUT_CLASS}
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
          <input
            id="signin-otp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={otp}
            onChange={(e) => setOtp(e.currentTarget.value)}
            placeholder={t(language, "auth.signIn.method.email-otp.otpPlaceholder")}
            required
            className={INPUT_CLASS}
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
        <p className="mt-2 text-xs text-destructive">{error}</p>
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
          <input
            id="signin-mlink-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            placeholder={t(language, "auth.signIn.method.magic-link.emailPlaceholder")}
            required
            autoComplete="email"
            className={INPUT_CLASS}
          />
          <Button type="submit" className="w-full" disabled={busy || !email}>
            {t(language, "auth.signIn.method.magic-link.sendButton")}
          </Button>
        </form>
      )}
      {error ? (
        <p className="mt-2 text-xs text-destructive">{error}</p>
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

function signOut(): void {
  void fetch("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
  }).then(() => {
    window.location.href = "/admin/sign-in";
  });
}
