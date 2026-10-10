import { expect, it } from "vitest";
import { pgPool, query, transaction, type PgClient } from "../../src/postgres/driver.js";
import { PgStoreExecutor } from "../../src/postgres/executor.js";

function client(fail?: (text: string) => unknown, pooled = true) {
  const sent: string[] = [], releases: (boolean | Error | undefined)[] = [];
  let ended = 0;
  const c = {
    query: async (q: string | { text: string }) => {
      const text = typeof q === "string" ? q : q.text;
      sent.push(text);
      const error = fail?.(text);
      if (error) throw error;
      return { rows: [], rowCount: 0, fields: [], command: text };
    },
    end: async () => { ended++; },
    ...(pooled ? { release: (e?: boolean | Error) => { releases.push(e); } } : {}),
  } as PgClient;
  return { c, sent, releases, get ended() { return ended; } };
}

it("uses a single native client sequentially; pooled release is not end and the native release is never replaced", async () => {
  const f = client();
  const originalRelease = f.c.release;
  expect(await pgPool(async () => f.c).connect()).toBe(f.c);
  expect(f.c.release).toBe(originalRelease);
  await transaction(async () => f.c, [{ text: "write1" }, { text: "write2" }]);
  expect(f.sent).toEqual([expect.stringMatching(/^BEGIN ISOLATION LEVEL SERIALIZABLE;/), "write1", "write2", "COMMIT"]);
  expect(f.releases).toEqual([false]);
  expect(f.ended).toBe(0);
  const standalone = client(undefined, false);
  await query(async () => standalone.c, { text: "SELECT 1" });
  expect(standalone.ended).toBe(1);
});

it.each(["23505", "40001", "40P01"])("rolls back native %s once and surfaces it without reacquiring/retrying", async (code) => {
  const original = Object.assign(new Error("native refusal"), { code });
  const f = client(text => text === "bad" ? original : undefined);
  let acquisitions = 0;
  await expect(transaction(async () => { acquisitions++; return f.c; }, [{ text: "good" }, { text: "bad" }, { text: "not reached" }])).rejects.toMatchObject({ code, statement: 1, committing: false });
  expect(acquisitions).toBe(1);
  expect(f.sent.at(-1)).toBe("ROLLBACK");
  expect(f.sent).not.toContain("COMMIT");
  expect(f.sent).not.toContain("not reached");
  expect(f.releases).toEqual([false]);
});

it("discards a client whose rollback fails, preserving the original statement error", async () => {
  const f = client(text => text === "bad" ? Object.assign(new Error("constraint"), { code: "23505" }) : text === "ROLLBACK" ? new Error("socket lost") : undefined);
  await expect(transaction(async () => f.c, [{ text: "bad" }])).rejects.toMatchObject({ code: "23505" });
  expect(f.releases).toEqual([true]);
});

it("an unanswered COMMIT remains unknown even if subsequent ROLLBACK replies; no retry and discard", async () => {
  const f = client(text => text === "COMMIT" ? new Error("commit response lost") : undefined);
  const executor = new PgStoreExecutor(async () => f.c, {}, new Map());
  await expect(executor.apply([])).rejects.toMatchObject({ diagnostic: { code: "OUTCOME_UNKNOWN" } });
  expect(f.sent.filter(x => x === "COMMIT")).toHaveLength(1);
  expect(f.sent.at(-1)).toBe("ROLLBACK");
  expect(f.releases).toEqual([true]);
});

it("a socket failure before COMMIT is unavailable, not an invented successful or uncertain commit", async () => {
  const f = client(text => text.startsWith("BEGIN") ? new Error("socket lost") : undefined);
  const executor = new PgStoreExecutor(async () => f.c, {}, new Map());
  await expect(executor.apply([])).rejects.toMatchObject({ diagnostic: { code: "RESOURCE_UNAVAILABLE" } });
  expect(f.sent).not.toContain("COMMIT");
  expect(f.releases).toEqual([true]);
});
