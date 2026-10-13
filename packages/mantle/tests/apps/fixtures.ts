import type { Caller } from "../../src/kernel/contracts.js";
/** Public synthetic data only. The two owners expose accidental scope leaks. */
export const owners = ["purchase-owner-a", "purchase-owner-b"] as const;
export const fixtures = owners.flatMap((ownerId, owner) =>
  Array.from({ length: 120 }, (_, index) => ({
    ownerId,
    requestNumber: `REQ-${owner}-${String(index).padStart(4, "0")}`,
    title: `Purchase ${index}`,
    amount: index * 1.25,
    approved: index % 3 === 0,
    requestedUnits: index === 0 ? Number.MAX_SAFE_INTEGER : index + 1,
    submittedAt: "2026-10-11T00:00:00.123456Z",
    neededOn: "2026-10-12",
    payload: { purpose: `fixture-${index}`, nested: { optional: null } },
    sortBucket: index % 4 === 0 ? null : `bucket-${index % 3}`,
  })),
);


/** A signed-in user with no role or scopes: the Caller of every scenario. */
export const user = (subject: string): Caller => ({ kind: "user", subject, role: null, scopes: [], credential: "session", credentialId: null, clientId: null });
