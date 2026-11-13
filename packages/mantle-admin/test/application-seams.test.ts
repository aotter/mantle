/**
 * Protected application seams of `@aotter/mantle-admin` (registry: packages/mantle/tests/application-seams.ts). Each seam's
 * hand-written consumer module is typechecked against the built package, as an application imports it, and run where the
 * seam has run-time behaviour. These seams use no database, so they behave the same on every stack.
 */
import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { SEAMS, type Seam } from "../../mantle/tests/application-seams.js";

const REGISTRY = "packages/mantle/tests/application-seams.ts";
const root = resolve(import.meta.dirname, "../../..");
const admin = SEAMS.filter(seam => seam.package === "@aotter/mantle-admin");
const guard = (seams: readonly Seam[], problem: string) =>
  `${seams.map(seam => seam.id).join(", ")}: protected application seam (registry: ${REGISTRY}). ${problem}\n` +
  'Removing, moving or narrowing a registered seam needs an ADR or ADR-lite and a migration note (CONTRIBUTING.md, "Application seams").';
const files = [...new Set(admin.map(seam => resolve(root, seam.check)))];
const seamsOf = (file: string) => admin.filter(seam => resolve(root, seam.check) === file);

it("every registered Admin seam is an exported subpath with its named exports", async () => {
  const exportsMap = JSON.parse(await readFile(resolve(import.meta.dirname, "../package.json"), "utf8")).exports;
  for (const seam of admin) {
    const entry = seam.subpath && exportsMap[seam.subpath];
    if (!entry) throw new Error(guard([seam], `${seam.subpath} is no longer a subpath of ${seam.package}.`));
    const module = await import(pathToFileURL(resolve(import.meta.dirname, "..", entry.import ?? entry)).href);
    const missing = (seam.exports ?? []).filter(name => !(name in module));
    if (missing.length) throw new Error(guard([seam], `${seam.subpath} no longer exports ${missing.join(", ")}.`));
  }
});

it("each Admin seam's application module typechecks from public imports and without casts", async () => {
  for (const file of files)
    if (
      /@aotter\/mantle\/internal\/|\bas (?:any|never|unknown)\b|@ts-(?:ignore|expect-error)/.test(
        await readFile(file, "utf8"),
      )
    )
      throw new Error(guard(seamsOf(file), `${basename(file)} must use public imports only and no casts.`));
  const program = ts.createProgram(files, {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
    skipLibCheck: true,
    types: [],
  });
  const failures = ts
    .getPreEmitDiagnostics(program)
    .map(d =>
      guard(
        seamsOf(d.file?.fileName ?? ""),
        `Its application module no longer typechecks: ${basename(d.file?.fileName ?? "")} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
      ),
    );
  expect(failures.join("\n\n")).toBe("");
}, 60_000);

it("the Admin App renders the application's own tool and the upload card serves the host's tool", async () => {
  try {
    const { adminApp, uploadCard } = await import("./seams/mcp-apps.js");
    expect(adminApp.resources[0]!.renders).toContain("note_summary");
    const card = uploadCard.resources[0]!;
    expect(card.renders).toEqual(["attach_note_image"]);
    const page = await (card.html as (render: unknown) => Promise<{ html: string }>)({ env: {}, tools: new Set() });
    expect(page.html).toContain('"tool":"attach_note_image","forward":["notebook"],"inputTimeoutMs":2000');
  } catch (error) {
    throw new Error(
      guard(
        admin.filter(seam => seam.id !== "host-tools"),
        `It no longer behaves as its application module expects: ${error}`,
      ),
      {
        cause: error,
      },
    );
  }
});
