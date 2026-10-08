import { describe, expect, it } from "vitest";
import { contributionByRef, fieldContribution, matchesWhen } from "../src/lib/extensions";
import type { AdminExtensionInfo, SiteInfo } from "../src/lib/types";

const extension: AdminExtensionInfo = {
  id: "brand", title: "Brand", module: "/ext/brand.js",
  contributes: {
    pages: [], settings: [], actions: [],
    panels: [{ id: "usage", title: "Usage", role: "contributor", target: "record.sidebar/v1" }],
    fields: [
      { id: "money", target: "field.cell/v1", when: { format: ["money-minor"] } },
      { id: "color", target: "field.input/v1", when: { schema: ["products"], field: ["color"] } },
      { id: "picker", target: "field.input/v1" },
    ],
  },
};
const site = { extensions: [extension] } as unknown as SiteInfo;

describe("Admin extension placement", () => {
  it("matches when by names only, and never without when", () => {
    expect(matchesWhen(undefined, { schema: "products" })).toBe(false);
    expect(matchesWhen({ schema: ["products"] }, { schema: "products" })).toBe(true);
    expect(matchesWhen({ schema: ["products"], field: ["color"] }, { schema: "products", field: "name" })).toBe(false);
    expect(matchesWhen({ format: ["money-minor"] }, { schema: "orders", field: "total", property: { type: "integer", "x-mcp-hint": "money-minor" } })).toBe(true);
    expect(matchesWhen({ format: ["date-time"] }, { schema: "orders", field: "at", property: { type: "string", format: "date-time" } })).toBe(true);
    expect(matchesWhen({ format: ["money-minor"] }, { schema: "orders", field: "total" })).toBe(false);
  });

  it("prefers the manifest's name, which must fit the target, over a matching when", () => {
    expect(fieldContribution(site, "field.input/v1", { schema: "products", field: "color" })?.id).toBe("color");
    expect(fieldContribution(site, "field.input/v1", { schema: "products", field: "color", ref: "brand/picker" })?.id).toBe("picker");
    // a name of the wrong target is not used, and does not fall back to `when` either
    expect(fieldContribution(site, "field.input/v1", { schema: "products", field: "color", ref: "brand/money" })).toBeUndefined();
    expect(fieldContribution(site, "field.cell/v1", { schema: "orders", field: "total", property: { "x-mcp-hint": "money-minor" } })?.id).toBe("money");
    // a name the caller's role does not reach (absent from /site) leaves Admin's own control
    expect(fieldContribution(site, "field.input/v1", { schema: "x", field: "y", ref: "other/thing" })).toBeUndefined();
    // a manifest that names a built-in widget has decided too: a matching when does not override it
    expect(fieldContribution(site, "field.input/v1", { schema: "products", field: "color", ref: "textarea" })).toBeUndefined();
    expect(contributionByRef(site, "panels", "brand/usage")?.id).toBe("usage");
    expect(contributionByRef(site, "panels", "Brand/Usage")).toBeUndefined();
  });
});
