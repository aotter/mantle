import * as React from "react";

import { cn } from "../lib/utils.js";
import { Card } from "./ui/card.js";

export type AuthLegalLinks = {
  privacy?: string;
  terms?: string;
};

export function AuthCard({
  action,
  children,
  className,
  wide = false,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className={cn(wide ? "w-full max-w-md" : "w-full max-w-sm", "relative", action && "[&>[data-slot=card-header]]:pe-14", className)}>
        {action ? <div className="absolute top-2 end-2 z-10">{action}</div> : null}
        {children}
      </Card>
    </main>
  );
}

export function AuthLegalNotice({ legal }: { legal?: AuthLegalLinks }) {
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
