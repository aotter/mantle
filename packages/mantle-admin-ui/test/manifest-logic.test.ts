import { describe, expect, it } from "vitest";
import { logicNeighborhood } from "../src/features/logic/manifest-logic-view";

describe("logicNeighborhood", () => {
  it("keeps the selected atom and only its direct declared relations", () => {
    const neighborhood = logicNeighborhood({
      fingerprint: "test",
      nodes: [
        { id: "Trigger:start", kind: "Trigger", name: "start", detail: "POST /start" },
        { id: "Procedure:run", kind: "Procedure", name: "run", detail: "code handler" },
        { id: "Schema:jobs", kind: "Schema", name: "jobs", detail: "managed data" },
        { id: "View:jobs", kind: "View", name: "jobs", detail: "staff declarative view" },
      ],
      edges: [
        { id: "invoke", from: "Trigger:start", to: "Procedure:run", label: "invokes" },
        { id: "write", from: "Procedure:run", to: "Schema:jobs", label: "writes" },
        { id: "read", from: "Schema:jobs", to: "View:jobs", label: "reads" },
      ],
    }, "Procedure:run");

    expect(neighborhood.selected?.name).toBe("run");
    expect(neighborhood.incoming.map(({ node }) => node.id)).toEqual(["Trigger:start"]);
    expect(neighborhood.outgoing.map(({ node }) => node.id)).toEqual(["Schema:jobs"]);
  });
});
