import * as React from "react";
import type { AdminPage } from "./define-admin";
import { resolveLocalizedText } from "../lib/localized-text";
import { PageHeader } from "../ui/page-header";

/** Internal: one page heading composition, without a router, browser transport or additional provider. */
export function CustomPage({ page, surface, language, canonicalLocale = null }: {
  page: AdminPage;
  surface: "browser" | "mcp-app";
  language: string;
  canonicalLocale?: string | null;
}): React.ReactElement {
  const title = resolveLocalizedText(page.title, language, canonicalLocale) ?? page.path;
  const header = page.header;
  const showHeader = header !== false && (surface === "browser" || header !== undefined);
  const description = header ? resolveLocalizedText(header.description, language, canonicalLocale) : undefined;
  return <section aria-label={title}>
    {showHeader ? <PageHeader title={title} description={description} actions={header ? header.actions : undefined} /> : null}
    <React.Fragment key={page.path}>{page.element}</React.Fragment>
  </section>;
}
