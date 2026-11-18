/** A Procedure's generated `input(raw)` is what its bare function takes, with no cast; its generated input types are unchanged. */
import { expect, test } from "bun:test";
import ts from "typescript";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateOrThrow, loadGenerated, writeGenerated } from "./apps/link.js";

const manifest = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: tasks}
spec:
  title: Tasks
  lifecycle: operational
  indexes: [[title]]
  schema:
    type: object
    required: [title]
    properties:
      title: {type: string}
      meta: {type: object}
      tags: {type: array, items: {type: string}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: add-task}
spec:
  requires: {auth: {all: [ctx.user]}}
  input:
    type: object
    required: [title]
    additionalProperties: false
    properties:
      title: {type: string}
      meta: {type: object, nullable: true}
      tags: {type: array, items: {type: string}}
  output: {type: object}
  handler:
    sql: INSERT INTO tasks (title, meta, tags) VALUES (input.title, input.meta, input.tags) RETURNING id
`;
const consumer = `import addTask, { type Input } from "./procedures/add-task.js";
import { input } from "./validation/procedures/add-task.js";
export async function check(db: Parameters<typeof addTask>[0], caller: Parameters<typeof addTask>[1], raw: unknown, typed: Input) {
  await addTask(db, caller, input(raw));
  await addTask(db, caller, { title: "t", meta: { a: 1 }, tags: ["a"] });
  // @ts-expect-error a plain string is not JSON text
  await addTask(db, caller, { title: "t", meta: "not json", tags: null });
  // @ts-expect-error a plain string is not JSON text
  await addTask(db, caller, { title: "t", meta: null, tags: "[]" });
  const tags: readonly string[] | undefined = typed.tags?.map(tag => tag);
  // @ts-expect-error a converted JSON field is its text
  input(raw).tags?.map(tag => tag);
  return tags;
}
`;

test("Procedure map validation counts own fields and reports the precise escaped input path", async () => {
  const source = manifest.replace(
    "      meta: {type: object, nullable: true}",
    `      meta:
        type: object
        additionalProperties: {type: string}
        minProperties: 1
        maxProperties: 2
        propertyNames: {pattern: "^[a-z]+$", maxLength: 12, not: {enum: [private]}}`,
  );
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "tasks.yaml", text: source }]);
  const { validate } = await loadGenerated(files["validation/procedures/add-task.ts"]!);
  expect(validate({ title: "task", meta: { label: "ok" } })).toEqual({ title: "task", meta: { label: "ok" } });
  for (const [meta, path, message] of [
    [{}, "meta", "minProperties"],
    [{ a: "1", b: "2", c: "3" }, "meta", "maxProperties"],
    [{ "bad/~": "v" }, "meta/bad~1~0", "pattern"],
    [{ private: "v" }, "meta/private", "forbidden"],
  ] as const) {
    try {
      validate({ title: "task", meta });
      throw new Error("Invalid map was accepted.");
    } catch (error) {
      expect(error).toMatchObject({ code: "INPUT_VALIDATION_FAILED", path: `procedures/add-task/input/${path}` });
      expect((error as Error).message).toContain(message);
    }
  }
});

test("input(raw) passes to the bare Procedure with no cast, and a plain string is still refused, on all four targets", async () => {
  await mkdir(resolve(import.meta.dir, "apps/.generated"), { recursive: true });
  const dir = await mkdtemp(resolve(import.meta.dir, "apps/.generated/procedure-input-"));
  try {
    const roots: string[] = [];
    for (const target of ["cloudflare-d1", "cloudflare-postgres", "bun-postgres", "bun-sqlite"] as const) {
      const destination = resolve(dir, target);
      await writeGenerated(
        destination,
        await generateOrThrow(target, [{ sourceId: "tasks.yaml", text: manifest }]),
        false,
      );
      await writeFile(resolve(destination, "consumer.ts"), consumer);
      roots.push(resolve(destination, "consumer.ts"));
    }
    const program = ts.createProgram(roots, {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      types: ["node", "bun-types"],
      typeRoots: [resolve(import.meta.dir, "../node_modules/@types"), resolve(import.meta.dir, "../node_modules")],
    });
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map(d => `${d.file?.fileName} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`)
        .join("\n"),
    ).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
