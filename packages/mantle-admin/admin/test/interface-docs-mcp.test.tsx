import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { PreferencesProvider } from "../src/app/preferences";
import { AdminRouterProvider } from "../src/app/router";
import { InterfaceDocsView } from "../src/features/logic/interface-docs-view";
import { developerConsoleQueryOptions } from "../src/lib/queries";

afterEach(() => vi.unstubAllGlobals());

const tool = { kind: "procedure", name: "enroll", target: "enroll", surface: "public", audience: "public", title: null, description: "Enroll", input: { type: "object" }, output: null, trigger: "enroll_mcp" };

function render(callable: unknown[], mcpEndpoints: { public: string | null; admin: string | null }): string {
  vi.stubGlobal("window", { location: { pathname: "/admin/dev/docs/mcp", search: "", href: "http://x/admin/dev/docs/mcp", origin: "http://x" }, addEventListener() {}, removeEventListener() {} });
  const client = new QueryClient();
  client.setQueryData(developerConsoleQueryOptions().queryKey, { interfaces: { http: [], callable } });
  client.setQueryData(["site"], { title: "Site", description: "", locales: ["en"], canonicalLocale: "en", mcpEndpoints });
  try {
    return renderToStaticMarkup(<PreferencesProvider initialLanguage="en"><QueryClientProvider client={client}><AdminRouterProvider><InterfaceDocsView /></AdminRouterProvider></QueryClientProvider></PreferencesProvider>);
  } finally { client.clear(); }
}

it("tells declared-but-unmounted MCP tools apart from none declared", () => {
  const unmounted = render([tool], { public: null, admin: null });
  expect(unmounted).toContain("1 MCP tools are declared, but this host mounts no MCP endpoint");
  expect(unmounted).not.toContain("No entry points are declared");
  expect(render([], { public: null, admin: null })).toContain("No entry points are declared");
  expect(render([tool], { public: "http://x/mcp", admin: null })).toContain("enroll_mcp");
});
