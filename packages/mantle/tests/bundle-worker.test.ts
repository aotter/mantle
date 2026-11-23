import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle } from "../src/infrastructure/bundle.js";

test("the Worker bundle carries only a package's production build", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mantle-bundle-worker-"));
  try {
    // shaped like react-dom/server.edge: the entry picks its build from process.env.NODE_ENV
    const lib = join(dir, "node_modules/lib");
    await mkdir(lib, { recursive: true });
    await writeFile(join(lib, "package.json"), JSON.stringify({ name: "lib", main: "./index.js" }));
    await writeFile(
      join(lib, "index.js"),
      'module.exports = process.env.NODE_ENV === "production" ? require("./prod.js") : require("./dev.js");',
    );
    await writeFile(join(lib, "prod.js"), 'module.exports = "PROD_BUILD";');
    await writeFile(join(lib, "dev.js"), 'module.exports = "DEV_BUILD";');
    const entry = join(dir, "worker.js");
    await writeFile(entry, 'import lib from "lib";\nexport default { fetch: () => new Response(lib) };');
    const out = join(dir, "dist/worker");
    await bundle(entry, out);
    const code = (readdirSync(out, { recursive: true }) as string[])
      .filter(name => name.endsWith(".js"))
      .map(name => readFileSync(join(out, name), "utf8"))
      .join("\n");
    expect(code).toContain("PROD_BUILD");
    expect(code).not.toContain("DEV_BUILD");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
