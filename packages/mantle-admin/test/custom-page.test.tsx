import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CustomPage } from "../admin/src/app/custom-page";
import type { AdminPage } from "../admin/src/app/define-admin";

const page: AdminPage = { path: "queue", title: { en: "Queue", "zh-TW": "待辦" }, element: <p>Rows</p> };
const render = (surface: "browser" | "mcp-app", extra: Partial<AdminPage> = {}) => renderToStaticMarkup(<CustomPage page={{ ...page, ...extra }} surface={surface} language="zh-TW" />);

it("preserves existing default headings on each surface", () => {
  expect(render("browser")).toContain("<h1");
  expect(render("mcp-app")).not.toContain("<h1");
  expect(render("browser")).toContain("待辦");
  expect(render("browser")).not.toContain('class="p-4"');
  expect(render("mcp-app")).not.toContain('class="p-4"');
});
it("explicit header composes the same localized heading and action on both surfaces", () => {
  const header = { description: { en: "Tasks", "zh-TW": "工作" }, actions: <button>Next</button> };
  expect(render("mcp-app", { header })).toContain('<section aria-label="待辦" class="p-4">');
  expect(render("browser", { header })).not.toContain('class="p-4"');
  expect(render("mcp-app", { header }).replace(' class="p-4"', "")).toBe(render("browser", { header }));
  expect(render("browser", { header }).match(/<h1/g)).toHaveLength(1);
  expect(render("browser", { header })).toContain("工作");
  expect(render("browser", { header })).toContain("<button>Next</button>");
});
it("false gives the page element ownership of its sole heading", () => {
  for (const surface of ["browser", "mcp-app"] as const) {
    const html = render(surface, { header: false, element: <h1>Own heading</h1> });
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Own heading");
    expect(html).not.toContain('class="p-4"');
  }
});
