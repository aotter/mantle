/**
 * `mantle create <type> <directory>` — materialize one version-matched starter
 * bundle into a new local directory.
 *
 * It does not install dependencies, initialize git, configure auth, provision
 * providers, or deploy. A coding agent reads the generated project
 * instructions and continues from there.
 *
 * A bundle is remote input that can carry package.json, install scripts,
 * executable source, and agent instructions, so it is treated as code: only
 * the official immutable tag for this exact package version is accepted, the
 * response is bounded, the whole tree is validated and rendered before any
 * write, and the write lands in an exclusively-owned temporary directory that
 * is renamed into place. There is no --force.
 */
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cwd, stderr, stdout } from "node:process";
import { parseArgs } from "node:util";
import {
  DEFAULT_PROVISION_LIMITS,
  ProvisionRenderError,
  renderProvisionBundle,
  type LaunchValues,
  type ProvisionBundle,
} from "./provision.js";

const STARTERS_OWNER = "aotter";
const STARTERS_REPO = "mantle-starters";
/**
 * Released starter types. Community and Membership are deliberately absent:
 * they are not released yet, and the create catalog must not offer a type the
 * launch flow cannot deliver.
 */
const CREATE_ARCHETYPES = ["blank", "presence", "intake", "publication", "transaction", "reservation"] as const;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;

