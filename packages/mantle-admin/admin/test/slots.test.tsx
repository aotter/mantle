import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defineAdmin, type AdminMeta } from "../src/app/define-admin";
import type { AdminHost } from "../src/app/hooks";
import { AdminLink, isBothSlot, Slot, SurfaceProvider, useOpenLink, useViewCellNames, type SlotProps } from "../src/app/slots";
import type { SidebarProps } from "../src/app/slot-props";

/** The generated types of a small application: what `generated/admin-client.ts` describes. */
interface Types {
  readonly views: { readonly "pending-requests": { readonly input: { readonly q?: string }; readonly row: { readonly id: string; readonly amount: number } } };
  readonly collections: { readonly requests: { readonly data: { readonly title: string; readonly status: "open" | "closed" } } };
  readonly operations: { readonly approve: { readonly input: { readonly id: string }; readonly output: { readonly ok: true } } };
}
const admin: AdminMeta<Types> = {};

/** A component for any slot: it names itself around what it wraps. */
const tag = (name: string) => (props: { readonly renderDefault: (props: never) => React.ReactNode }) => <>{name}({(props.renderDefault as (props: object) => React.ReactNode)(props)})</>;
const Default = ({ footer, label = "built-in" }: { footer?: React.ReactNode; label?: string }) => <p data-default>{label}{footer}</p>;
const show = (layers: ReturnType<typeof defineAdmin>["layers"], names: string | readonly string[], props: object = {}, surface: "browser" | "mcp-app" = "browser", host: AdminHost | null = null) =>
  renderToStaticMarkup(<SurfaceProvider surface={surface} host={host} layers={layers}><Slot name={names} Default={Default} props={props} /></SurfaceProvider>);

describe("slots", () => {
  it("renders the built-in component without a provider or a layer", () => {
    expect(renderToStaticMarkup(<Slot name="Sidebar" Default={Default} props={{}} />)).toBe("<p data-default=\"true\">built-in</p>");
    expect(show({}, "Sidebar")).toBe("<p data-default=\"true\">built-in</p>");
  });

  it("replaces the built-in component, or wraps it with renderDefault", () => {
    const replaced = defineAdmin(admin, { components: { Sidebar: () => <nav>mine</nav> } });
    expect(show(replaced.layers, "Sidebar")).toBe("<nav>mine</nav>");
    const wrapped = defineAdmin(admin, { components: { Sidebar: (props) => <section>{props.renderDefault(props)}</section> } });
    expect(show(wrapped.layers, "Sidebar")).toBe("<section><p data-default=\"true\">built-in</p></section>");
  });

  it("passes the props a component changed on to the built-in one", () => {
    const sidebar = defineAdmin(admin, { components: { Sidebar: (props: SlotProps<SidebarProps>) => props.renderDefault({ ...props, footer: <em>Help</em> }) } });
    expect(show(sidebar.layers, "Sidebar", { groups: [], brand: { title: "x" } })).toContain("<em>Help</em>");
  });

  it("stacks plugins in order, with the application's own components outermost", () => {
    
    const composed = defineAdmin(admin, { components: { Home: tag("app") }, plugins: [{ components: { Home: tag("first") } }, { components: { Home: tag("second") } }] });
    expect(show(composed.layers, "Home")).toBe("app(second(first(<p data-default=\"true\">built-in</p>)))");
  });

  it("keeps record/collection slots browser-only and passes the host surface to View cells", () => {
    const seen: unknown[] = [];
    const probe = (props: object) => { seen.push("surface" in props ? (props as { surface: string }).surface : "none"); return null; };
    const composed = defineAdmin(admin, { components: {
      Sidebar: probe, "record.aside:requests": probe, "input:requests.title": probe,
      "cell:requests.title": probe, "cell:view:pending-requests.amount": probe,
    } });
    show(composed.layers, "Sidebar");
    // These slots mount on the browser record/collection pages, never the MCP Procedure action form.
    for (const name of ["record.aside:requests", "input:requests.title", "cell:requests.title"]) {
      expect(isBothSlot(name)).toBe(false);
      show(composed.layers, name);
    }
    expect(isBothSlot("cell:view:pending-requests.amount")).toBe(true);
    show(composed.layers, "cell:view:pending-requests.amount", {}, "browser");
    show(composed.layers, "cell:view:pending-requests.amount", {}, "mcp-app");
    expect(seen).toEqual(["none", "browser", "browser", "browser", "browser", "mcp-app"]);
  });

  it("stacks a View column's component on the Schema field's, which sits on the built-in one", () => {
    
    const composed = defineAdmin(admin, { components: { "cell:requests.title": tag("field"), "cell:view:pending-requests.amount": tag("column") } });
    expect(show(composed.layers, ["cell:requests.title", "cell:view:pending-requests.amount"])).toBe("column(field(<p data-default=\"true\">built-in</p>))");
    // a slot nobody filled leaves the others as they are
    expect(show(composed.layers, ["cell:requests.status", "cell:view:pending-requests.amount"])).toBe("column(<p data-default=\"true\">built-in</p>)");
  });

  it("types components from the generated metadata", () => {
    defineAdmin(admin, {
      components: {
        "cell:requests.title": ({ value, row }) => `${value}${row.status ?? ""}`,
        // @ts-expect-error a list row holds only the columns shown, so a field may be missing
        "cell:requests.status": ({ row }) => row.title.length,
        "cell:view:pending-requests.amount": ({ value, row }) => value + row.amount,
        "input:requests.status": ({ value, onChange }) => { onChange(value === "open" ? "closed" : "open"); return null; },
        "record.actions:requests": ({ entry }) => entry.data.title,
      },
    });
    // @ts-expect-error a misspelt collection is not a slot
    defineAdmin(admin, { components: { "record.aside:request": () => null } });
    // @ts-expect-error a misspelt field is not a slot
    defineAdmin(admin, { components: { "cell:requests.titel": () => null } });
    // @ts-expect-error a browser slot has no surface
    defineAdmin(admin, { components: { Header: ({ surface }) => String(surface) } });
  });

  it("types the landing target by the generated manifest, and keeps it as given", () => {
    expect(defineAdmin(admin, {}).home).toBeUndefined();
    expect(defineAdmin(admin, { home: { view: "pending-requests" } }).home).toEqual({ view: "pending-requests" });
    expect(defineAdmin(admin, { home: { collection: "requests", filter: { status: "open" } } }).home).toEqual({ collection: "requests", filter: { status: "open" } });
    expect(defineAdmin(admin, { home: { page: "budget" } }).home).toEqual({ page: "budget" });
    // @ts-expect-error a landing collection is one of the manifest's
    defineAdmin(admin, { home: { collection: "orders" } });
  });

  it("types a nav badge by the generated View and one of its row's columns, and reports more than 20 badged Views", () => {
    const item = { group: "reports", title: "Waiting", to: { view: "pending-requests" } } as const;
    expect(defineAdmin(admin, { nav: { items: [{ ...item, badge: { view: "pending-requests", field: "amount" } }] } }).nav.items[0]!.badge).toEqual({ view: "pending-requests", field: "amount" });
    // @ts-expect-error a badge names a View of the manifest
    defineAdmin(admin, { nav: { items: [{ ...item, badge: { view: "pending", field: "amount" } }] } });
    // @ts-expect-error a badge reads a column the View returns
    defineAdmin(admin, { nav: { items: [{ ...item, badge: { view: "pending-requests", field: "count" } }] } });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const open = defineAdmin({} as AdminMeta, { nav: { items: Array.from({ length: 21 }, (_, i) => ({ group: "reports", title: "v" + i, to: { view: "v" + i }, badge: { view: "v" + i, field: "count" } })) } });
    expect(open.nav.items).toHaveLength(21);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("only the first 20"));
    error.mockRestore();
  });
});

