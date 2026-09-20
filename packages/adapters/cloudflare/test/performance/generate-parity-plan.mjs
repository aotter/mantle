import { writeFile } from "node:fs/promises";
import { parseManifestSources, linkManifestSet } from "@aotter/mantle-spec";
import { compileRuntimePlan } from "@aotter/mantle-runtime";
const count = (key, fallback) => Math.min(1000, Math.max(1, Number(process.env[key]) || fallback));
const routes = count("BENCH_ROUTES", 1), schemas = count("BENCH_SCHEMAS", 1), views = count("BENCH_VIEWS", 1);
const atom = (kind, name, spec) => ({ apiVersion: "cms.mantle.aotter.net/v1", kind, metadata: { name }, spec });
const manifests = [
  ...Array.from({ length: schemas }, (_, i) => atom("Schema", i ? `extra-${i}` : "items", {
    title: "Items", localized: true, lifecycle: "publishing",
    schema: { type: "object", properties: { slug: { type: "string" }, locale: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["slug", "title"] },
    // Keep the physical index count fixed while varying Schema registry size.
    ...(i === 0 ? { uniqueIndexes: [["slug", "locale"]] } : {}),
  })),
  ...Array.from({ length: views }, (_, i) => atom("View", `items-${i}`, {
    surface: "public", from: "items", filter: { eq: { field: "status", value: "published" } },
    fields: ["id", "slug", "title", "body", "updatedAt"], orderBy: [{ field: "updatedAt", direction: "desc" }], limit: 20,
    params: { type: "object", additionalProperties: false, properties: {} },
  })),
  atom("Procedure", "lookup", { input: { type: "object", additionalProperties: false, properties: { id: { type: "string" } }, required: ["id"] }, output: { type: "object" }, handler: { kind: "ref", ref: "lookup" } }),
  ...Array.from({ length: routes }, (_, i) => atom("Trigger", `lookup-${i}`, { source: { kind: "http", method: "POST", path: `/api/lookup-${String(i).padStart(4, "0")}` }, target: { procedure: "lookup" } })),
];
const parsed = parseManifestSources({ sources: [{ sourceId: "benchmark:812", text: manifests.map((m) => JSON.stringify(m)).join("\n---\n") }] });
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
const linked = linkManifestSet(parsed.value);
if (!linked.ok) throw new Error(JSON.stringify(linked.diagnostics));
const compiled = compileRuntimePlan(linked.value);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
await writeFile(new URL("./parity-plan.generated.json", import.meta.url), JSON.stringify(compiled.value));
process.stdout.write(JSON.stringify({ routes, schemas, views, fingerprint: compiled.value.semanticFingerprint }) + "\n");
