import * as React from "react";
import { Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OneTimeCodeInput } from "@/components/one-time-code-input";

/**
 * Same-tick in-flight lock. React `busy` updates are async, so OTP
 * autocomplete `onComplete` and form Enter can both call verify before
 * the next render. Claiming the ref here is visible immediately.
 */
export function claimInFlight(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
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
 * Outcome of a caller-supplied step. Resolving with `{ error }` shows
 * that message and stays on the step; resolving with nothing advances.
 * The two are distinct from a rejection, which shows `labels.requestFailed`
 * — hosts can tell "the server said no" apart from "the request never
 * completed" without the flow knowing anything about transport.
 */
export type SignInFlowStepResult = void | { error: string };

/** Every string the flow renders, so hosts need no particular i18n bundle. */
export type SignInFlowLabels = {
  description: string;
  emailLabel: string;
  emailPlaceholder?: string;
  sendButton: string;
  sentTo: (email: string) => string;
  otpLabel: string;
  verifyButton: string;
  useAnotherEmail: string;
  requestFailed: string;
};

export type SignInFlowProps = {
  labels: SignInFlowLabels;
  onSendCode: (email: string) => Promise<SignInFlowStepResult>;
  onVerifyCode: (email: string, code: string) => Promise<SignInFlowStepResult>;
  className?: string;
  /** Namespaces the field ids and their labels when a page mounts more than one flow. */
  idPrefix?: string;
};

/**
 * Two-step email-OTP sign-in: an email screen that swaps for a
 * six-digit code screen once a code is on its way. Owns the step, busy
 * and error state only — the caller supplies transport (`onSendCode`,
 * `onVerifyCode`), whatever navigation follows a successful verify, and
 * all copy. Mantle Admin renders this same component, so a host gets
 * Admin's behaviour rather than a snapshot of it.
 */
export function SignInFlow({
  labels,
  onSendCode,
  onVerifyCode,
  className,
  idPrefix = "signin",
}: SignInFlowProps): React.ReactElement {
  const [step, setStep] = React.useState<"email" | "otp">("email");
  const [email, setEmail] = React.useState("");
  const [otp, setOtp] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const verifyInFlight = React.useRef(false);

  // Wraps an async submit handler so each call site gets identical
  // busy / error-reset bookkeeping. `busy` clears in `finally` even
  // when the caller navigates away on success — the unmount that
  // follows nav discards the queued state update.
  const withBusy = async (run: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch {
      setError(labels.requestFailed);
    } finally {
      setBusy(false);
    }
  };

  const sendCode = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!email) return;
    void withBusy(async () => {
      const result = await onSendCode(email);
      if (result?.error) {
        setError(result.error);
        return;
      }
      setStep("otp");
    });
  };

  const verifyCode = (code: string): void => {
    if (code.length !== 6) return;
    if (!claimInFlight(verifyInFlight)) return;
    void withBusy(async () => {
      const result = await onVerifyCode(email, code);
      if (result?.error) setError(result.error);
    }).finally(() => {
      verifyInFlight.current = false;
    });
  };

  return (
    <div className={className}>
      <p className="mb-2 text-sm text-muted-foreground">{labels.description}</p>
      {step === "email" ? (
        <form onSubmit={sendCode} className="space-y-2">
          <label htmlFor={`${idPrefix}-email`} className="sr-only">
            {labels.emailLabel}
          </label>
          <Input
            id={`${idPrefix}-email`}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            placeholder={labels.emailPlaceholder}
            required
            autoComplete="email"
          />
          <SignInButton type="submit" className="w-full" busy={busy} disabled={!email}>
            {labels.sendButton}
          </SignInButton>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            verifyCode(otp);
          }}
          className="space-y-2"
        >
          <p className="text-xs text-muted-foreground">{labels.sentTo(email)}</p>
          <label htmlFor={`${idPrefix}-otp`} className="sr-only">
            {labels.otpLabel}
          </label>
          <OneTimeCodeInput
            id={`${idPrefix}-otp`}
            autoComplete="one-time-code"
            autoFocus
            disabled={busy}
            value={otp}
            onChange={setOtp}
            onComplete={verifyCode}
            required
          />
          <SignInButton type="submit" className="w-full" busy={busy} disabled={otp.length !== 6}>
            {labels.verifyButton}
          </SignInButton>
          <button
            type="button"
            onClick={() => setStep("email")}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {labels.useAnotherEmail}
          </button>
        </form>
      )}
      {error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>
      ) : null}
    </div>
  );
}
