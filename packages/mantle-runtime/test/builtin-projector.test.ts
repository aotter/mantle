import { describe, expect, it } from "vitest";
import type { SchemaManifest } from "@aotter/mantle-spec";
import { projectAndStamp } from "../src/domain/service/BuiltinProjector.js";

const schema: SchemaManifest = {
  apiVersion: "cms.mantle.aotter.net/v1",
  kind: "Schema",
  metadata: { name: "posts" },
  spec: {
    title: "Posts",
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        authorId: { type: "string", "x-mantle-bind": "ctx.user" },
        editorId: { type: "string", "x-mantle-bind": "ctx.staff" },
        createdAt: { type: "number", "x-mantle-bind": "now" },
      },
    },
    lifecycle: "publishing",
  },
};

describe("projectAndStamp", () => {
  it("keeps Schema-declared keys and drops side-channel ones", () => {
    const out = projectAndStamp({
      schema,
      input: { title: "x", body: "y", recaptchaToken: "tok" },
      ctx: { user: { id: "u" }, staff: null, env: {} },
      clockNow: 1,
    });
    expect(out).toEqual({
      title: "x",
      body: "y",
      authorId: "u",
      editorId: null,
      createdAt: 1,
    });
    expect("recaptchaToken" in out).toBe(false);
  });

  it("server-stamps x-mantle-bind keys regardless of caller-supplied value", () => {
    const out = projectAndStamp({
      schema,
      input: { title: "x", authorId: "spoofed", createdAt: 0 },
      ctx: { user: { id: "u" }, staff: { id: "u", role: "editor" }, env: {} },
      clockNow: 999,
    });
    expect(out["authorId"]).toBe("u");
    expect(out["editorId"]).toBe("u");
    expect(out["createdAt"]).toBe(999);
  });

  it("ctx.user / ctx.staff bind to null when ctx has no user / staff", () => {
    const out = projectAndStamp({
      schema,
      input: { title: "x" },
      ctx: { user: null, staff: null, env: {} },
      clockNow: 0,
    });
    expect(out["authorId"]).toBeNull();
    expect(out["editorId"]).toBeNull();
  });

  it("schemas without properties yield an empty object", () => {
    const noProps: SchemaManifest = {
      ...schema,
      spec: { ...schema.spec, schema: { type: "object" } },
    };
    const out = projectAndStamp({
      schema: noProps,
      input: { anything: "goes" },
      ctx: { user: null, staff: null, env: {} },
      clockNow: 0,
    });
    expect(out).toEqual({});
  });
});
