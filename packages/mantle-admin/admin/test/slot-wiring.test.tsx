import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SidebarProvider, TooltipProvider } from "@aotter/mantle-ui/kit";
import { defineAdmin, type AdminMeta } from "../src/app/define-admin";
import { PreferencesProvider } from "../src/app/preferences";
import { AdminRouterProvider } from "../src/app/router";
import { ProjectNavProvider, type ProjectNav } from "../src/app/project-nav";
import { Slot, SurfaceProvider, type SlotProps } from "../src/app/slots";
import type { SidebarProps } from "../src/app/slot-props";
import { AppSidebar } from "../src/layout/app-sidebar";
import { ShellContext } from "../src/layout/shell-context";
import { AuthenticatedLayout } from "../src/layout/authenticated-layout";
import { FormActionBar } from "../src/ui/page";
import { operationsQueryOptions, viewsManifestQueryOptions } from "../src/lib/queries";
import { DataCell } from "../src/ui/data-cell";
import { SchemaFields } from "../src/features/content/entry-edit-view";

interface Types {
  readonly views: { readonly "pending-requests": { readonly input: object; readonly row: { readonly id: string; readonly amount: number } } };
  readonly collections: { readonly requests: { readonly data: { readonly title: string } } };
  readonly operations: Record<string, never>;
}
const admin: AdminMeta<Types> = {};

const shell = (node: React.ReactNode, layers: ReturnType<typeof defineAdmin>["layers"]) => renderToStaticMarkup(
  <PreferencesProvider initialLanguage="en"><QueryClientProvider client={new QueryClient()}>
    <SurfaceProvider surface="browser" host={null} layers={layers}><TooltipProvider><AdminRouterProvider>
      <ShellContext.Provider value={{ brand: { title: "Acme" }, publicUrl: undefined, workspaceLink: undefined, actionsHostRef: () => {}, user: { login: "ada", image: null, role: "admin" } }}>
        <SidebarProvider>{node}</SidebarProvider>
      </ShellContext.Provider>
    </AdminRouterProvider></TooltipProvider></SurfaceProvider>
  </QueryClientProvider></PreferencesProvider>,
);

