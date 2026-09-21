import * as React from "react";
import type { OAuthConsentInfo, OAuthConsentRequest } from "@aotter/mantle-admin";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthCard } from "@/components/auth-card";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SignInButton, SignInFlow } from "@/components/sign-in-flow";
import { Skeleton } from "@/components/ui/skeleton";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { authMethodsQueryOptions } from "../../lib/queries";
import type { AuthMethodInfo } from "../../lib/types";
import { signOut } from "../../lib/auth";
import { ThemeToggle } from "../../layout/preference-controls";
import { ErrorBox, PageHeader, SectionCard } from "../../ui/page";

export function GateLoading(): React.ReactElement {
  return (
    <AuthCard action={<ThemeToggle />}>
      <CardHeader>
        <Skeleton className="h-4 w-24" />
      </CardHeader>
      <CardContent className="space-y-2" aria-busy="true">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </CardContent>
    </AuthCard>
  );
}

export function GateError({ error }: { error: unknown }): React.ReactElement {
  const { language } = usePreferences();
  const message = error instanceof Error ? error.message : t(language, "common.unknownError");
  return (
    <AuthCard action={<ThemeToggle />}>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">
          <h1>{t(language, "auth.error.title")}</h1>
        </CardTitle>
        <CardDescription role="alert">{message}</CardDescription>
      </CardHeader>
    </AuthCard>
  );
}

export function AccessDeniedView({
  login,
}: {
  login: string | null;
}): React.ReactElement {
  const { language } = usePreferences();
  return (
    <AuthCard action={<ThemeToggle />} wide>
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
        <Button variant="outline" className="mb-2 w-full" asChild>
          <a href="/admin/connected-apps">{t(language, "oauth.connectedApps")}</a>
        </Button>
        <Button variant="outline" className="w-full" onClick={signOut}>
          <LogOut className="me-2 size-4" aria-hidden />
          {t(language, "common.signOut")}
        </Button>
      </CardContent>
    </AuthCard>
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

// Both moved to the kit component that now owns the email-OTP flow;
// re-exported here so Admin call sites and tests keep one import path.
export { claimInFlight, SignInButton } from "@/components/sign-in-flow";

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
    <AuthCard action={<ThemeToggle />}>
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
    </AuthCard>
  );
}

export function OAuthConsentView(): React.ReactElement {
  const { language } = usePreferences();
  const [submitting, setSubmitting] = React.useState<"approve" | "deny" | null>(null);
  const decision = React.useRef<HTMLInputElement>(null);
  const consent = useQuery<OAuthConsentRequest | null>({
    queryKey: ["oauth-consent", window.location.search],
    queryFn: async () => {
      const response = await fetch(`/oauth/consent/data${window.location.search}`);
      if (response.status === 401) return redirectToSignIn();
      const body = await response.json() as { consent: OAuthConsentRequest | null };
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
      <AuthCard action={<ThemeToggle />} wide>
        <CardHeader>
          <CardDescription>{t(language, "oauth.consent.eyebrow")}</CardDescription>
          <CardTitle className="text-xl">
            <h1>{t(language, "oauth.consent.invalidTitle")}</h1>
          </CardTitle>
          <CardDescription>{t(language, "oauth.consent.invalidBody")}</CardDescription>
        </CardHeader>
      </AuthCard>
    );
  }

  return (
    <AuthCard action={<ThemeToggle />} wide>
      <CardHeader>
        <CardDescription>{t(language, "oauth.consent.eyebrow")}</CardDescription>
        <CardTitle className="text-xl">
          <h1>{t(language, "oauth.consent.heading", { client: consent.data.clientName })}</h1>
        </CardTitle>
        <CardDescription>{t(language, "oauth.consent.body", { client: consent.data.clientName })}</CardDescription>
      </CardHeader>
      <CardContent>
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
    </AuthCard>
  );
}

/** Members can manage their own grants without access to staff Admin APIs. */
export function ConnectedAppsPage(): React.ReactElement {
  return (
    <AuthCard action={<ThemeToggle />} wide>
      <CardContent className="pt-6">
        <ConnectedAppsView />
      </CardContent>
    </AuthCard>
  );
}

export function ConnectedAppsView(): React.ReactElement {
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

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        eyebrow={t(language, "oauth.apps.eyebrow")}
        title={t(language, "oauth.connectedApps")}
        description={t(language, "oauth.apps.body")}
      />
      {consents.isError ? <ErrorBox error={consents.error} /> : (
        <SectionCard>
          {consents.isLoading ? (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : consents.data?.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t(language, "oauth.apps.empty")}</p>
          ) : (
            <div className="divide-y">
              {consents.data?.map((consent) => (
                <section key={consent.id} className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <h2 className="font-medium">{consent.clientName}</h2>
                    <code className="mt-1 block break-all text-xs text-muted-foreground">
                      {consent.clientId}
                    </code>
                  </div>
                  <form
                    method="post"
                    action="/oauth/consents/revoke"
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
        </SectionCard>
      )}
    </div>
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
  return (
    <SignInFlow
      className={SECTION_DIVIDED}
      labels={{
        description: t(language, "auth.signIn.method.email-otp.body"),
        emailLabel: t(language, "auth.signIn.method.email-otp.emailLabel"),
        emailPlaceholder: t(language, "auth.signIn.method.email-otp.emailPlaceholder"),
        sendButton: t(language, "auth.signIn.method.email-otp.sendButton"),
        sentTo: (email) => t(language, "auth.signIn.method.email-otp.sentTo", { email }),
        otpLabel: t(language, "auth.signIn.method.email-otp.otpLabel"),
        verifyButton: t(language, "auth.signIn.method.email-otp.verifyButton"),
        useAnotherEmail: t(language, "auth.signIn.method.email-otp.back"),
        requestFailed: t(language, "auth.signIn.requestFailed"),
      }}
      onSendCode={async (email) => {
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
          return { error: t(language, "auth.signIn.method.email-otp.sendFailed") };
        }
      }}
      onVerifyCode={async (email, code) => {
        const res = await fetch("/api/auth/sign-in/email-otp", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            otp: code,
            ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
          }),
        });
        if (!res.ok) {
          return { error: t(language, "auth.signIn.method.email-otp.verifyFailed") };
        }
        // Navigate to the original return URL. The session cookie is
        // already set on the response, so the next request to
        // `returnTo` is authenticated and the gate routes accordingly.
        // Plain reload() would land back on /admin/sign-in — the
        // pathname is unchanged, the gate sees us on the sign-in page
        // and renders SignInView again instead of routing through.
        const data = (await res.json()) as { url?: string };
        window.location.assign(data.url ?? returnTo);
      }}
    />
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

  // Mirrors SignInFlow's withBusy: identical busy / error-reset
  // bookkeeping per submit. Kept inline (not module-scope) because each
  // owner has its own state setters; lifting it would require passing
  // setBusy/setError in, which is more wiring than duplication saved.
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
