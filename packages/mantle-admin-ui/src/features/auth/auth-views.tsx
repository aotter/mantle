import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Loader2Icon, LogOut } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { ThemeToggle } from "../../layout/preference-controls";

function AuthPage({
  children,
  wide = false,
}: {
  children: React.ReactNode;
  wide?: boolean;
}): React.ReactElement {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card
        className={`${wide ? "w-full max-w-md" : "w-full max-w-sm"} relative [&>[data-slot=card-header]]:pe-14`}
      >
        <div className="absolute top-2 end-2 z-10">
          <ThemeToggle />
        </div>
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
  if (!raw?.startsWith("/")) return "/admin";
  try {
    const base = "https://mantle.invalid";
    const url = new URL(raw, base);
    return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : "/admin";
  } catch {
    return "/admin";
  }
}

/** Preserve only the Better Auth-signed OAuth fields while the login UI adds
 * its own query parameters. Mirrors oauthProviderClient without coupling the
 * static Admin SPA to a second auth client. */
export function signedOAuthQuery(search: string): string | undefined {
  const params = new URLSearchParams(search);
  if (!params.has("sig")) return undefined;
  const signedNames = new Set(params.getAll("ba_param"));
  if (signedNames.size === 0) return undefined;
  const signed = new URLSearchParams();
  for (const [key, value] of params) {
    if (key === "sig" || key === "ba_param" || signedNames.has(key)) {
      signed.append(key, value);
    }
  }
  return signed.toString();
}

export function SignInButton({
  busy,
  children,
  disabled,
  ...props
}: React.ComponentProps<typeof Button> & { busy: boolean }): React.ReactElement {
  return (
    <Button {...props} disabled={busy || disabled} aria-busy={busy || undefined}>
      {busy ? <Loader2Icon className="animate-spin" aria-hidden /> : null}
      {children}
    </Button>
  );
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
  const oauthQuery = signedOAuthQuery(window.location.search);

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
                oauthQuery={oauthQuery}
              />
            ))}
          </div>
        ) : null}
      </CardContent>
    </AuthPage>
  );
}

interface OAuthConsentModel {
  readonly clientName: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly oauthQuery: string;
}

interface OAuthConsentInfo {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly scopes: readonly string[];
}