describe("Admin's built-in components through their slots", () => {
  const sidebar = <Slot name="Sidebar" Default={AppSidebar} props={{ brand: { title: "Acme" }, groups: [{ title: "Content", items: [{ title: "Requests", url: "/admin/c/requests" }] }] }} />;

  it("renders the sidebar as built, and with a footer the application asked for", () => {
    const plain = shell(sidebar, {});
    expect(plain).toContain("Requests");
    expect(plain).toContain("Acme");
    expect(plain).not.toContain("Need help?");
    const withFooter = shell(sidebar, defineAdmin(admin, { components: { Sidebar: (props: SlotProps<SidebarProps>) => props.renderDefault({ ...props, footer: <p>Need help?</p> }) } }).layers);
    expect(withFooter).toContain("Need help?");
    expect(withFooter).toContain("Requests");
  });

  it("highlights only the preset item on a preset URL, not the default entry of the same collection", () => {
    const at = (pathname: string, search: string) => {
      vi.stubGlobal("window", { location: { pathname, search, href: `http://x${pathname}${search}`, origin: "http://x" }, addEventListener() {}, removeEventListener() {} });
      try { return shell(<Slot name="Sidebar" Default={AppSidebar} props={{ brand: { title: "Acme" }, groups: [
        { title: "Records", items: [{ title: "requests", url: "/admin/c/requests" }] },
        { title: "Reports", items: [{ title: "Rejected", url: "/admin/c/requests?filter_field=status&filter_value=rejected" }] },
      ] }} />, {}); } finally { vi.unstubAllGlobals(); }
    };
    const activeLabels = (html: string) => [...html.matchAll(/data-active="true"[^>]*>.*?<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(activeLabels(at("/admin/c/requests", "?filter_field=status&filter_value=rejected"))).toEqual(["Rejected"]);
    expect(activeLabels(at("/admin/c/requests", ""))).toEqual(["requests"]);
  });

  it("replaces the brand inside the built-in sidebar", () => {
    const html = shell(sidebar, defineAdmin(admin, { components: { Brand: (props) => <b>{props.title.toUpperCase()}</b> } }).layers);
    expect(html).toContain("<b>ACME</b>");
    expect(html).toContain("Requests");
  });

  it("shows a list cell as built, and as the application's component when it has one", () => {
    const cell = <DataCell names={["cell:requests.title"]} field="title" value="Laptops" row={{ title: "Laptops" }} property={{ type: "string" }} />;
    expect(shell(cell, {})).toContain("Laptops");
    const html = shell(cell, defineAdmin(admin, { components: { "cell:requests.title": ({ value, surface, renderDefault, ...props }) => <i data-surface={surface}>{value.toUpperCase()} {renderDefault({ ...props, value: `${value}!` })}</i> } }).layers);
    expect(html).toContain('<i data-surface="browser">LAPTOPS Laptops!</i>');
  });

  it("lets an application's input wrap a record form's control, which keeps the built-in editor for the value it passes", () => {
    const form = (inputSlots?: { schema: string; readOnly: boolean }) => (
      <SchemaFields schema={{ type: "object", properties: { title: { type: "string" }, note: { type: "string" } } }} value={{ title: "Laptops", note: "n" }} path={[]} onChange={() => {}}
        language="en" canonical={null} collectionName="requests" mediaPurposes={[]} {...(inputSlots ? { inputSlots } : {})} />
    );
    const layers = defineAdmin(admin, { components: { "input:requests.title": ({ value, readOnly, surface, renderDefault, ...props }) => <div data-input={`${surface}:${readOnly}`}>{renderDefault({ ...props, value: `${value}+`, readOnly })}</div> } }).layers;
    const html = shell(form({ schema: "requests", readOnly: true }), layers);
    expect(html).toContain('data-input="browser:true"');
    expect(html).toContain('value="Laptops+"');
    // only the field it names; and a form that is not a record form (a View's parameters) has no input slots
    expect(html).toContain('value="n"');
    expect(shell(form(), layers)).not.toContain("data-input");
    expect(shell(form({ schema: "requests", readOnly: false }), {})).toContain('value="Laptops"');
  });
});

describe("the pages mount their slots", () => {
  const layout = (layers: ReturnType<typeof defineAdmin>["layers"], workspace: "content" | "developer", children: React.ReactNode = <p>page</p>, nav?: ProjectNav, listed: unknown[] = []) => {
    const client = new QueryClient();
    client.setQueryData(["me"], { login: "ada", image: null, role: "admin", admin: true });
    client.setQueryData(["collections"], listed);
    client.setQueryData(["site"], { brand: "Acme", icons: [] });
    client.setQueryData(viewsManifestQueryOptions().queryKey, []);
    client.setQueryData(operationsQueryOptions().queryKey, []);
    return renderToStaticMarkup(
      <PreferencesProvider initialLanguage="en"><QueryClientProvider client={client}>
        <SurfaceProvider surface="browser" host={null} layers={layers}><TooltipProvider><AdminRouterProvider>
          <ProjectNavProvider nav={nav ?? { groups: {}, items: [] }}><AuthenticatedLayout workspace={workspace}>{children}</AuthenticatedLayout></ProjectNavProvider>
        </AdminRouterProvider></TooltipProvider></SurfaceProvider>
      </QueryClientProvider></PreferencesProvider>,
    );
  };
  const mine = defineAdmin(admin, { components: {
    Sidebar: () => <nav>my-sidebar</nav>,
    Header: () => <header>my-header</header>,
  } }).layers;

  it("wraps the content workspace's sidebar and header, and leaves the developer workspace as built", () => {
    const content = layout(mine, "content");
    expect(content).toContain("my-sidebar");
    expect(content).toContain("my-header");
    const developer = layout(mine, "developer");
    expect(developer).not.toContain("my-sidebar");
    expect(developer).not.toContain("my-header");
    expect(developer).toContain("Overview");
  });

  it("gives the sidebar the groups and items the application declared with defineAdmin", () => {
    const { nav } = defineAdmin(admin, { nav: { groups: { approvals: { title: "Approvals", order: 5 } }, items: [{ group: "approvals", title: "Rejected", to: { collection: "requests", filter: { title: "late" } } }] } });
    const requests = { name: "requests", title: "requests", description: null, lifecycle: "operational", parent: null, localized: false, hasTranslations: false, exportFields: [], uiSchema: null };
    const sidebar = defineAdmin(admin, { components: { Sidebar: ({ groups }) => <nav>{JSON.stringify(groups.map(({ title, items }) => [title, items.map(item => ("url" in item ? item.url : item.title))]))}</nav> } }).layers;
    const html = layout(sidebar, "content", <p>page</p>, nav, [requests]).split("&quot;").join('"');
    expect(html).toContain('["Approvals",["/admin/c/requests?filter_field=title&amp;filter_value=late"]]');
    expect(layout(sidebar, "content", <p>page</p>, undefined, [requests]).split("&quot;").join('"')).not.toContain("Approvals");
  });

  it("replaces the whole shell, and keeps a record form's action bar in the page", () => {
    const layers = defineAdmin(admin, { components: { Shell: ({ children }) => <main data-shell="mine">{children}</main> } }).layers;
    const html = layout(layers, "content", <FormActionBar><button>Save</button></FormActionBar>);
    expect(html).toContain('data-shell="mine"');
    expect(html).toContain("<button>Save</button>");
  });

  it("mounts every page slot where its page renders", () => {
    const src = (file: string) => readFileSync(resolve(import.meta.dirname, "../src", file), "utf8");
    const app = src("app/admin-app.tsx");
    for (const name of ["CollectionList", "RecordView", "Home"]) expect(app, name).toMatch(new RegExp(`<Slot name="${name}"`));
    const edit = src("features/content/entry-edit-view.tsx");
    for (const name of ["record\\.aside", "record\\.actions", "input"]) expect(edit, name).toMatch(new RegExp(`<Slot name=\\{`+"`"+`${name}:`));
    expect(src("features/content/collection-view.tsx")).toMatch(/<Slot name=\{`list\.actions:/);
    // a list column goes through its Schema field's slot; a View column through its Schema field's, then its own
    expect(src("features/content/collection-view.tsx")).toContain("`cell:${collection?.name ?? \"\"}.${name}`");
    const view = src("features/ops/view-page.tsx");
    expect(view).toContain("`cell:${view.columns[col].schema}.${view.columns[col].field}`");
    expect(view).toContain("`cell:view:${name}.${col}`");
  });

  it("passes on what a layer leaves out, so a component that forwards only the typed props still renders Admin's own", () => {
    const html = shell(<Slot name="x" Default={(p: { a: string; hidden?: string }) => <i>{p.a}{p.hidden}</i>} props={{ a: "A", hidden: "H" }} />,
      { x: [({ a, renderDefault }: SlotProps<{ a: string }>) => renderDefault({ a })] as never });
    expect(html).toContain("<i>AH</i>");
  });
});