export async function runCreate(rawArgs: readonly string[]): Promise<number> {
  let archetype: string;
  let directory: string;
  let brand: string | undefined;
  let description: string | undefined;
  let locales: readonly string[];

  try {
    const { values, positionals } = parseArgs({
      args: [...rawArgs],
      allowPositionals: true,
      options: {
        brand: { type: "string" },
        description: { type: "string" },
        locales: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      printHelp();
      return 0;
    }
    if (positionals.length !== 2) {
      stderr.write("Usage: mantle create <type> <directory>\n");
      return 2;
    }
    [archetype, directory] = positionals as [string, string];
    if (!(CREATE_ARCHETYPES as readonly string[]).includes(archetype)) {
      stderr.write(`Unknown type: ${archetype}\nAvailable: ${CREATE_ARCHETYPES.join(", ")}\n`);
      return 2;
    }
    brand = values.brand;
    description = values.description;
    locales = (values.locales ?? "en").split(",").map((locale) => locale.trim()).filter(Boolean);
  } catch (error) {
    stderr.write(`${message(error)}\n`);
    return 2;
  }

  const target = resolve(cwd(), directory);
  const projectName = slugify(target.split(/[\\/]/).pop() ?? "");
  if (projectName.length === 0) {
    stderr.write("The target directory name must contain a letter or digit.\n");
    return 2;
  }
  if (await exists(target)) {
    stderr.write(`Refusing to write into an existing path: ${target}\n`);
    return 1;
  }
  // Creating the parent chain would be state a failure could not undo. Ask for
  // an existing parent instead, so an aborted run leaves the disk untouched.
  if (!(await exists(dirname(target)))) {
    stderr.write(`Parent directory does not exist: ${dirname(target)}\n`);
    return 1;
  }

  const version = packageVersion();
  const starterRef = `v${version}`;
  const resolvedBrand = brand ?? titleCase(projectName);
  const launch: LaunchValues = {
    archetype,
    projectName,
    brand: resolvedBrand,
    description: description ?? `A Mantle ${archetype} site.`,
    locales,
    canonicalLocale: locales[0] ?? "en",
    // create stops before auth; self-managed is the free default the
    // generated handoff walks the owner through.
    authMode: "self-managed",
    starterRef,
    installTimestamp: new Date().toISOString(),
    siteUrl: "http://localhost:8787",
    githubOwner: "",
    adminGithubLogin: "",
    afterLaunchSkillUrl: "",
  };

  let rendered;
  try {
    const bundle = await fetchOfficialBundle(starterRef, archetype, version);
    rendered = renderProvisionBundle({ bundle, launch, limits: DEFAULT_PROVISION_LIMITS });
  } catch (error) {
    stderr.write(`mantle create: ${error instanceof ProvisionRenderError ? `${error.code}: ${error.message}` : message(error)}\n`);
    return 1;
  }

  try {
    await writeAtomically(target, rendered);
  } catch (error) {
    stderr.write(`mantle create: ${message(error)}\n`);
    return 1;
  }

  stdout.write(
    `Created ${archetype} project in ${target}\n`
      + `  Mantle ${version} - starter ${starterRef}\n\n`
      + "Next: read AGENTS.md in the new directory. It carries the install and\n"
      + "first-run steps for this project; nothing has been installed yet.\n",
  );
  return 0;
}

function printHelp(): void {
  stdout.write(`mantle create - materialize a version-matched starter into a new directory

Usage: mantle create <type> <directory> [options]

Types:
  ${CREATE_ARCHETYPES.join(", ")}

Options:
  --brand <name>          Display brand (default: derived from the directory name)
  --description <text>    One sentence describing the site
  --locales <list>        Comma-separated locales; the first is canonical (default: en)
  -h, --help              This help

Dependencies are not installed, git is not initialized, and nothing is
deployed. The generated AGENTS.md carries the next steps.
`);
}

/**
 * Only the official immutable tag for this exact package version. A bundle
 * URL or ref is never taken from user input in this path.
 */
async function fetchOfficialBundle(starterRef: string, archetype: string, version: string): Promise<ProvisionBundle> {
  const url = `https://raw.githubusercontent.com/${STARTERS_OWNER}/${STARTERS_REPO}/${encodeURIComponent(starterRef)}/provision-bundles/${encodeURIComponent(archetype)}.json`;
  const response = await fetch(url, { headers: { accept: "application/json" }, redirect: "error" });
  if (!response.ok) {
    // A 404 on a version-pinned tag has one common cause worth naming: the
    // package was published before its matching starter tag exists.
    const hint = response.status === 404
      ? ` The ${starterRef} starter tag does not exist yet — if this version was just published, wait for its starter release, or pin an earlier version.`
      : "";
    throw new Error(`could not fetch the ${archetype} starter for ${starterRef} (HTTP ${response.status}).${hint}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BUNDLE_BYTES) {
    throw new Error(`starter bundle exceeds ${MAX_BUNDLE_BYTES} bytes.`);
  }
  const text = await readBounded(response, MAX_BUNDLE_BYTES);
  let bundle: ProvisionBundle;
  try {
    bundle = JSON.parse(text) as ProvisionBundle;
  } catch {
    throw new Error("starter bundle is not valid JSON.");
  }
  // The URL is version-pinned, but a mis-built bundle published under that tag
  // would still render. Refuse a version the tag does not promise.
  if (bundle.version !== version) {
    throw new Error(`starter bundle at ${starterRef} declares version ${String(bundle.version)}, expected ${version}.`);
  }
  return bundle;
}

/** Stops reading at the limit; a chunked response never gets to allocate past it. */
async function readBounded(response: Response, max: number): Promise<string> {
  const body = response.body;
  if (!body) return response.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`starter bundle exceeds ${max} bytes.`);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

/**
 * Writes into an exclusively-created sibling directory, then renames it onto a
 * target that did not previously exist. A failure leaves nothing behind.
 */
async function writeAtomically(
  target: string,
  rendered: { files: ReadonlyMap<string, string>; binaryFiles: ReadonlyMap<string, string> },
): Promise<void> {
  const staging = await mkdtemp(join(dirname(target), ".mantle-create-"));
  try {
    for (const [path, content] of rendered.files) {
      await writeFileAt(staging, path, Buffer.from(content, "utf8"));
    }
    for (const [path, content] of rendered.binaryFiles) {
      await writeFileAt(staging, path, Buffer.from(content, "base64"));
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function writeFileAt(root: string, relativePath: string, data: Buffer): Promise<void> {
  const destination = join(root, relativePath);
  await mkdir(dirname(destination), { recursive: true, mode: DIRECTORY_MODE });
  // Regular file, fixed mode: a bundle cannot create a symlink or an
  // executable.
  await writeFile(destination, data, { mode: FILE_MODE, flag: "wx" });
}

function packageVersion(): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: string };
  if (typeof manifest.version !== "string") throw new Error("installed package has no version");
  return manifest.version;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/g, "");
}

function titleCase(slug: string): string {
  return slug.split("-").filter(Boolean).map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