export function OAuthConsentView(): React.ReactElement {
  const { language } = usePreferences();
  const [submitting, setSubmitting] = React.useState<"approve" | "deny" | null>(null);
  const decision = React.useRef<HTMLInputElement>(null);
  const consent = useQuery<OAuthConsentModel | null>({
    queryKey: ["oauth-consent", window.location.search],
    queryFn: async () => {
      const response = await fetch(`/oauth/consent/data${window.location.search}`);
      if (response.status === 401) return redirectToSignIn();
      const body = await response.json() as { consent: OAuthConsentModel | null };
      if (response.status === 400) return null;
      if (!response.ok) throw new Error(t(language, "common.failedToLoad"));
      return body.consent;
    },
    retry: false,
  });

  if (consent.isLoading) return <GateLoading />;
  if (consent.isError) return <GateError error={consent.error} />;
  if (!consent.data) {
    return (
      <AuthPage wide>
        <CardHeader>
          <CardDescription>{t(language, "oauth.consent.eyebrow")}</CardDescription>
          <CardTitle className="text-xl">
            <h1>{t(language, "oauth.consent.invalidTitle")}</h1>
          </CardTitle>
          <CardDescription>{t(language, "oauth.consent.invalidBody")}</CardDescription>
        </CardHeader>
      </AuthPage>
    );
  }

  return (
    <AuthPage wide>
      <CardHeader>
        <CardDescription>{t(language, "oauth.consent.eyebrow")}</CardDescription>
        <CardTitle className="text-xl">
          <h1>{t(language, "oauth.consent.heading", { client: consent.data.clientName })}</h1>
        </CardTitle>
        <CardDescription>
          {t(language, "oauth.consent.redirect")} {" "}
          <code className="break-all rounded bg-muted px-1 py-0.5 text-xs text-foreground">
            {consent.data.redirectUri}
          </code>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {consent.data.scopes.length > 0 ? (
          <div className="mb-6">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {t(language, "oauth.consent.scopes")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {consent.data.scopes.map((scope) => (
                <Badge key={scope} variant="secondary" className="font-mono">{scope}</Badge>
              ))}
            </div>
          </div>
        ) : null}
        <form
          method="post"
          action="/oauth/consent"
          className="flex gap-2 max-sm:flex-col"
          aria-busy={submitting !== null || undefined}
          onSubmit={(event) => {
            const submitter = event.nativeEvent.submitter as HTMLButtonElement | null;
            if (submitter?.value !== "approve" && submitter?.value !== "deny") return;
            if (decision.current) decision.current.value = submitter.value;
            setSubmitting(submitter.value);
          }}
        >
          <input type="hidden" name="oauth_query" value={consent.data.oauthQuery} />
          <input ref={decision} type="hidden" name="decision" />
          <SignInButton
            type="submit"
            value="approve"
            className="flex-1"
            busy={submitting === "approve"}
            disabled={submitting !== null}
          >
            {t(language, "oauth.consent.approve")}
          </SignInButton>
          <SignInButton
            type="submit"
            value="deny"
            variant="secondary"
            className="flex-1"
            busy={submitting === "deny"}
            disabled={submitting !== null}
          >
            {t(language, "oauth.consent.deny")}
          </SignInButton>
        </form>
      </CardContent>
    </AuthPage>
  );
}

export function OAuthConsentsView(): React.ReactElement {
  const { language } = usePreferences();
  const [submitting, setSubmitting] = React.useState<string | null>(null);
  const consents = useQuery<readonly OAuthConsentInfo[]>({
    queryKey: ["oauth-consents"],
    queryFn: async () => {
      const response = await fetch("/oauth/consents/data");
      if (response.status === 401) return redirectToSignIn();
      if (!response.ok) throw new Error(t(language, "common.failedToLoad"));
      return ((await response.json()) as { consents: readonly OAuthConsentInfo[] }).consents;
    },
    retry: false,
  });

  if (consents.isLoading) return <GateLoading />;
  if (consents.isError) return <GateError error={consents.error} />;

  return (
    <AuthPage wide>
      <CardHeader>
        <CardDescription>{t(language, "oauth.apps.eyebrow")}</CardDescription>
        <CardTitle className="text-xl">
          <h1>{t(language, "oauth.connectedApps")}</h1>
        </CardTitle>
        <CardDescription>{t(language, "oauth.apps.body")}</CardDescription>
      </CardHeader>
      <CardContent>
        {consents.data?.length === 0 ? (
          <p className="mb-5 text-sm text-muted-foreground">{t(language, "oauth.apps.empty")}</p>
        ) : (
          <div className="mb-5 space-y-3">
            {consents.data?.map((consent) => (
              <section key={consent.id} className="rounded-lg border p-3">
                <h2 className="font-medium">{consent.clientName}</h2>
                <code className="mt-1 block break-all text-xs text-muted-foreground">
                  {consent.clientId}
                </code>
                {consent.scopes.length > 0 ? (
                  <div className="my-3 flex flex-wrap gap-1.5">
                    {consent.scopes.map((scope) => (
                      <Badge key={scope} variant="secondary" className="font-mono">{scope}</Badge>
                    ))}
                  </div>
                ) : null}
                <form
                  method="post"
                  action="/oauth/consents/revoke"
                  className="mt-3 flex justify-end"
                  onSubmit={() => setSubmitting(consent.id)}
                >
                  <input type="hidden" name="consent_id" value={consent.id} />
                  <SignInButton
                    type="submit"
                    variant="destructive"
                    busy={submitting === consent.id}
                    disabled={submitting !== null}
                  >
                    {t(language, "oauth.apps.revoke")}
                  </SignInButton>
                </form>
              </section>
            ))}
          </div>
        )}
        <Button asChild variant="link" className="px-0">
          <a href="/admin"><ArrowLeft aria-hidden />{t(language, "oauth.apps.back")}</a>
        </Button>
      </CardContent>
    </AuthPage>
  );
}

function redirectToSignIn(): never {
  const current = `${window.location.pathname}${window.location.search}`;
  const params = new URLSearchParams(window.location.search);
  params.set("return", current);
  window.location.replace(`/admin/sign-in?${params}`);
  throw new Error("Redirecting to sign in");
}

function MethodSection({
  method,
  returnTo,
  oauthQuery,
}: {
  method: AuthMethodInfo;
  returnTo: string;
  oauthQuery?: string;
}): React.ReactElement {
  // Exhaustive switch — adding a kind to AuthMethodInfo without
  // adding a case here is a TS error. `social` covers all OAuth
  // providers (per Better Auth's socialProviders block); the
  // `provider` discriminator picks the button label.
  switch (method.kind) {
    case "social":
      return (
        <RedirectSignInSection
          endpoint="/api/auth/sign-in/social"
          body={{
            provider: method.provider,
            callbackURL: returnTo,
            ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
          }}
          buttonKey="auth.signIn.method.social.button"
          displayName={SOCIAL_PROVIDER_DISPLAY_NAME[method.provider] ?? method.provider}
        />
      );
    case "oauth":
      return (
        <RedirectSignInSection
          endpoint="/api/auth/sign-in/social"
          body={{
            provider: method.providerId,
            callbackURL: returnTo,
            ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
          }}
          buttonKey="auth.signIn.method.oauth.button"
          displayName={method.displayName ?? method.providerId}
        />
      );
    case "email-otp":
      return <EmailOtpSection returnTo={returnTo} oauthQuery={oauthQuery} />;
    case "magic-link":
      return <MagicLinkSection returnTo={returnTo} oauthQuery={oauthQuery} />;
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
function RedirectSignInSection({
  endpoint,
  body,
  buttonKey,
  displayName,
}: {
  endpoint: string;
  body: Record<string, string>;
  buttonKey:
    | "auth.signIn.method.social.button"
    | "auth.signIn.method.oauth.button";
  displayName: string;
}): React.ReactElement {
  const { language } = usePreferences();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { url?: string };
      if (!data.url) throw new Error("Missing sign-in URL");
      window.location.assign(data.url);
    } catch {
      setError(t(language, "auth.signIn.startFailed"));
      setBusy(false);
    }
  };
  return (
    <div className={SECTION_PLAIN}>
      <SignInButton busy={busy} onClick={() => void start()} className="w-full">
        {t(language, buttonKey, { provider: displayName })}
      </SignInButton>
      {error ? <p className="mt-2 text-xs text-destructive" role="alert">{error}</p> : null}
    </div>
  );
}

function EmailOtpSection({
  returnTo,
  oauthQuery,
}: {
  returnTo: string;
  oauthQuery?: string;
}): React.ReactElement {
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
    } catch {
      setError(t(language, "auth.signIn.requestFailed"));
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
        body: JSON.stringify({
          email,
          type: "sign-in",
          ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
        }),
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
        body: JSON.stringify({
          email,
          otp,
          ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
        }),
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
      const data = (await res.json()) as { url?: string };
      window.location.assign(data.url ?? returnTo);
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
          <SignInButton type="submit" className="w-full" busy={busy} disabled={!email}>
            {t(language, "auth.signIn.method.email-otp.sendButton")}
          </SignInButton>
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
          <SignInButton type="submit" className="w-full" busy={busy} disabled={!otp}>
            {t(language, "auth.signIn.method.email-otp.verifyButton")}
          </SignInButton>
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

function MagicLinkSection({
  returnTo,
  oauthQuery,
}: {
  returnTo: string;
  oauthQuery?: string;
}): React.ReactElement {
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
    } catch {
      setError(t(language, "auth.signIn.requestFailed"));
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
        body: JSON.stringify({
          email,
          callbackURL: returnTo,
          ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
        }),
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
          <SignInButton type="submit" className="w-full" busy={busy} disabled={!email}>
            {t(language, "auth.signIn.method.magic-link.sendButton")}
          </SignInButton>
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
