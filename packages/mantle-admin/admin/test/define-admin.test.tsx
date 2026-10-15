import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { defineAdmin, MantleAdmin } from "../src/app";
import admin from "../src/default-entry";

describe("Admin as a library", () => {
  it("defineAdmin returns a frozen definition carrying the metadata", () => {
    const meta = { collections: {} };
    const definition = defineAdmin(meta);
    expect(definition).toEqual({ meta });
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it("the default entry is defineAdmin with empty metadata, and <MantleAdmin> renders it through the session gate", () => {
    expect(admin).toEqual({ meta: {} });
    const html = renderToStaticMarkup(<MantleAdmin admin={admin} />);
    expect(html).toContain('aria-busy="true"');
  });
});
