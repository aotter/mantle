import { describe, expect, it } from "vitest";

import { readDeveloperSnapshotMessage } from "../src/lib/developer-snapshot-preview";

const snapshot = {
  dataModel: { schemas: [], views: [] },
  logic: { triggers: [], procedures: [] },
  interfaces: { http: [], callable: [] },
  graph: { atoms: [], relations: [] },
};

describe("developer snapshot preview", () => {
  it("accepts only versioned developer-console snapshots", () => {
    expect(readDeveloperSnapshotMessage({
      protocolVersion: 1,
      type: "mantle:admin-preview:snapshot",
      revision: 2,
      snapshot,
    })).toEqual({ revision: 2, snapshot });
    expect(readDeveloperSnapshotMessage({ type: "mantle:admin-preview:snapshot", revision: 2, snapshot })).toBeNull();
    expect(readDeveloperSnapshotMessage({ protocolVersion: 1, type: "mantle:admin-preview:snapshot", revision: 0, snapshot })).toBeNull();
  });
});
