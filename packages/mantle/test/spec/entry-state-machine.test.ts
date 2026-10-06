import { describe, expect, it } from "vitest";
import { ContentState, IllegalTransitionError } from "../../src/spec/domain/model/index.js";
import {
  canTransition,
  decideLifecycleWrite,
  isPublishing,
  type LifecycleSchemaLike,
  resolveLifecycle,
} from "../../src/spec/domain/service/LifecycleStateMachine.js";

const defaultPublishingSchema: LifecycleSchemaLike = { spec: {} };
const explicitPublishingSchema: LifecycleSchemaLike = { spec: { lifecycle: "publishing" } };
const operationalSchema: LifecycleSchemaLike = { spec: { lifecycle: "operational" } };

describe("ContentState const-object", () => {
  it("exports the documented status values", () => {
    expect(ContentState.Draft).toBe("draft");
    expect(ContentState.Published).toBe("published");
    expect(ContentState.Archived).toBe("archived");
  });
});

describe("resolveLifecycle", () => {
  it("returns 'publishing' when Schema omits the lifecycle key", () => {
    expect(resolveLifecycle(defaultPublishingSchema)).toBe("publishing");
  });

  it("returns 'publishing' for an undefined Schema (defense-in-depth)", () => {
    expect(resolveLifecycle(undefined)).toBe("publishing");
  });

  it("returns the explicit value when set", () => {
    expect(resolveLifecycle(explicitPublishingSchema)).toBe("publishing");
    expect(resolveLifecycle(operationalSchema)).toBe("operational");
  });
});

describe("canTransition — operational lifecycle (operational records)", () => {
  it("allows no transitions from any state", () => {
    const states = ["draft", "published", "archived"] as const;
    for (const from of states) {
      for (const to of states) {
        expect(canTransition(operationalSchema, from, to)).toBe(false);
      }
    }
  });

});

describe("canTransition — publishing lifecycle", () => {
  it("allows draft → published and draft → archived", () => {
    expect(canTransition(defaultPublishingSchema, "draft", "published")).toBe(true);
    expect(canTransition(defaultPublishingSchema, "draft", "archived")).toBe(true);
  });

  it("allows published → archived and published → draft (unpublish)", () => {
    expect(canTransition(defaultPublishingSchema, "published", "archived")).toBe(true);
    expect(canTransition(defaultPublishingSchema, "published", "draft")).toBe(true);
  });

  it("allows archived → draft (restore)", () => {
    expect(canTransition(defaultPublishingSchema, "archived", "draft")).toBe(true);
  });

  it("rejects archived → published directly (must restore first)", () => {
    expect(canTransition(defaultPublishingSchema, "archived", "published")).toBe(false);
  });

  it("treats undefined schema as publishing", () => {
    expect(canTransition(undefined, "draft", "published")).toBe(true);
  });
});

describe("IllegalTransitionError", () => {
  it("carries from / to and a readable message", () => {
    const err = new IllegalTransitionError("draft", "published");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("IllegalTransitionError");
    expect(err.from).toBe("draft");
    expect(err.to).toBe("published");
    expect(err.message).toContain("draft");
    expect(err.message).toContain("published");
  });
});

// Ported from packages/mantle-runtime/test/content-ops.test.ts so the rules
// outlive the content use cases they were first written against (ADR-0032).
describe("decideLifecycleWrite", () => {
  const translationSchema: LifecycleSchemaLike = { spec: { translates: { parent: "posts", on: "slug" } } };
  const denied = (reason: string) => ({ allowed: false, reason });

  it("creates publishing entries as partial drafts and operational records as complete, live rows", () => {
    expect(decideLifecycleWrite(defaultPublishingSchema, { op: "insert" }))
      .toEqual({ allowed: true, status: "draft", validate: "partial", publishedParent: false });
    expect(decideLifecycleWrite(operationalSchema, { op: "insert" }))
      .toEqual({ allowed: true, status: "published", validate: "full", publishedParent: false });
  });

  it("edits drafts partially and refuses to edit published or archived publishing entries", () => {
    expect(decideLifecycleWrite(defaultPublishingSchema, { op: "update", from: "draft", data: true }))
      .toEqual({ allowed: true, status: "draft", validate: "partial", publishedParent: false });
    for (const from of ["published", "archived"] as const) {
      expect(decideLifecycleWrite(defaultPublishingSchema, { op: "update", from, data: true })).toEqual(denied("not-editable"));
    }
  });

  it("edits operational records in place with full validation", () => {
    expect(decideLifecycleWrite(operationalSchema, { op: "update", from: "published", data: true }))
      .toEqual({ allowed: true, status: "published", validate: "full", publishedParent: false });
  });

  it("publishes a draft with full validation and asks for a published parent only on translations", () => {
    expect(decideLifecycleWrite(defaultPublishingSchema, { op: "update", from: "draft", to: "published", data: false }))
      .toEqual({ allowed: true, status: "published", validate: "full", publishedParent: false });
    expect(decideLifecycleWrite(translationSchema, { op: "update", from: "draft", to: "published", data: false }))
      .toEqual({ allowed: true, status: "published", validate: "full", publishedParent: true });
  });

  it("refuses transitions the lifecycle does not allow, including a same-state request", () => {
    expect(decideLifecycleWrite(defaultPublishingSchema, { op: "update", from: "published", to: "published", data: false })).toEqual(denied("transition"));
    expect(decideLifecycleWrite(defaultPublishingSchema, { op: "update", from: "draft", to: "draft", data: false })).toEqual(denied("transition"));
    for (const to of ["published", "draft", "archived"] as const) {
      expect(decideLifecycleWrite(operationalSchema, { op: "update", from: "published", to, data: false })).toEqual(denied("transition"));
    }
  });

  it("unpublishes, archives and restores without validating data", () => {
    const moves = [["published", "draft"], ["draft", "archived"], ["published", "archived"], ["archived", "draft"]] as const;
    for (const [from, to] of moves) {
      expect(decideLifecycleWrite(defaultPublishingSchema, { op: "update", from, to, data: false }))
        .toEqual({ allowed: true, status: to, validate: "none", publishedParent: false });
    }
  });

  it("checks the transition before editability when both are requested", () => {
    expect(decideLifecycleWrite(defaultPublishingSchema, { op: "update", from: "draft", to: "published", data: true }))
      .toEqual({ allowed: true, status: "published", validate: "full", publishedParent: false });
    expect(decideLifecycleWrite(defaultPublishingSchema, { op: "update", from: "published", to: "draft", data: true })).toEqual(denied("not-editable"));
  });

  it("protects published publishing entries from delete but not drafts or operational records", () => {
    expect(decideLifecycleWrite(defaultPublishingSchema, { op: "delete", from: "published" })).toEqual(denied("published-protected"));
    expect(decideLifecycleWrite(defaultPublishingSchema, { op: "delete", from: "draft" }).allowed).toBe(true);
    expect(decideLifecycleWrite(defaultPublishingSchema, { op: "delete", from: "archived" }).allowed).toBe(true);
    expect(decideLifecycleWrite(operationalSchema, { op: "delete", from: "published" }).allowed).toBe(true);
  });

  it("treats a missing Schema as publishing", () => {
    expect(isPublishing(undefined)).toBe(true);
    expect(isPublishing(operationalSchema)).toBe(false);
    expect(decideLifecycleWrite(undefined, { op: "delete", from: "published" })).toEqual(denied("published-protected"));
  });
});
