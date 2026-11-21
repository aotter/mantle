import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarProvider, TooltipProvider } from "@aotter/mantle-ui/kit";
import { defineAdmin } from "../src/app/define-admin";
import { PreferencesProvider } from "../src/app/preferences";
import { AdminRouterProvider } from "../src/app/router";
import { SurfaceProvider } from "../src/app/slots";
import { AdminApp } from "../src/app/admin-app";

const layers = defineAdmin({}, { components: { Brand: props => <b data-placement={props.placement}>{props.title}</b> } })
  .layers;

const at = (pathname: string, seed: (client: QueryClient) => void = () => {}) => {
  const win = { location: { pathname, search: "", hash: "" }, history: { state: null } } as unknown as Window;
  Object.assign(win, { self: win, top: win, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("window", win);
  const client = new QueryClient();
  seed(client);
  return renderToStaticMarkup(
    <PreferencesProvider initialLanguage="en">
      <QueryClientProvider client={client}>
        <SurfaceProvider surface="browser" host={null} layers={layers}>
          <TooltipProvider>
            <SidebarProvider>
              <AdminRouterProvider>
                <AdminApp />
              </AdminRouterProvider>
            </SidebarProvider>
          </TooltipProvider>
        </SurfaceProvider>
      </QueryClientProvider>
    </PreferencesProvider>,
  );
};
const signedIn = (client: QueryClient) => client.setQueryData(["me"], { login: "ada", role: "admin", image: null });

afterEach(() => vi.unstubAllGlobals());

// The loading frame shows the application's `Brand` only before the console (#1943); inside it the sidebar shows it.
it("shows the Brand in the loading frame while the session loads", () => {
  const html = at("/admin/c/posts/1");
  expect(html).toContain('role="status"');
  expect(html).toContain('data-placement="loading"');
});

it("keeps the in-console loading states neutral", () => {
  for (const path of ["/admin/c/posts/1", "/admin/dev"]) {
    const html = at(path, signedIn);
    expect(html, path).toContain('role="status"');
    expect(html, path).not.toContain('data-placement="loading"');
  }
});
