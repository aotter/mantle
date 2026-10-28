import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sdk = resolve(import.meta.dirname, "../../../mantle"), admin = resolve(import.meta.dirname, "../..");
export const execute = promisify(execFile);
export async function prepareRevisionsExample() {
  const directory = await mkdtemp(join(tmpdir(), "mantle-revisions-example-"));
  const guide = await readFile(resolve(sdk, "../../docs/handbook/guides/revisions.md"), "utf8");
  const blocks = (language: string) => [...guide.matchAll(new RegExp("^```" + language + "\\n([\\s\\S]*?)^```$", "gm"))].map(match => match[1]!);
  await mkdir(join(directory, "src"));
  await mkdir(join(directory, "node_modules/@aotter"), { recursive: true });
  for (const [name, path] of [["mantle", sdk], ["mantle-admin", admin], ["mantle-ui", resolve(admin, "../mantle-ui")]]) {
    await symlink(path!, join(directory, "node_modules/@aotter", name!), "dir");
  }
  for (const name of ["react", "react-dom", "@types"]) await symlink(join(admin, "node_modules", name), join(directory, "node_modules", name), "dir");
  await symlink(join(sdk, "node_modules/bun-types"), join(directory, "node_modules/bun-types"), "dir");
  await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
  await writeFile(join(directory, "manifests.yaml"), blocks("yaml").join("\n---\n"));
  const cli = join(sdk, "dist/infrastructure/cli.js");
  for (const check of [false, true]) await execute(process.execPath, [cli, "generate", "bun-sqlite", "generated", "manifests.yaml", "--admin", ...(check ? ["--check"] : [])], { cwd: directory });
  await writeFile(join(directory, "src/handlers.ts"), blocks("ts").find(block => block.includes("export const handlers"))!);
  for (const source of blocks("tsx")) {
    const path = source.match(/^\/\/ (src\/admin(?:\.mcp)?\.tsx)\n/)?.[1];
    if (!path) throw Error("Each revisions TSX block must identify its checked entry path");
    await writeFile(join(directory, path), source);
  }
  await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, noEmit: true, skipLibCheck: true, types: ["react", "bun-types"], lib: ["ES2023", "DOM"] }, include: ["src/*.tsx", "src/handlers.ts", "generated/**/*.ts"] }));
  return directory;
}
