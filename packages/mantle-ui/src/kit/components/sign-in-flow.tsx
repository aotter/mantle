import * as React from "react";
import { Loader2Icon } from "lucide-react";

import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { OneTimeCodeInput } from "./one-time-code-input.js";

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
  /**
   * Resolving without an error is terminal: the flow stays busy and locked so
   * the consumed code cannot be resubmitted. The host must then navigate or
   * unmount the flow (Admin does `window.location.assign`). Resolve with
   * `{ error }` to stay on the code screen instead.
   */
  onVerifyCode: (email: string, code: string) => Promise<SignInFlowStepResult>;
  className?: string;
  /** Namespaces the field ids and their labels when a page mounts more than one flow. */
  idPrefix?: string;
};

export type SignInFlowState = {
  step: "email" | "otp";
  email: string;
  otp: string;
  busy: boolean;
  error: string | null;
};

export type SignInFlowEvent =
  | { type: "email"; value: string }
  | { type: "otp"; value: string }
  | { type: "start" }
  | { type: "sent"; error?: string }
  | { type: "verified"; error?: string }
  | { type: "failed"; error: string }
  | { type: "back" };

export const SIGN_IN_FLOW_INITIAL: SignInFlowState = Object.freeze({
  step: "email",
  email: "",
  otp: "",
  busy: false,
  error: null,
});

/**
 * Pure step machine behind `SignInFlow`, exported so the transitions are
 * testable without a DOM. A verify that succeeds keeps `busy` — the host
 * navigates away next, and re-enabling the form in the meantime would let
 * a second submit spend the already-consumed code.
 */
export function signInFlowReducer(state: SignInFlowState, event: SignInFlowEvent): SignInFlowState {
  switch (event.type) {
    case "email":
      return { ...state, email: event.value };
    case "otp":
      return { ...state, otp: event.value };
    case "start":
      return { ...state, busy: true, error: null };
    case "sent":
      return event.error
        ? { ...state, busy: false, error: event.error }
        : { ...state, busy: false, step: "otp" };
    case "verified":
      return event.error ? { ...state, busy: false, error: event.error } : state;
    case "failed":
      return { ...state, busy: false, error: event.error };
    case "back":
      return { ...state, step: "email", otp: "", error: null, busy: false };
  }
}

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
  const [state, dispatch] = React.useReducer(signInFlowReducer, SIGN_IN_FLOW_INITIAL);
  const { step, email, otp, busy, error } = state;
  // One lock for both steps: a double-click or autocomplete + Enter in the
  // same tick must not dispatch two sends or two verifies.
  const inFlight = React.useRef(false);

  const run = (
    request: () => Promise<SignInFlowStepResult>,
    done: "sent" | "verified",
  ): void => {
    if (busy || !claimInFlight(inFlight)) return;
    dispatch({ type: "start" });
    // Promise.resolve().then(request) turns a synchronous throw from the host
    // callback into a rejection; otherwise busy and the lock would stick.
    void Promise.resolve()
      .then(request)
      .then((result) => {
        dispatch(result?.error ? { type: done, error: result.error } : { type: done });
        // A successful verify hands off to host navigation; keep the lock so
        // the consumed code cannot be resubmitted while the page unloads.
        if (done === "verified" && !result?.error) return;
        inFlight.current = false;
      })
      .catch(() => {
        dispatch({ type: "failed", error: labels.requestFailed });
        inFlight.current = false;
      });
  };

  const sendCode = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!email) return;
    run(() => onSendCode(email), "sent");
  };

  const verifyCode = (code: string): void => {
    if (code.length !== 6) return;
    run(() => onVerifyCode(email, code), "verified");
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
            onChange={(e) => dispatch({ type: "email", value: e.currentTarget.value })}
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
          <OneTimeCodeInput
            id={`${idPrefix}-otp`}
            aria-label={labels.otpLabel}
            autoComplete="one-time-code"
            autoFocus
            disabled={busy}
            value={otp}
            onChange={(value) => dispatch({ type: "otp", value })}
            onComplete={verifyCode}
            required
          />
          <SignInButton type="submit" className="w-full" busy={busy} disabled={otp.length !== 6}>
            {labels.verifyButton}
          </SignInButton>
          <button
            type="button"
            onClick={() => {
              inFlight.current = false;
              dispatch({ type: "back" });
            }}
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
