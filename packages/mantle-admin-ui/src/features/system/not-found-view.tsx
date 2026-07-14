import * as React from "react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";

export function NotFoundView({
  path,
}: {
  path: string;
}): React.ReactElement {
  const { language } = usePreferences();

  return (
    <div className="glass-card animate-rise mx-auto max-w-md p-8 text-center">
      <h1 className="mb-2 text-xl">{t(language, "system.notFound.title")}</h1>
      <p className="text-sm text-muted-foreground">
        {t(language, "system.notFound.body")}{" "}
        <code className="font-mono text-xs">{path}</code>.
      </p>
      <p className="mt-4 text-sm">
        <a href="/admin" className="text-primary hover:underline">
          {t(language, "system.notFound.back")}
        </a>
      </p>
    </div>
  );
}
