/**
 * Classify every difference between two Admin request matrices into the behaviour changes Admin accepted when it moved
 * onto the request pipeline (#1971), and fail on any other. Usage, from packages/mantle-admin:
 *
 *   git show 13448146:packages/mantle-admin/tests/native/admin-request-matrix.golden.txt > /tmp/old.txt
 *   bun tests/native/admin-request-matrix-classify.ts /tmp/old.txt tests/native/admin-request-matrix.golden.txt
 *
 * A: an unmatched path (and the bare base) is 404 NOT_FOUND for every caller, before caller resolution.
 * B: a method mismatch on an existing route is 405 METHOD_NOT_ALLOWED with `allow`, before caller resolution.
 * C: a malformed path is 400 INPUT_VALIDATION_FAILED, before caller resolution.
 *    For A-C the envelope `path`/`target` and the access event's target name the router (`rest`, `rest:<METHOD> <path>`).
 * D: a forwarded host session's read, refused by the Origin rule before, passes it now (then answers as authorize does).
 * D2: the same for a caller that is not a forwarded host (reported; none is expected).
 * E: within a matched route, one refusal became another (patterns listed).
 * N: a cell that is new (no counterpart in the old matrix).
 */
import { readFileSync } from "node:fs";

interface Cell {
  readonly key: string;
  readonly route: string;
  readonly caller: string;
  readonly gateway: boolean;
  readonly outcome: string;
  readonly counts: string;
  readonly event: string;
}
const parse = (file: string): Map<string, Cell> => {
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  const cells = new Map<string, Cell>();
  for (let i = 0; i < lines.length; i += 4) {
    const key = lines[i]!;
    cells.set(key, {
      key,
      route: /route=(\S+)/.exec(key)![1]!,
      caller: /caller=(\S+)/.exec(key)![1]!,
      gateway: key.startsWith("gateway=on"),
      outcome: lines[i + 1]!.trim(),
      counts: lines[i + 2]!.trim(),
      event: lines[i + 3]!.trim(),
    });
  }
  return cells;
};
const status = (cell: Cell) => Number(cell.outcome.split(" ")[0]);
const code = (cell: Cell) => /code=(\S+)/.exec(cell.outcome)?.[1];
const where = (cell: Cell) => /(?:path|target)=([^\s}]+)/.exec(cell.outcome)?.[1];
const untouched = (cell: Cell) => /^db=0 resolver=0 authorize=\[\]$/.test(cell.counts);
const host = (cell: Cell) => cell.gateway && cell.caller !== "no-props";
/** Before routing: no caller resolution, no database, no authorize; the router's envelope and event target. */
const routerRefusal = (cell: Cell, expected: number, expectedCode: string) =>
  status(cell) === expected &&
  code(cell) === expectedCode &&
  where(cell) === "rest" &&
  untouched(cell) &&
  (cell.event === "event=none" || / ?@rest:[A-Z]+ \/admin\/api/.test(cell.event));
const READS = new Set(["collection-list", "entry-read", "view-read", "operation-read-only", "me"]);
const PINNED = ["TARGET_HASH_MISMATCH", "STALE_CALLER", "minimumRole"];

const [oldFile, newFile] = process.argv.slice(2);
if (!oldFile || !newFile) throw new Error("usage: admin-request-matrix-classify.ts <old golden> <new golden>");
const before = parse(oldFile),
  after = parse(newFile);
const classes = new Map<string, Cell[]>();
const patterns = new Map<string, number>();
const unclassified: string[] = [];
const add = (name: string, cell: Cell) => classes.set(name, [...(classes.get(name) ?? []), cell]);

for (const key of before.keys()) if (!after.has(key)) unclassified.push(`removed: ${key}`);
for (const [key, cell] of after) {
  // Invariants every cell keeps: a host caller never sees 401 or a challenge, and no cell carries CORS headers.
  if (host(cell) && (status(cell) === 401 || cell.outcome.includes("www-authenticate")))
    unclassified.push(`host 401/challenge: ${key}`);
  if (cell.outcome.includes("access-control-")) unclassified.push(`CORS header: ${key}`);
  const old = before.get(key);
  if (!old) {
    add("N", cell);
    continue;
  }
  if (old.outcome === cell.outcome && old.counts === cell.counts && old.event === cell.event) continue;
  const route = cell.route;
  if (["unmatched-read", "unmatched-write", "base"].includes(route) && routerRefusal(cell, 404, "NOT_FOUND"))
    add("A", cell);
  else if (route === "method-mismatch" && routerRefusal(cell, 405, "METHOD_NOT_ALLOWED") && /allow=/.test(cell.outcome))
    add("B", cell);
  else if (route.startsWith("malformed-") && routerRefusal(cell, 400, "INPUT_VALIDATION_FAILED")) add("C", cell);
  else if (
    READS.has(route) &&
    status(old) === 403 &&
    where(old) === "request:origin" &&
    where(cell) !== "request:origin" &&
    (status(cell) < 400 || code(cell) === "AUTH_DENIED")
  )
    add(host(cell) && cell.caller.endsWith("-session") ? "D" : "D2", cell);
  else if (
    status(old) >= 400 &&
    status(cell) >= 400 &&
    !PINNED.some(pinned => old.outcome.includes(pinned) || cell.outcome.includes(pinned))
  ) {
    add("E", cell);
    const pattern = `${route}: ${code(old)} ${where(old)} -> ${code(cell)} ${where(cell)}`;
    patterns.set(pattern, (patterns.get(pattern) ?? 0) + 1);
  } else unclassified.push(`unclassified: ${key}\n  was ${old.outcome}\n  now ${cell.outcome}`);
}

for (const name of ["A", "B", "C", "D", "D2", "E", "N"]) {
  const cells = classes.get(name) ?? [];
  console.log(`${name}: ${cells.length}`);
  for (const cell of cells.slice(0, 2))
    console.log(`  ${cell.key}\n    was ${before.get(cell.key)?.outcome ?? "(new)"}\n    now ${cell.outcome}`);
}
for (const [pattern, count] of patterns) console.log(`  E ${count} x ${pattern}`);
if (unclassified.length) {
  console.error(unclassified.join("\n"));
  process.exit(1);
}
console.log(`changed ${[...classes].filter(([n]) => n !== "N").reduce((n, [, c]) => n + c.length, 0)}, all classified`);
