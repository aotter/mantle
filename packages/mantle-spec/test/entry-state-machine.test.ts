import { describe, expect, it } from "vitest";
import { ContentState, IllegalTransitionError } from "../src/domain/model/index.js";
import {
  canTransition,
  type LifecycleSchemaLike,
  publishRequiresApproval,
  resolveLifecycle,
} from "../src/domain/service/LifecycleStateMachine.js";

const defaultPublishingSchema: LifecycleSchemaLike = { spec: {} };
const explicitPublishingSchema: LifecycleSchemaLike = { spec: { lifecycle: "publishing" } };
const editorialSchema: LifecycleSchemaLike = { spec: { lifecycle: "editorial" } };
const operationalSchema: LifecycleSchemaLike = { spec: { lifecycle: "operational" } };

describe("ContentState const-object", () => {
  it("exports the documented status values", () => {
    expect(ContentState.Draft).toBe("draft");
    expect(ContentState.Review).toBe("review");
    expect(ContentState.Approved).toBe("approved");
    expect(ContentState.Scheduled).toBe("scheduled");
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
    expect(resolveLifecycle(editorialSchema)).toBe("editorial");
    expect(resolveLifecycle(explicitPublishingSchema)).toBe("publishing");
  });
});

describe("publishRequiresApproval", () => {
  it("returns true only for editorial Schemas", () => {
    expect(publishRequiresApproval(editorialSchema)).toBe(true);
    expect(publishRequiresApproval(defaultPublishingSchema)).toBe(false);
    expect(publishRequiresApproval(explicitPublishingSchema)).toBe(false);
    expect(publishRequiresApproval(undefined)).toBe(false);
  });
});

describe("canTransition — operational lifecycle (operational records)", () => {
  it("allows no transitions from any state", () => {
    const states = ["draft", "review", "approved", "scheduled", "published", "archived"] as const;
    for (const from of states) {
      for (const to of states) {
        expect(canTransition(operationalSchema, from, to)).toBe(false);
      }
    }
  });

  it("does not require approval to publish (publish simply never applies)", () => {
    expect(publishRequiresApproval(operationalSchema)).toBe(false);
  });
});

describe("canTransition — publishing lifecycle", () => {
  it("allows draft → published and draft → archived", () => {
    expect(canTransition(defaultPublishingSchema, "draft", "published")).toBe(true);
    expect(canTransition(defaultPublishingSchema, "draft", "archived")).toBe(true);
  });

  it("rejects draft → review (no review state in publishing)", () => {
    expect(canTransition(defaultPublishingSchema, "draft", "review")).toBe(false);
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

  it("rejects review/approved/scheduled as source — they don't exist in publishing", () => {
    expect(canTransition(defaultPublishingSchema, "review", "published")).toBe(false);
    expect(canTransition(defaultPublishingSchema, "approved", "published")).toBe(false);
    expect(canTransition(defaultPublishingSchema, "scheduled", "published")).toBe(false);
  });

  it("treats undefined schema as publishing", () => {
    expect(canTransition(undefined, "draft", "published")).toBe(true);
    expect(canTransition(undefined, "draft", "review")).toBe(false);
  });
});

describe("canTransition — editorial lifecycle", () => {
  it("allows every transition in the documented EDITORIAL_TRANSITIONS table", () => {
    // Six-state machine: draft / review / approved / scheduled / published / archived.
    // 11 allowed transitions per the JSDoc on canTransition.
    expect(canTransition(editorialSchema, "draft", "review")).toBe(true);
    expect(canTransition(editorialSchema, "draft", "archived")).toBe(true);
    expect(canTransition(editorialSchema, "review", "approved")).toBe(true);
    expect(canTransition(editorialSchema, "review", "draft")).toBe(true);
    expect(canTransition(editorialSchema, "approved", "scheduled")).toBe(true);
    expect(canTransition(editorialSchema, "approved", "published")).toBe(true);
    expect(canTransition(editorialSchema, "scheduled", "published")).toBe(true);
    expect(canTransition(editorialSchema, "scheduled", "draft")).toBe(true);
    expect(canTransition(editorialSchema, "published", "archived")).toBe(true);
    expect(canTransition(editorialSchema, "published", "draft")).toBe(true);
    expect(canTransition(editorialSchema, "archived", "draft")).toBe(true);
  });

  it("rejects draft → published directly (must go through review)", () => {
    expect(canTransition(editorialSchema, "draft", "published")).toBe(false);
  });

  it("rejects backward jumps that aren't on the table", () => {
    expect(canTransition(editorialSchema, "approved", "review")).toBe(false);
    expect(canTransition(editorialSchema, "published", "review")).toBe(false);
    expect(canTransition(editorialSchema, "archived", "review")).toBe(false);
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
