import { expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execute } from "./fixtures/revisions-example";

const sdk = resolve(import.meta.dirname, "../../mantle"),
  admin = resolve(import.meta.dirname, ".."),
  handbook = resolve(sdk, "../../docs/handbook");
const blocks = (page: string, language: string) =>
  [...page.matchAll(new RegExp("^```" + language + "\\n([\\s\\S]*?)^```$", "gm"))].map(match => match[1]!);

it("the password sign-in recipe's Admin files typecheck against the generated Admin client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mantle-sign-in-methods-"));
  try {
    await mkdir(join(directory, "src"));
    await mkdir(join(directory, "node_modules/@aotter"), { recursive: true });
    for (const [name, path] of [
      ["mantle", sdk],
      ["mantle-admin", admin],
      ["mantle-ui", resolve(admin, "../mantle-ui")],
    ])
      await symlink(path!, join(directory, "node_modules/@aotter", name!), "dir");
    for (const name of ["react", "react-dom", "@types"])
      await symlink(join(admin, "node_modules", name), join(directory, "node_modules", name), "dir");
    await symlink(join(sdk, "node_modules/bun-types"), join(directory, "node_modules/bun-types"), "dir");
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    // The recipe starts from an init app with manifests; the quickstart's give it a generated Admin client.
    const quickstart = await readFile(join(handbook, "start/quickstart-worker.md"), "utf8");
    await writeFile(join(directory, "manifests.yaml"), blocks(quickstart, "yaml").join("\n---\n"));
    await execute(
      process.execPath,
      [join(sdk, "dist/infrastructure/cli.js"), "generate", "bun-sqlite", "generated", "manifests.yaml", "--admin"],
      { cwd: directory },
    );
    const sources = blocks(await readFile(join(handbook, "cloudflare/sign-in-methods.md"), "utf8"), "tsx");
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      const path = source.match(/^\/\/ (src\/[\w.-]+\.tsx)\b/)?.[1];
      if (!path) throw Error("Each sign-in TSX block must start with the path of the file it is");
      await writeFile(join(directory, path), source);
    }
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["react", "bun-types"],
          lib: ["ES2023", "DOM"],
        },
        include: ["src/*.tsx", "generated/**/*.ts"],
      }),
    );
    const result = await execute(
      process.execPath,
      [resolve(admin, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", directory],
      { cwd: directory },
    ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? String(error), stderr: "failed" }));
    expect(result.stdout + result.stderr).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
