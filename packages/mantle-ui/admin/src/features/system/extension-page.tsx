import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@aotter/mantle-ui/kit";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type { SiteInfo } from "../../lib/types";
import { resolveLocalizedText } from "../../lib/localized-text";
import { NotFoundView } from "./not-found-view";

/** What a host page module receives: where its API lives and the console's current preferences. */
export interface AdminExtensionContext {
  readonly id: string;
  readonly apiBase: string;
  readonly language: string;
  readonly theme: "light" | "dark";
}
/** A host page module's one export: render into `element`, return a cleanup. */
export type AdminExtensionMount = (element: HTMLElement, context: AdminExtensionContext) => void | (() => void) | Promise<void | (() => void)>;

/**
 * A page the host added (`createAdminSurface({ extensions })`). Only pages the server listed for this staff member are
 * loaded, from the same-origin module the server named; the page's API is under `/admin/api/x/{id}`.
 */
export function ExtensionPage({ id }: { id: string }): React.ReactElement {
  const { language, resolvedTheme } = usePreferences();
  const site = useQuery({ queryKey: ["site"], queryFn: () => api.get<SiteInfo>("/site") });
  const page = site.data?.extensions?.find((extension) => extension.id === id);
  const host = React.useRef<HTMLDivElement>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    const element = host.current;
    if (!page || !element) return;
    let cleanup: void | (() => void);
    let cancelled = false;
    setFailed(false);
    // the server accepts only a same-origin path; this guards an older or misconfigured server as well
    const url = new URL(page.module, window.location.origin);
    if (url.origin !== window.location.origin) { setFailed(true); return; }
    import(/* @vite-ignore */ url.href)
      .then(async (module: { mount?: AdminExtensionMount }) => {
        if (cancelled) return;
        if (typeof module.mount !== "function") throw new Error("no mount export");
        cleanup = await module.mount(element, { id: page.id, apiBase: `/admin/api/x/${encodeURIComponent(page.id)}`, language, theme: resolvedTheme });
        if (cancelled && typeof cleanup === "function") cleanup();
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (typeof cleanup === "function") cleanup();
      element.replaceChildren();
    };
  }, [page, language, resolvedTheme]);

  if (site.isPending) return <p role="status" className="text-sm text-muted-foreground">{t(language, "extension.loading")}</p>;
  if (!page) return <NotFoundView path={`/admin/x/${id}`} />;
  return (
    <section aria-label={resolveLocalizedText(page.title, language, site.data?.canonicalLocale ?? null) ?? page.id}>
      {failed && <Card className="p-6" role="alert"><p className="text-sm">{t(language, "extension.failed")}</p></Card>}
      <div ref={host} />
    </section>
  );
}
