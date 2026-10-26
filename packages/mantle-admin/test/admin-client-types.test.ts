import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const pkg = resolve(import.meta.dirname, "..");
const manifest = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: tasks}
spec:
 title: Tasks
 lifecycle: operational
 schema:
  type: object
  required: [title]
  properties:
   title: {type: string}
   note: {type: string}
   priority: {type: string, enum: [low, high]}
   due: {type: string, format: date-time}
   label: {type: [string, "null"]}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: posts}
spec:
 title: Posts
 lifecycle: publishing
 schema: {type: object, required: [title], properties: {title: {type: string}}}
`;

// #1788: a field the Schema does not require reads null when unset and the entry PATCH clears it with null, so the
// generated `data` types it `T | null` and an application's `input:` component can clear it without a cast. A publishing
// collection's draft may lack a required field too (Publish refuses it), so there every field is `T | null`.
describe("generated admin-client.ts", () => {
  it("lets an input: component clear an optional field with onChange(null), and not a required one", async () => {
    const { generateFromSources } = await import("@aotter/mantle/generate");
    const result = await generateFromSources({ target: "bun-sqlite", admin: true, sources: { sources: [{ sourceId: "tasks.yaml", text: manifest }] } });
    if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
    const client = result.files["admin-client.ts"]!;
    expect(client).toContain('readonly "title": string; readonly "note"?: string | null; readonly "priority"?: "low" | "high" | null; readonly "due"?: string | null; readonly "label"?: string | null;');
    expect(client).toContain('readonly "posts": { readonly data: { readonly "title"?: string | null;  } }');
    // inside the package, so `@aotter/mantle-admin/*` resolves to its own built types as an application's would
    const dir = mkdtempSync(join(pkg, "test/.admin-client-types-"));
    try {
      writeFileSync(join(dir, "admin-client.ts"), client);
      const consumer = join(dir, "admin.ts");
      writeFileSync(consumer, [
        'import { defineAdmin, type AdminDefinition } from "@aotter/mantle-admin/app";',
        'import { admin, useEntry, type AppAdminTypes } from "./admin-client.js";',
        "export const cleared: AdminDefinition = defineAdmin(admin, { components: {",
        '  "input:tasks.note": ({ onChange }) => { onChange(null); return null; },',
        '  "input:tasks.priority": ({ value, onChange }) => { onChange(value === null ? "low" : null); return null; },',
        '  "input:tasks.due": ({ value, onChange }) => { onChange(value ? null : new Date(0).toISOString()); return null; },',
        "} });",
        "export function Note(): string {",
        '  const { entry } = useEntry("tasks", "t1");',
        "  // an unset field reads null",
        '  return entry?.data.note ?? "";',
        "}",
        "// a draft lacking a required field reads null, and a draft's required field clears like any other",
        'export const draft: AdminDefinition = defineAdmin(admin, { components: { "input:posts.title": ({ onChange }) => { onChange(null); return null; } } });',
        'export function Title(): string { const { entry } = useEntry("posts", "p1"); return entry?.data.title ?? ""; }',
        "// @ts-expect-error a draft's required field may read null",
        'export const title: string | undefined = (null as unknown as AppAdminTypes["collections"]["posts"]["data"]).title;',
        "// @ts-expect-error a required field is not cleared",
        'defineAdmin(admin, { components: { "input:tasks.title": ({ onChange }) => { onChange(null); return null; } } });',
        "// @ts-expect-error a value the field cannot hold",
        'defineAdmin(admin, { components: { "input:tasks.priority": ({ onChange }) => { onChange("urgent"); return null; } } });',
      ].join("\n"));
      const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, strict: true, noEmit: true, skipLibCheck: true, types: [] };
      const program = ts.createProgram([consumer], options);
      expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
