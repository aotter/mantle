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

/** Expected business projection, independent of emitted SQL/binds/decoders. */
export function expectedPurchases(ownerId: string) {
  return fixtures.filter(row => row.ownerId === ownerId).map(({ ownerId: _owner, ...row }) => row);
}

export function expectedTotals(ownerId: string) {
  const rows = expectedPurchases(ownerId);
  return { requestCount: rows.length, totalAmount: rows.reduce((total, row) => total + row.amount, 0) };
}
