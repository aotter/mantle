import { describe, expect, it } from "vitest";
import {
  bootDiagnostic,
  type Diagnostic,
  DiagnosticError,
  httpStatusFor,
  HTTP_STATUS_BY_CODE,
  makeDiagnostic,
  readJsonPointer,
  redactForWire,
  runtimeDiagnostic,
  validateDiagnostic,
} from "../src/kernel/diagnostic.js";

describe("phase-tagging helpers", () => {
  it("validateDiagnostic stamps phase: 'validate'", () => {
    const d = validateDiagnostic({
      code: "DUPLICATE_NAME",
      severity: "error",
      path: "/manifests/0/metadata/name",
    });
    expect(d.phase).toBe("validate");
    expect(d.code).toBe("DUPLICATE_NAME");
    expect(d.severity).toBe("error");
    expect(d.path).toBe("/manifests/0/metadata/name");
  });

  it("bootDiagnostic stamps phase: 'boot'", () => {
    const d = bootDiagnostic({
      code: "HANDLER_NOT_REGISTERED",
      severity: "error",
      path: "/procedures/contactSubmit",
    });
    expect(d.phase).toBe("boot");
  });

  it("runtimeDiagnostic stamps phase: 'runtime'", () => {
    const d = runtimeDiagnostic({
      code: "INPUT_VALIDATION_FAILED",
      severity: "error",
      path: "/body/email",
    });
    expect(d.phase).toBe("runtime");
  });
});

describe("makeDiagnostic message derivation", () => {
  it("derives a message from structured fields when none provided", () => {
    const d = makeDiagnostic({
      code: "VIEW_FIELD_NOT_IN_SCHEMA",
      phase: "validate",
      severity: "error",
      path: "/views/postsList/spec/select/0",
      value: "tilte",
      expected: "a field declared on the source Schema",
      suggestion: "title",
    });
    expect(d.message).toContain("[validate/VIEW_FIELD_NOT_IN_SCHEMA]");
    expect(d.message).toContain("/views/postsList/spec/select/0");
    expect(d.message).toContain("expected a field declared on the source Schema");
    expect(d.message).toContain('got "tilte"');
    expect(d.message).toContain("did you mean title?");
  });

  it("preserves caller-supplied message when provided", () => {
    const d = makeDiagnostic({
      code: "INTERNAL_ERROR",
      phase: "runtime",
      severity: "error",
      path: "/",
      message: "something went sideways",
    });
    expect(d.message).toBe("something went sideways");
  });
});

describe("httpStatusFor", () => {
  it("maps known runtime codes to their HTTP status", () => {
    expect(httpStatusFor(stub("INPUT_VALIDATION_FAILED"))).toBe(400);
    expect(httpStatusFor(stub("INVALID_LOCALE"))).toBe(400);
    expect(httpStatusFor(stub("UNAUTHENTICATED"))).toBe(401);
    expect(httpStatusFor(stub("AUTH_DENIED"))).toBe(403);
    expect(httpStatusFor(stub("NOT_FOUND"))).toBe(404);
    expect(httpStatusFor(stub("METHOD_NOT_ALLOWED"))).toBe(405);
    expect(httpStatusFor(stub("CONFLICT"))).toBe(409);
    expect(httpStatusFor(stub("LIFECYCLE_HOOK_REJECTED"))).toBe(409);
    expect(httpStatusFor(stub("HANDLER_NOT_REGISTERED"))).toBe(500);
    expect(httpStatusFor(stub("INTERNAL_ERROR"))).toBe(500);
    expect(httpStatusFor(stub("OUTPUT_VALIDATION_FAILED"))).toBe(500);
    expect(httpStatusFor(stub("DISPATCHER_NOT_BUILT"))).toBe(501);
  });

  it("defaults to 500 for codes not in the map", () => {
    // DUPLICATE_NAME is a validate-only code; doesn't surface on the wire,
    // so the map omits it and httpStatusFor falls through to 500.
    expect(httpStatusFor(stub("DUPLICATE_NAME"))).toBe(500);
  });

  it("HTTP_STATUS_BY_CODE is exposed for inspection", () => {
    expect(HTTP_STATUS_BY_CODE.NOT_FOUND).toBe(404);
    expect(HTTP_STATUS_BY_CODE.UNAUTHENTICATED).toBe(401);
  });
});

describe("DiagnosticError", () => {
  it("carries a single diagnostic", () => {
    const d = runtimeDiagnostic({
      code: "INPUT_VALIDATION_FAILED",
      severity: "error",
      path: "/body/email",
    });
    const err = new DiagnosticError(d);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DiagnosticError");
    expect(err.diagnostic).toBe(d);
    expect(err.diagnostics).toEqual([d]);
    expect(err.message).toBe(d.message);
  });

  it("carries an array of diagnostics", () => {
    const a = validateDiagnostic({ code: "DUPLICATE_NAME", severity: "error", path: "/a" });
    const b = validateDiagnostic({ code: "VIEW_FROM_UNKNOWN_SCHEMA", severity: "error", path: "/b" });
    const err = new DiagnosticError([a, b]);
    expect(err.diagnostics).toEqual([a, b]);
    expect(err.diagnostic).toBe(a);
    // The Error.message echoes the head diagnostic.
    expect(err.message).toBe(a.message);
  });
});

describe("redactForWire", () => {
  it("strips candidates field", () => {
    const d = validateDiagnostic({
      code: "VIEW_FIELD_NOT_IN_SCHEMA",
      severity: "error",
      path: "/views/posts/spec/select/0",
      value: "tilte",
      candidates: ["title", "subtitle", "slug"],
      suggestion: "title",
    });
    const wire = redactForWire(d);
    expect("candidates" in wire).toBe(false);
    expect(wire.suggestion).toBe("title");
    expect(wire.value).toBe("tilte");
  });

  it("returns input unchanged when candidates absent", () => {
    const d = runtimeDiagnostic({
      code: "NOT_FOUND",
      severity: "error",
      path: "/entries/missing",
    });
    expect(redactForWire(d)).toBe(d);
  });
});

describe("readJsonPointer", () => {
  const root = { a: { b: [{ c: 42 }] }, "with/slash": "v" };
  it("returns the root for empty pointer or '/'", () => {
    expect(readJsonPointer(root, "")).toBe(root);
    expect(readJsonPointer(root, "/")).toBe(root);
  });

  it("walks nested objects and arrays", () => {
    expect(readJsonPointer(root, "/a/b/0/c")).toBe(42);
  });

  it("returns undefined on misses", () => {
    expect(readJsonPointer(root, "/a/missing")).toBeUndefined();
    expect(readJsonPointer(root, "/a/b/99")).toBeUndefined();
  });

  it("unescapes ~1 and ~0", () => {
    expect(readJsonPointer(root, "/with~1slash")).toBe("v");
  });
});

function stub(code: Diagnostic["code"]): Diagnostic {
  return runtimeDiagnostic({ code, severity: "error", path: "/" });
}