describe("matching a View's tool to its slots", () => {
  it("finds the cell:view components of the View whose tool this is", () => {
    // without generated types, any View and column name is a slot
    const composed = defineAdmin({}, { components: { "cell:view:pending-requests.amount": () => null, "cell:view:other.amount": () => null } });
    const Names = ({ tool, column }: { tool: string; column: string }) => <>{useViewCellNames(tool, column).join(",")}</>;
    const html = (tool: string, column: string) => renderToStaticMarkup(<SurfaceProvider surface="mcp-app" host={null} layers={composed.layers}><Names tool={tool} column={column} /></SurfaceProvider>);
    expect(html("pending_requests", "amount")).toBe("cell:view:pending-requests.amount");
    expect(html("pending_requests", "id")).toBe("");
  });
});

describe("links", () => {
  const host = (openLink: AdminHost["openLink"]): AdminHost => ({ context: {}, capabilities: { openLinks: {} }, openLink, sendMessage: async () => true, updateModelContext: async () => true, requestDisplayMode: async () => null });
  const inHost = (node: React.ReactNode, openLink: AdminHost["openLink"] = async () => true) => renderToStaticMarkup(<SurfaceProvider surface="mcp-app" host={host(openLink)} layers={{}}>{node}</SurfaceProvider>);

  it("is an anchor in the browser, and in a host opens http(s) through the host and shows any other target as text", () => {
    expect(renderToStaticMarkup(<AdminLink href="/admin/c/requests">Requests</AdminLink>)).toBe('<a href="/admin/c/requests">Requests</a>');
    expect(inHost(<AdminLink href="https://example.com/a">Docs</AdminLink>)).toBe('<a href="https://example.com/a">Docs</a>');
    expect(inHost(<AdminLink href="/admin/c/requests">Requests</AdminLink>)).toBe("<span>Requests</span>");
  });

  it("opens only http(s) URLs: ui/open-link in a host, a new tab in the browser", async () => {
    const open = vi.fn(async () => true);
    let openLink: ReturnType<typeof useOpenLink> | undefined;
    const Probe = () => { openLink = useOpenLink(); return null; };
    inHost(<Probe />, open);
    expect(await openLink!("https://example.com")).toBe(true);
    expect(await openLink!("javascript:alert(1)")).toBe(false);
    expect(await openLink!("/admin")).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    const tab = vi.fn(() => null); // what a real `noopener` open returns
    vi.stubGlobal("window", { open: tab });
    renderToStaticMarkup(<Probe />);
    expect(await openLink!("https://example.com")).toBe(true);
    expect(tab).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
    vi.unstubAllGlobals();
  });
});
