import { describe, expect, it } from "vitest";
import { createReaderSet, dbFor, readerOf } from "../../src/core/store/readers.js";
import { RESERVED_READER_NAMES, readerName, readerNameProblems } from "../../src/spec/domain/index.js";

describe("readerName (ADR-0043 decision 2)", () => {
  it("projects the ASCII words of a name to lower camel", () => {
    expect(["organization_members", "ticket-events", "Posts", "BlogPost", "items", "A_b-C d"].map(readerName)).toEqual(["organizationMembers", "ticketEvents", "posts", "blogPost", "items", "aBCD"]);
  });
  it("keeps the plan key verbatim when the projection is empty or not an identifier, so no valid app is refused", () => {
    expect(["組織成員", "2fa", "---", "Ünï"].map(readerName)).toEqual(["組織成員", "2fa", "---", "ünï"]);
  });
  it("reports reserved names and collisions, and leaves case-only differences to the case-collision check", () => {
    expect(readerNameProblems(["then", "constructor", "a", "b"]).map((p) => p.name)).toEqual(["then", "constructor"]);
    expect(readerNameProblems(["order_lines", "orderLines"]).map((p) => p.name)).toEqual(["orderLines"]);
    expect(readerNameProblems(["notes", "Notes"])).toEqual([]);
    expect(RESERVED_READER_NAMES).toContain("__proto__");
  });
  it("a Schema with a non-identifier reader name is read by bracket and by readerOf", () => {
    const set = createReaderSet({ "組織成員": { name: "組織成員", fields: {} }, items: { name: "items", fields: {} } } as never);
    const db = dbFor(set, (() => Promise.resolve({ rows: [] })) as never);
    expect(db["組織成員"]).toBeDefined();
    expect(readerOf(db, "組織成員")).toBe(db["組織成員"]);
  });
});
