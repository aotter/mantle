import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { prerender } from "react-dom/static";
import { describe, expect, it, vi } from "vitest";
import { t } from "../src/app/i18n";
import { usePreferences } from "../src/app/preferences";
import { useAdminLocation } from "../src/app/router";
import { useConfirm } from "../src/ui/confirm-dialog";

// A probe in place of the routed views: it needs every provider <MantleAdmin> owns.
vi.mock("../src/app/admin-app", () => ({
  AdminApp: function Probe(): React.ReactElement {
    useConfirm();
    useQueryClient();
    const { language } = usePreferences();
    return <p data-probe={useAdminLocation().pathname}>{t(language, "preferences.dark")}</p>;
  },
}));

async function render(language: string): Promise<string> {
  vi.stubGlobal("localStorage", { getItem: (key: string) => key === "cms.preference.language" ? language : null, setItem() {}, removeItem() {} });
  const { MantleAdmin, defineAdmin } = await import("../src/app");
  const { prelude } = await prerender(<MantleAdmin admin={defineAdmin({})} />);
  return new Response(prelude).text();
}

describe("<MantleAdmin>", () => {
  it("provides the query cache, preferences, router, confirm dialogs and toaster", async () => {
    const html = await render("en");
    expect(html).toContain("data-probe=");
    expect(html).toContain(">Dark</p>");
    expect(html).toContain('aria-label="Notifications');
  });

  it("loads the stored language before rendering", async () => {
    expect(await render("ja")).toContain(">ダーク</p>");
  });
});
