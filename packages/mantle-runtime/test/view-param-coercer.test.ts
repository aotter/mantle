import { describe, expect, it } from "vitest";
import {
  ViewParamCoercionError,
  coerceViewParams,
} from "../src/domain/service/ViewParamCoercer.js";
import type { JsonSchema, ViewManifest } from "@aotter/mantle-spec";

function view(params: JsonSchema | undefined): ViewManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "View",
    metadata: { name: "v" },
    spec: { surface: "public", from: "posts", ...(params ? { params } : {}) },
  };
}

function query(map: Record<string, string>) {
  return {
    get(name: string): string | null {
      return Object.prototype.hasOwnProperty.call(map, name) ? map[name]! : null;
    },
  };
}

describe("coerceViewParams", () => {
  it("returns {} when View has no params declared", () => {
    expect(coerceViewParams(view(undefined), query({}))).toEqual({});
  });

  it("coerces string / integer / number / boolean by declared type", () => {
    const out = coerceViewParams(
      view({
        type: "object",
        properties: {
          s: { type: "string" },
          i: { type: "integer" },
          n: { type: "number" },
          b: { type: "boolean" },
        },
        required: ["s", "i", "n", "b"],
      }),
      query({ s: "hi", i: "42", n: "3.14", b: "true" }),
    );
    expect(out).toEqual({ s: "hi", i: 42, n: 3.14, b: true });
  });

  it("rejects integer partial-parses ('1.5', '1abc') and non-numeric ('abc')", () => {
    const v = view({
      type: "object",
      properties: { i: { type: "integer" } },
      required: ["i"],
    });
    for (const bad of ["1.5", "1abc", "abc"]) {
      expect(() => coerceViewParams(v, query({ i: bad }))).toThrow(ViewParamCoercionError);
    }
  });

  it("accepts whitespace-padded canonical integers ('  1  ')", () => {
    const out = coerceViewParams(
      view({
        type: "object",
        properties: { i: { type: "integer" } },
        required: ["i"],
      }),
      query({ i: "  1  " }),
    );
    expect(out).toEqual({ i: 1 });
  });

  it("coerces type FIRST then checks enum membership against the typed value", () => {
    // type: integer + enum: [1,2,3] — query string "1" must coerce to int 1
    // before the enum.includes check, otherwise enum-first would throw
    // ([1,2,3].includes("1") is false).
    const out = coerceViewParams(
      view({
        type: "object",
        properties: { count: { type: "integer", enum: [1, 2, 3] } },
        required: ["count"],
      }),
      query({ count: "2" }),
    );
    expect(out).toEqual({ count: 2 });
  });

  it("rejects integer enum mismatch with the typed value", () => {
    expect(() =>
      coerceViewParams(
        view({
          type: "object",
          properties: { count: { type: "integer", enum: [1, 2, 3] } },
          required: ["count"],
        }),
        query({ count: "5" }),
      ),
    ).toThrow(ViewParamCoercionError);
  });

  it("string enum still works (raw value matches array literally)", () => {
    const out = coerceViewParams(
      view({
        type: "object",
        properties: { locale: { type: "string", enum: ["en", "zh-TW"] } },
        required: ["locale"],
      }),
      query({ locale: "zh-TW" }),
    );
    expect(out).toEqual({ locale: "zh-TW" });
  });

  it("throws ViewParamCoercionError when a required param is missing", () => {
    expect(() =>
      coerceViewParams(
        view({
          type: "object",
          properties: { locale: { type: "string" } },
          required: ["locale"],
        }),
        query({}),
      ),
    ).toThrow(ViewParamCoercionError);
  });

  it("optional params absent → omitted from output (no undefined keys)", () => {
    const out = coerceViewParams(
      view({
        type: "object",
        properties: { tag: { type: "string" } },
      }),
      query({}),
    );
    expect(out).toEqual({});
    expect("tag" in out).toBe(false);
  });
});
