import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@aotter/mantle-ui/kit";
import { defineAdmin } from "../src/app/define-admin";
import { PreferencesProvider } from "../src/app/preferences";
import { SurfaceProvider } from "../src/app/slots";
import { AccessDeniedView, GateError, GateLoading } from "../src/features/auth/gate-views";
import { ConnectedAppsPage, OAuthConsentView, SignInView } from "../src/features/auth/auth-views";

// The application's `Brand` on the pages before or without the console (#1943), with no sidebar around them.
const render = (node: React.ReactNode, layers: ReturnType<typeof defineAdmin>["layers"], client = new QueryClient()) =>
  renderToStaticMarkup(
    <PreferencesProvider initialLanguage="en">
      <QueryClientProvider client={client}>
        <SurfaceProvider surface="browser" host={null} layers={layers}>
          <TooltipProvider>{node}</TooltipProvider>
        </SurfaceProvider>
      </QueryClientProvider>
    </PreferencesProvider>,
  );

const branded = defineAdmin(
  {},
  {
    components: {
      Brand: props => (
        <b data-placement={props.placement} data-image={String(props.image)} data-href={props.href}>
          {props.title}
          {props.renderDefault(props)}
        </b>
      ),
    },
  },
).layers;

const consented = () => {
  const client = new QueryClient();
  client.setQueryData(["oauth-consent", ""], {
    clientName: "Example",
    redirectUri: "https://client.example.test/cb",
    scopes: ["mcp"],
    oauthQuery: "q",
  });
  return client;
};

const surfaces: [string, () => React.ReactNode, QueryClient?][] = [
  ["sign-in", () => <SignInView />],
  ["consent", () => <OAuthConsentView />, consented()],
  ["connected-apps", () => <ConnectedAppsPage />],
  ["access-denied", () => <AccessDeniedView login="ada" />],
  ["error", () => <GateError error={new Error("down")} />],
  ["loading", () => <GateLoading brand />],
];

describe("Brand before and without the console", () => {
  beforeAll(() => vi.stubGlobal("window", { location: { search: "", pathname: "/admin/sign-in" } }));
  afterAll(() => vi.unstubAllGlobals());

  it.each(surfaces)("%s renders the application's Brand in a bounded box, with nothing as its default", (placement, node, client) => {
    const html = render(node(), branded, client);
    expect(html).toContain(`<div class="peer flex max-h-10 min-w-0 items-center overflow-hidden empty:hidden`);
    expect(html).toContain(`<b data-placement="${placement}" data-image="undefined" data-href="/admin">Admin console</b>`);
  });

  it.each(surfaces)("%s is unchanged when the application supplies no Brand", (_placement, node, client) => {
    const html = render(node(), {}, client);
    expect(html).not.toContain("max-h-10");
    expect(html).not.toContain("data-placement");
  });

  // a component may render nothing for a placement it does not want; the page then looks as it does without a Brand
  const sidebarOnly = defineAdmin(
    {},
    { components: { Brand: props => (props.placement === "sidebar" ? <b>{props.title}</b> : null) } },
  ).layers;
  const emptyBox = /<div class="peer flex max-h-10 [^"]*empty:hidden[^"]*"><\/div>/;

  it.each(surfaces)("%s looks as it does without a Brand when the Brand renders nothing there", (_placement, node, client) => {
    const html = render(node(), sidebarOnly, client);
    expect(html).toMatch(emptyBox);
    expect(html.replace(emptyBox, "")).toBe(render(node(), {}, client));
  });

  it("keeps the loading frame neutral: the brand in its bar, never the sign-in card", () => {
    const html = render(<GateLoading brand />, branded);
    expect(html).toContain('role="status"');
    expect(html).not.toMatch(/data-slot="card"|<form|<input/);
    expect(render(<GateLoading />, {})).toContain('data-slot="skeleton"');
  });
});
