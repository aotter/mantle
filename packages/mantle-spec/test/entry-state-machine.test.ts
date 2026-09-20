import { describe, expect, it } from "vitest";
import { ContentState, IllegalTransitionError } from "../src/domain/model/index.js";
import {
  canTransition,
  type LifecycleSchemaLike,
  resolveLifecycle,
} from "../src/domain/service/LifecycleStateMachine.js";

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
