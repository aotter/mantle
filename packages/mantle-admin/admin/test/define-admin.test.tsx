import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as app from "../src/app";
import { defineAdmin, MantleAdmin } from "../src/app";
import admin from "../src/default-entry";

describe("Admin as a library", () => {
  it("defineAdmin returns a definition carrying the metadata", () => {
    const meta = { collections: {} };
    expect(defineAdmin(meta)).toEqual({ meta });
  });

  it("exports only defineAdmin and MantleAdmin; preview is not a public prop", () => {
    expect(Object.keys(app).sort()).toEqual(["MantleAdmin", "defineAdmin"]);
    // @ts-expect-error preview mode belongs to the canonical preview document, which installs the preview policy first
    void (<MantleAdmin admin={admin} preview />);
  });

  it("the default entry is defineAdmin with empty metadata, and <MantleAdmin> renders it through the session gate", () => {
    expect(admin).toEqual({ meta: {} });
    const html = renderToStaticMarkup(<MantleAdmin admin={admin} />);
    expect(html).toContain('aria-busy="true"');
  });
});
