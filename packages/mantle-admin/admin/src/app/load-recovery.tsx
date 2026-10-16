import * as React from "react";
import { Button } from "@aotter/mantle-ui/kit";
import { t } from "./i18n";
import { usePreferences } from "./preferences";

/** A rejected lazy import stays rejected in React's cache; recovery requires an explicit page reload. */
export class AdminLoadBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render(): React.ReactNode {
    return this.state.failed ? <LoadFailure /> : this.props.children;
  }
}

function LoadFailure(): React.ReactElement {
  const { language } = usePreferences();
  return <main role="alert" className="space-y-4 p-6">
    <h1 className="text-xl font-semibold">{t(language, "common.failedToLoad")}</h1>
    <p className="text-sm text-muted-foreground">{t(language, "common.reloadPageHint")}</p>
    <Button onClick={() => window.location.reload()}>{t(language, "common.reloadPage")}</Button>
  </main>;
}
