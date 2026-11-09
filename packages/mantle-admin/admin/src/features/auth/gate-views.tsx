import * as React from "react";
import { AlertTriangle, LogOut } from "lucide-react";
import { AuthCard, Button, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from "@aotter/mantle-ui/kit";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { signOut } from "../../lib/auth";
import { ThemeToggle } from "../../layout/preference-controls";

/**
 * While the session or `me` loads: a neutral page frame, not the sign-in card. A signed-in user who lands here from
 * an app's own sign-in page would otherwise read the card as a second sign-in step (#1943).
 */
export function GateLoading(): React.ReactElement {
  return (
    <div role="status" aria-busy="true" className="min-h-svh bg-background">
      <div className="flex h-14 items-center border-b px-4">
        <Skeleton className="h-5 w-32" />
      </div>
      <div className="space-y-3 p-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-full max-w-xl" />
        <Skeleton className="h-4 w-2/3 max-w-md" />
      </div>
    </div>
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
            {t(language, "auth.accessDenied.user", { name: login })}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="text-center">
        <p className="mb-1 text-sm text-muted-foreground">
          {t(language, "auth.accessDenied.noAdmin")}
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

