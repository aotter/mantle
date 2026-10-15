import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SidebarProvider, TooltipProvider } from "@aotter/mantle-ui/kit";
import { defineAdmin, type AdminMeta } from "../src/app/define-admin";
import { PreferencesProvider } from "../src/app/preferences";
import { AdminRouterProvider } from "../src/app/router";
import { Slot, SurfaceProvider, type SlotProps } from "../src/app/slots";
import type { SidebarProps } from "../src/app/slot-props";
import { AppSidebar } from "../src/layout/app-sidebar";
import { ShellContext } from "../src/layout/shell-context";
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
