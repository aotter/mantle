import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RefLink, RefTitlesProvider, useRefTarget } from "../src/ui/ref-value";

function Probe({ field, value }: { field: string; value: unknown }): React.ReactElement {
  const target = useRefTarget(field, value);
  return target && typeof value === "string" ? <RefLink target={target} value={value} /> : <span>{String(value)}</span>;
}
const titles = { customer: { c1: { collection: "customers", id: "c1", title: "Acme" } } };

describe("reference values", () => {
  it("shows a resolved target as its title, linked to its record", () => {
    expect(renderToStaticMarkup(<RefTitlesProvider value={titles}><Probe field="customer" value="c1" /></RefTitlesProvider>)).toBe('<a href="/admin/c/customers/c1" title="c1" class="font-medium hover:underline">Acme</a>');
  });

  it("leaves a missing, deleted or unreadable target, and any other field, as the stored value", () => {
    const render = (field: string, value: string) => renderToStaticMarkup(<RefTitlesProvider value={titles}><Probe field={field} value={value} /></RefTitlesProvider>);
    expect(render("customer", "gone")).toBe("<span>gone</span>");
    expect(render("owner", "c1")).toBe("<span>c1</span>");
    expect(renderToStaticMarkup(<Probe field="customer" value="c1" />)).toBe("<span>c1</span>");
  });
});
