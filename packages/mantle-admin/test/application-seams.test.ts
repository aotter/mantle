/**
 * Required application seams of `@aotter/mantle-admin` (registry: packages/mantle/tests/application-seams.ts): each consumer
 * module is checked for public subpaths and no casts, typechecked against the built package, and executed unless the
 * registry marks it typecheck-only. They use no database.
 */
import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { SEAMS, type Seam } from "../../mantle/tests/application-seams.js";
import { consumerProblems } from "../../mantle/tests/application-seams-guard.js";

const REGISTRY = "packages/mantle/tests/application-seams.ts";
const root = resolve(import.meta.dirname, "../../..");
const admin = SEAMS.filter(seam => seam.package === "@aotter/mantle-admin");
const guard = (seams: readonly Seam[], problem: string) =>
  `${seams.map(seam => seam.id).join(", ")}: required application seam (registry: ${REGISTRY}). ${problem}\n` +
  'Removing, moving or narrowing a registered seam needs an ADR or ADR-lite and a migration note (CONTRIBUTING.md, "Application seams").';
const files = [...new Set(admin.map(seam => resolve(root, seam.check)))];
const seamsOf = (file: string) => admin.filter(seam => resolve(root, seam.check) === file);

it("every required Admin seam is an exported subpath with its named exports", async () => {
  const exportsMap = JSON.parse(await readFile(resolve(import.meta.dirname, "../package.json"), "utf8")).exports;
  for (const seam of admin) {
    const entry = seam.subpath && exportsMap[seam.subpath];
    if (!entry) throw new Error(guard([seam], `${seam.subpath} is no longer a subpath of ${seam.package}.`));
    const module = await import(pathToFileURL(resolve(import.meta.dirname, "..", entry.import ?? entry)).href);
    const missing = (seam.exports ?? []).filter(name => !(name in module));
    if (missing.length) throw new Error(guard([seam], `${seam.subpath} no longer exports ${missing.join(", ")}.`));
  }
});

const options: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  skipLibCheck: true,
  types: [],
};

it("each required Admin seam's consumer module imports public subpaths only, has no casts and typechecks", async () => {
  const failures = files.flatMap(file => {
    const problems = consumerProblems(file, options);
    return problems.length
      ? [guard(seamsOf(file), `Its consumer module is not public, cast-free code:\n${problems.join("\n")}`)]
      : [];
  });
  const program = ts.createProgram(files, options);
  failures.push(
    ...ts
      .getPreEmitDiagnostics(program)
      .map(d =>
        guard(
          seamsOf(d.file?.fileName ?? ""),
          `Its consumer module no longer typechecks: ${basename(d.file?.fileName ?? "")} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
        ),
      ),
  );
  expect(failures.join("\n\n")).toBe("");
}, 60_000);

it("the required Admin seams run", async () => {
  const runs = admin.filter(seam => seam.run !== false);
  try {
    const { app } = await import("./seams/admin-app-tools.js");
    expect(app.resources[0]!.renders).toContain("seam_tool");
    const { admin } = await import("./seams/page-renders.js");
    expect(admin.pages[0]!.mcp?.renders).toBe("seam_tool");
    const { card } = await import("./seams/upload-card.js");
    expect(card.resources[0]!.renders).toEqual(["upload_to_folder"]);
    const page = await (card.resources[0]!.html as (render: unknown) => Promise<{ html: string }>)({
      env: {},
      tools: new Set(),
    });
    expect(page.html).toContain('"tool":"upload_to_folder","forward":["folder"],"inputTimeoutMs":2000');
  } catch (error) {
    throw new Error(guard(runs, `Its consumer module no longer runs as required: ${error}`), { cause: error });
  }
});
