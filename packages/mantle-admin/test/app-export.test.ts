import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const pkg = resolve(import.meta.dirname, "..");

describe("@aotter/mantle-admin/app", () => {
  it("publishes defineAdmin and MantleAdmin from the built library", async () => {
    const target = JSON.parse(readFileSync(resolve(pkg, "package.json"), "utf8")).exports["./app"];
    expect(target).toEqual({ types: "./dist/admin-app/index.d.ts", import: "./dist/admin-app/index.js" });
    const app = await import(resolve(pkg, target.import));
    expect(Object.keys(app).sort()).toEqual(["MantleAdmin", "defineAdmin"]);
    expect(app.defineAdmin({})).toEqual({ meta: {} });
  });

  it("types resolve for a NodeNext consumer", () => {
    const consumer = resolve(pkg, "test/__app-consumer.ts");
    const source = [
      'import { defineAdmin, MantleAdmin, type AdminDefinition, type MantleAdminProps } from "@aotter/mantle-admin/app";',
      "const admin: AdminDefinition = defineAdmin({});",
      "const props: MantleAdminProps = { admin };",
      "// @ts-expect-error preview mode is internal to the canonical preview document",
      "export const preview: MantleAdminProps = { admin, preview: true };",
      "export const root = MantleAdmin(props);",
      "// @ts-expect-error metadata is required",
      "defineAdmin();",
    ].join("\n");
    const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, strict: true, noEmit: true, skipLibCheck: false, types: [] };
    const host = ts.createCompilerHost(options);
    const { getSourceFile, fileExists, readFile } = host;
    host.fileExists = file => file === consumer || fileExists(file);
    host.readFile = file => file === consumer ? source : readFile(file);
    host.getSourceFile = (file, language) => file === consumer ? ts.createSourceFile(file, source, language) : getSourceFile(file, language);
    const program = ts.createProgram([consumer], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(diagnostics).toEqual([]);
  });
});
