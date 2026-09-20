import { describe, expect, it } from "vitest";
import { compilePathMatcher, matchPath } from "../src/domain/service/PathMatcher.js";

describe("matchPath", () => {
  it("matches identical paths", () => {
    expect(matchPath("/api/contact", "/api/contact")).toEqual({});
  });

  it("extracts {param} segments", () => {
    expect(matchPath("/api/posts/{id}", "/api/posts/abc")).toEqual({ id: "abc" });
  });

  it("returns null on segment-count mismatch", () => {
    expect(matchPath("/api/posts/{id}", "/api/posts")).toBeNull();
    expect(matchPath("/api/posts", "/api/posts/abc")).toBeNull();
  });

  it("returns null on literal-segment mismatch", () => {
    expect(matchPath("/api/posts", "/api/users")).toBeNull();
  });

  it("decodes URL-encoded param values", () => {
    expect(matchPath("/api/posts/{id}", "/api/posts/a%20b")).toEqual({ id: "a b" });
  });

  it("normalizes trailing slash on either side", () => {
    expect(matchPath("/api/posts", "/api/posts/")).toEqual({});
    expect(matchPath("/api/posts/", "/api/posts")).toEqual({});
    expect(matchPath("/api/posts/{id}", "/api/posts/abc/")).toEqual({ id: "abc" });
  });

  it("preserves root '/' (not stripped to empty)", () => {
    expect(matchPath("/", "/")).toEqual({});
  });

  it("returns null on malformed percent-encoding instead of throwing", () => {
    expect(matchPath("/api/posts/{id}", "/api/posts/%GG")).toBeNull();
  });

  it("reuses a compiled Trigger path without changing decoding behavior", () => {
    const match = compilePathMatcher("/api/posts/{id}");
    expect(match("/api/posts/a%20b")).toEqual({ id: "a b" });
    expect(match("/api/posts/%GG")).toBeNull();
  });

  it("decodes literal segments so `/by%2Dtag` matches trigger `/by-tag`", () => {
    expect(matchPath("/api/by-tag", "/api/by%2Dtag")).toEqual({});
  });
});
