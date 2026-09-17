import * as React from "react";
import "@aotter/mantle-admin-ui/kit.css";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  OneTimeCodeInput,
} from "@aotter/mantle-admin-ui/kit";

export type AuthLegalLinks = {
  privacy?: string;
  terms?: string;
};

export type AuthPageProps = {
  brand?: React.ReactNode;
  description?: string;
  legal?: AuthLegalLinks;
  onSendCode(email: string): Promise<void>;
  onVerifyCode(email: string, code: string): Promise<void>;
  title?: string;
};

export function LegalNotice({ legal }: { legal?: AuthLegalLinks }) {
  if (!legal?.privacy && !legal?.terms) return null;
  return (
    <p className="text-xs leading-5 text-muted-foreground">
      By continuing, an account may be created. {legal.terms ? <>
        You agree to the <a className="underline underline-offset-2" href={legal.terms} target="_blank" rel="noreferrer">Terms of Use</a>
      </> : null}{legal.terms && legal.privacy ? " and " : null}{legal.privacy ? <>
        {legal.terms ? "you" : "You"} acknowledge the <a className="underline underline-offset-2" href={legal.privacy} target="_blank" rel="noreferrer">Privacy Policy</a>
      </> : null}.
    </p>
  );
}

export function AuthPage({
  brand = "Mantle",
  description = "Sign in with a one-time code.",
  legal,
  onSendCode,
  onVerifyCode,
  title = "Enter your workspace",
}: AuthPageProps) {
  const [email, setEmail] = React.useState("");
  const [code, setCode] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const action = sent
      ? onVerifyCode(email, code)
      : onSendCode(email).then(() => setSent(true));
    void action.catch(() => setError("Unable to sign in. Please try again.")).finally(() => setBusy(false));
  };

  return (
    <main className="grid min-h-svh place-items-center bg-background px-5 py-16 text-foreground">
      <Card className="w-full max-w-md rounded-3xl shadow-2xl">
        <CardHeader className="gap-3 p-7 pb-4 sm:p-9 sm:pb-4">
          <div className="mb-7 text-lg font-semibold">{brand}</div>
          <CardTitle className="text-3xl tracking-tight">{title}</CardTitle>
          <CardDescription className="text-base leading-6">{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 p-7 pt-3 sm:p-9 sm:pt-3">
          <form onSubmit={submit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="auth-email">Email</Label>
              <Input id="auth-email" type="email" autoComplete="email" required disabled={busy || sent} value={email} onChange={(event) => setEmail(event.currentTarget.value)} />
            </div>
            {sent ? <div className="space-y-2">
              <Label htmlFor="auth-code">One-time code</Label>
              <OneTimeCodeInput id="auth-code" autoComplete="one-time-code" autoFocus required disabled={busy} value={code} onChange={setCode} />
            </div> : null}
            <Button className="w-full" disabled={busy || (sent && code.length !== 6)}>
              {busy ? "Please wait…" : sent ? "Sign in" : "Send code"}
            </Button>
            {sent ? <button className="w-full text-sm text-muted-foreground underline underline-offset-4" type="button" disabled={busy} onClick={() => { setSent(false); setCode(""); }}>
              Use another email or resend
            </button> : null}
          </form>
          <LegalNotice legal={legal} />
          {error ? <p role="alert" className="rounded-lg border border-destructive p-3 text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>
    </main>
  );
}
