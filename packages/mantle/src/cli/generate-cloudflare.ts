import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { assertInsideProject, type ProjectSelection } from "./generate-project.js";

interface PlannedFile { readonly path: string; readonly content: string; readonly owned: boolean }

/** Prepare all paths before the caller commits any project files. */
export async function prepareCloudflare(root: string, output: string, selection: ProjectSelection, fresh: boolean): Promise<{
  readonly stale: boolean;
  readonly commit: () => Promise<void>;
}> {
  const selected = (feature: string): boolean => selection.features.includes(feature as typeof selection.features[number]);
  const name = basename(root).toLowerCase().replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/g, "") || "mantle-app";
  const worker = resolve(root, output, "worker.ts");
  const fromIndex = importPath(join(root, "src/index.ts"), worker);
  const toHandlers = importPath(worker, join(root, "src/handlers.ts"));
  const toHome = importPath(worker, join(root, "src/home.ts"));
  if (!selected("admin")) {
    const adminAssets = join(root, "public/_mantle/admin");
    await assertInsideProject(root, adminAssets);
    const present = await lstat(adminAssets).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (present) throw new Error("Unselected Admin assets already exist; remove them deliberately before generating this reduced composition.");
  }
  const files: PlannedFile[] = [
    { path: worker, content: workerSource(selection, toHandlers, toHome), owned: true },
    { path: "src/index.ts", content: `export { default } from "${fromIndex}";\n`, owned: false },
    { path: "src/handlers.ts", content: 'import type { AnyHandler } from "@aotter/mantle/runtime";\n\nexport const handlers: Record<string, AnyHandler> = {};\n', owned: false },
    { path: "tsconfig.json", content: `${JSON.stringify({ compilerOptions: {
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
      noEmit: true, skipLibCheck: true, types: ["@cloudflare/workers-types"],
    }, include: ["src/**/*.ts", `${relative(root, resolve(root, output)).split(sep).join("/") || "."}/**/*.ts`] }, null, 2)}\n`, owned: false },
  ];
  const wrangler = await Promise.all(["wrangler.jsonc", "wrangler.json", "wrangler.toml"].map(async (path) => ({
    path, text: await readFile(join(root, path), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  })));
  const presentWrangler = wrangler.filter((file) => file.text !== null);
  if (presentWrangler.length > 1) throw new Error(`Multiple Wrangler configs found: ${presentWrangler.map((file) => file.path).join(", ")}. Choose one before generating.`);
  const existingWrangler = presentWrangler[0];
  if (existingWrangler) {
    const source = existingWrangler.text!;
    if (!/\bmain["']?\s*[:=]\s*["']src\/index\.ts["']/.test(source) ||
        !/\bbinding["']?\s*[:=]\s*["']DB["']/.test(source) ||
        (selected("admin") && !/\bbinding["']?\s*[:=]\s*["']ASSETS["']/.test(source))) {
      throw new Error(`Existing ${existingWrangler.path} is preserved; configure main=src/index.ts, DB and${selected("admin") ? " ASSETS" : ""} bindings before adoption.`);
    }
  } else {
    files.push({ path: "wrangler.jsonc", content: `${JSON.stringify({
      $schema: "node_modules/wrangler/config-schema.json", name, main: "src/index.ts",
      compatibility_date: "2026-09-08", compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
      ...(selected("admin") ? { assets: { directory: "./public", binding: "ASSETS" } } : {}),
      d1_databases: [{ binding: "DB", database_name: name }],
    }, null, 2)}\n`, owned: false });
  }
  const entry = await readFile(join(root, "src/index.ts"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (entry !== null && !entry.includes(fromIndex)) {
    throw new Error(`Existing src/index.ts is preserved; import the generated Worker from ${fromIndex} before adoption.`);
  }
  if (selected("admin")) files.push({ path: ".dev.vars.example", content: "# Copy to .dev.vars for local Admin OTP. Never deploy these values.\nMANTLE_AUTH_MODE=local-otp\nPUBLIC_ORIGIN=http://127.0.0.1:8787\nADMIN_EMAIL=you@example.com\nBETTER_AUTH_SECRET=replace-with-a-random-32-byte-secret\n", owned: false });
  if (selected("web")) files.push({
    path: "src/home.ts", owned: false,
    content: 'export function home(): Response {\n  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Mantle</title><body><main></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });\n}\n',
  });
  const ignorePath = join(root, ".gitignore");
  await assertInsideProject(root, ignorePath);
  const gitignore = await readFile(ignorePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const ignoreMissing = !gitignore?.split(/\r?\n/).includes(".dev.vars");
  let stale = ignoreMissing;
  const writes: PlannedFile[] = [];
  for (const file of files) {
    const path = resolve(root, file.path);
    await assertInsideProject(root, path);
    const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current !== null && file.owned && !current.startsWith("// Generated by `mantle generate`")) {
      throw new Error(`Generated output would replace a user-owned file: ${path}`);
    }
    if ((current === null && (file.owned || fresh || ["src/index.ts", "src/handlers.ts", "src/home.ts", "tsconfig.json", "wrangler.jsonc"].includes(file.path))) ||
        (file.owned && current !== file.content)) {
      stale = true;
      writes.push(file);
    }
  }
  return {
    stale,
    commit: async () => {
      for (const file of writes) {
        const path = resolve(root, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content, { flag: file.owned ? "w" : "wx" });
      }
      if (ignoreMissing) {
        if (gitignore === null) await writeFile(ignorePath, "node_modules/\n.wrangler/\n.dev.vars\n", { flag: "wx" });
        else await appendFile(ignorePath, `${gitignore.endsWith("\n") ? "" : "\n"}.dev.vars\n`);
      }
    },
  };
}

function workerSource(selection: ProjectSelection, toHandlers: string, toHome: string): string {
  const has = (feature: string): boolean => selection.features.includes(feature as typeof selection.features[number]);
  const auth = has("admin");
  return `// Generated by \`mantle generate\`. Edit src/home.ts and src/handlers.ts instead.\n` +
    `import { createMantleWorker${auth ? ", createAuth, createConventionalAuth, ConsoleEmailSender" : ""}, type MantleCloudflareEnv } from "@aotter/mantle/cloudflare";\n` +
    `import { plan } from "./mantle.js";\n` +
    `import { handlers } from "${toHandlers}";\n` +
    (has("web") ? `import { home } from "${toHome}";\n` : "") +
    `\ntype Env = MantleCloudflareEnv & { readonly ADMIN_EMAIL?: string };\n` +
    (auth ? `const sender = new ConsoleEmailSender();\n` : "") +
    `\nexport default createMantleWorker<Env>({\n  plan,\n  handlers,\n` +
    `  surfaces: { api: ${has("api")}, mcp: ${has("mcp")}, admin: ${has("admin")} },\n` +
    (has("web") ? `  frontend: () => home(),\n` : "") +
    (auth ? `  auth: (env) => {\n    if (env.MANTLE_AUTH_MODE !== "local-otp") return createConventionalAuth(env);\n    const origin = env.PUBLIC_ORIGIN;\n    let local = false;\n    try { const url = new URL(origin ?? ""); local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname); } catch { /* fail closed */ }\n    if (!origin || !local || !env.ADMIN_EMAIL || !env.BETTER_AUTH_SECRET) return createConventionalAuth(env);\n    return createAuth({\n      database: env.DB, baseURL: origin, secret: env.BETTER_AUTH_SECRET,\n      methods: [{ kind: "email-otp", sender }],\n      bootstrapOwner: { match: "email", value: env.ADMIN_EMAIL },\n      oauthProvider: {\n        loginPage: "/admin/sign-in", consentPage: "/oauth/consent",\n        scopes: ["mcp"], mcpResource: \`\${origin.replace(/\\/+$/, "")}/mcp\`,\n        allowDynamicClientRegistration: true, allowUnauthenticatedClientRegistration: true,\n        clientRegistrationDefaultScopes: ["mcp"], clientRegistrationAllowedScopes: ["mcp"],\n      },\n    });\n  },\n` : "") +
    `});\n`;
}

function importPath(from: string, to: string): string {
  const path = relative(dirname(from), to).split(sep).join("/").replace(/\.ts$/, ".js");
  return path.startsWith(".") ? path : `./${path}`;
}
