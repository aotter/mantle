import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { cwd, stderr, stdout } from "node:process";
import { parseArgs } from "node:util";

const DEFAULT_REPORT = ".mantle/update-report.json";
const IGNORE_DIRS = new Set([".git", "node_modules", ".wrangler", ".wrangler-test", "dist"]);
const IGNORE_FILES = new Set([
  ".mantle/features.json",
  ".mantle/launch-state.json",
  DEFAULT_REPORT,
]);

interface ProvisionBundle {
  readonly version?: string;
  readonly files: Readonly<Record<string, string>>;
}

type JsonRecord = Record<string, unknown>;

export async function runUpdate(rawArgs: readonly string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...rawArgs],
      options: {
        ref: { type: "string" },
        report: { type: "string" },
        "bundle-base-url": { type: "string" },
        strict: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    stderr.write(`${message(error)}\n`);
    return 2;
  }
  if (values.help) {
    stdout.write(`mantle update — compare this site with another provision bundle

Usage: mantle update [options]

Options:
  --ref <ref>              Target starter ref; defaults to registry.version
  --bundle-base-url <url>  Override registry.bundleBaseUrl; use {ref} in the URL
  --report <path>          Report path (default: ${DEFAULT_REPORT})
  --strict                 Exit 2 when either upstream or local files differ
  -h, --help               This help
`);
    return 0;
  }

  const root = cwd();
  const reportPath = resolve(root, values.report ?? DEFAULT_REPORT);
  const ignoredFiles = ignoredProjectFiles(root, reportPath);
  const launchState = await readJson(join(root, ".mantle", "launch-state.json"));
  const features = await readJson(join(root, ".mantle", "features.json"));
  const registry = recordField(features, "registry");
  const sourceRef = stringField(launchState, "starter_ref");
  const targetRef = values.ref ?? stringField(registry, "version");
  const bundleBaseUrl = values["bundle-base-url"] ?? stringField(registry, "bundleBaseUrl");
  if (!sourceRef) {
    stderr.write(".mantle/launch-state.json is missing starter_ref.\n");
    return 2;
  }
  if (!targetRef) {
    stderr.write("Pass --ref or configure .mantle/features.json registry.version.\n");
    return 2;
  }
  if (!bundleBaseUrl) {
    stderr.write(
      "Pass --bundle-base-url or configure .mantle/features.json registry.bundleBaseUrl.\n",
    );
    return 2;
  }

  const archetype = launchArchetype(launchState, features);
  const tempRoot = await mkdtemp(join(tmpdir(), "mantle-update-"));
  try {
    const sourceRoot = join(tempRoot, "source");
    const targetRoot = join(tempRoot, "target");
    const sourceBundle = await fetchBundle(bundleBaseUrl, sourceRef, archetype);
    const targetBundle = sourceRef === targetRef
      ? sourceBundle
      : await fetchBundle(bundleBaseUrl, targetRef, archetype);
    const timestamp = new Date().toISOString();
    const turnstileSiteKey = optionalStringField(launchState, "turnstile_site_key")
      ?? await readLegacyWranglerStringVar(root, "TURNSTILE_SITE_KEY")
      ?? "";
    await materializeBundle(
      sourceRoot,
      sourceBundle,
      placeholders(launchState, features, sourceRef, timestamp, turnstileSiteKey),
    );
    await materializeBundle(
      targetRoot,
      targetBundle,
      placeholders(launchState, features, targetRef, timestamp, turnstileSiteKey),
    );
    const upstream = await compare(sourceRoot, targetRoot, ignoredFiles);
    const local = await compare(root, sourceRoot, ignoredFiles);
    const report = {
      schema_version: 3,
      generated_at: timestamp,
      source_ref: sourceRef,
      target_ref: targetRef,
      bundle_base_url: bundleBaseUrl,
      bundle_version: targetBundle.version ?? null,
      upstream,
      local,
      metadata_migration: metadataMigration({
        sourceRef,
        targetRef,
        bundleBaseUrl,
        registry,
      }),
      next_step:
        "Port reviewed upstream changes only; then apply the reported metadata migration while preserving other instance state.",
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    stdout.write(`mantle update report: ${relative(root, reportPath) || reportPath}\n`);
    stdout.write(
      `${sourceRef} → ${targetRef}: ${upstream.counts.differing} changed, `
      + `${upstream.counts.missing_current} added, ${upstream.counts.removed_upstream} removed; `
      + `local: ${local.counts.differing} modified, ${local.counts.missing_current} missing, `
      + `${local.counts.removed_upstream} project-only\n`,
    );
    const differs = Object.values(upstream.counts).some(Boolean)
      || Object.values(local.counts).some(Boolean);
    return values.strict && differs ? 2 : 0;
  } catch (error) {
    stderr.write(`mantle update: ${message(error)}\n`);
    return 1;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function metadataMigration(input: {
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly bundleBaseUrl: string;
  readonly registry: JsonRecord;
}): JsonRecord {
  const currentBaseUrl = stringField(input.registry, "bundleBaseUrl");
  const currentVersion = stringField(input.registry, "version");
  return {
    required: input.sourceRef !== input.targetRef
      || currentBaseUrl !== input.bundleBaseUrl
      || currentVersion !== input.targetRef,
    apply_after_reviewed_port: true,
    files: [
      {
        path: ".mantle/launch-state.json",
        set: { starter_ref: input.targetRef },
        preserve_other_fields: true,
      },
      {
        path: ".mantle/features.json",
        set: {
          registry: {
            version: input.targetRef,
            bundleBaseUrl: input.bundleBaseUrl,
          },
        },
        preserve_other_fields: true,
      },
    ],
  };
}

async function fetchBundle(baseTemplate: string, ref: string, archetype: string): Promise<ProvisionBundle> {
  let response: Response | null = null;
  let url: URL | null = null;
  for (const candidate of bundleRefCandidates(ref)) {
    const candidateBase = baseTemplate
      .replaceAll("{ref}", encodeURIComponent(candidate))
      .replace(/\/+$/, "");
    url = new URL(`${candidateBase}/${encodeURIComponent(archetype)}.json`);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("bundleBaseUrl must use http or https");
    }
    response = await fetch(url, { headers: { accept: "application/json" } });
    if (response.ok || response.status !== 404) break;
  }
  if (!response || !url) throw new Error(`failed to resolve provision bundle ${ref}`);
  if (!response.ok) throw new Error(`failed to fetch ${url}: HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!isRecord(value) || !isStringRecord(value.files)) {
    throw new Error(`invalid provision bundle at ${url}`);
  }
  return { version: typeof value.version === "string" ? value.version : undefined, files: value.files };
}

function bundleRefCandidates(ref: string): readonly string[] {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(ref) ? [ref, `v${ref}`] : [ref];
}

async function materializeBundle(
  root: string,
  bundle: ProvisionBundle,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [path, source] of Object.entries(bundle.files)) {
    const target = safeTarget(root, path.replace(/\.template$/, ""));
    await mkdir(dirname(target), { recursive: true });
    const substituted = substitute(source, substitutionValues(path, values));
    await writeFile(
      target,
      path === "wrangler.toml" ? materializeLegacyWranglerToml(substituted, values) : substituted,
      "utf8",
    );
  }
}

function substitutionValues(
  path: string,
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const target = path.replace(/\.template$/, "");
  if (target.endsWith(".html")) return htmlValues(values);
  if (target.endsWith(".json") || target.endsWith(".jsonc") || target === "package.json") {
    return jsonValues(values);
  }
  return values;
}

function materializeLegacyWranglerToml(
  text: string,
  values: Readonly<Record<string, string>>,
): string {
  // Alpha.63 and older bundles predate stamped Wrangler placeholders.
  const envStart = text.search(/\n\[env\./);
  const head = envStart === -1 ? text : text.slice(0, envStart);
  const tail = envStart === -1 ? "" : text.slice(envStart);
  let next = head.replace(/^name = ".*"$/m, `name = ${JSON.stringify(values.PROJECT_NAME)}`);
  next = next.replace(
    /^database_name = ".*"$/m,
    `database_name = ${JSON.stringify(`${values.PROJECT_NAME}-db`)}`,
  );
  next = upsertLegacyWranglerStringVar(next, "PUBLIC_ORIGIN", values.SITE_URL ?? "");
  if (values.TURNSTILE_SITE_KEY?.trim()) {
    next = upsertLegacyWranglerStringVar(
      next,
      "TURNSTILE_SITE_KEY",
      values.TURNSTILE_SITE_KEY.trim(),
    );
  }
  return `${next}${tail}`;
}

function upsertLegacyWranglerStringVar(text: string, name: string, value: string): string {
  const line = `${name} = ${JSON.stringify(value)}`;
  const existing = new RegExp(`^\\s*#?\\s*${escapeRegExp(name)}\\s*=.*$`, "m");
  if (existing.test(text)) return text.replace(existing, line);
  const vars = text.match(/^\[vars\]\s*$/m);
  if (!vars || vars.index === undefined) return `${text.trimEnd()}\n\n[vars]\n${line}\n`;
  const insertAt = vars.index + vars[0].length;
  return `${text.slice(0, insertAt)}\n${line}${text.slice(insertAt)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonValues(values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    key === "LOCALES" ? value : JSON.stringify(value).slice(1, -1),
  ]));
}

function htmlValues(values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    value.replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]!),
  ]));
}

function safeTarget(root: string, path: string): string {
  const target = resolve(root, path);
  const fromRoot = relative(resolve(root), target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error(`bundle path escapes project root: ${path}`);
  }
  return target;
}

function substitute(source: string, values: Readonly<Record<string, string>>): string {
  return source.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (token, key: string) => {
    const value = values[key];
    if (value !== undefined) return value;
    throw new Error(`unknown provision placeholder ${token}`);
  });
}

function placeholders(
  launchState: JsonRecord,
  features: JsonRecord,
  targetRef: string,
  timestamp: string,
  turnstileSiteKey: string,
): Readonly<Record<string, string>> {
  const github = recordField(launchState, "github");
  const repo = recordField(launchState, "repo");
  const siteOwner = recordField(launchState, "site_owner");
  const locales = arrayField(launchState, "locales");
  const owner = optionalStringField(repo, "owner")
    ?? optionalStringField(github, "owner")
    ?? "unknown-owner";
  const projectName = stringField(launchState, "project_name")
    ?? stringField(repo, "name")
    ?? "mantle-site";
  const archetype = launchArchetype(launchState, features);
  const siteUrl = stringField(launchState, "site_url") ?? "https://example.com";
  const locale = stringField(launchState, "canonical_locale") ?? locales[0] ?? "en";
  const description = stringField(launchState, "description") ?? `${projectName} site.`;
  return {
    PROJECT_NAME: projectName,
    ARCHETYPE: archetype,
    BRAND: stringField(launchState, "brand") ?? projectName,
    DESCRIPTION: description,
    INSTALL_SUMMARY: stringField(launchState, "summary") ?? `Mantle update check for ${projectName}.`,
    LOCALES: JSON.stringify(locales.length ? locales : ["en"]),
    CANONICAL_LOCALE: locale,
    STARTER_REF: targetRef,
    GITHUB_OWNER: owner,
    ADMIN_GITHUB_LOGIN: optionalStringField(github, "admin_login")
      ?? optionalStringField(siteOwner, "github_login")
      ?? owner,
    SITE_OWNER_EMAIL: optionalStringField(siteOwner, "email") ?? "",
    AUTH_MODE: stringField(launchState, "authMode") ?? "self-managed",
    SITE_URL: siteUrl,
    // This is a public widget key. Old Landing sites kept it only in Wrangler;
    // the Turnstile secret remains Worker-owned and never enters the bundle.
    TURNSTILE_SITE_KEY: turnstileSiteKey,
    AFTER_LAUNCH_SKILL_URL: stringField(launchState, "after_launch_skill_url")
      ?? afterLaunchSkillUrl(owner, projectName, siteUrl, archetype, locale, description),
    INSTALL_TIMESTAMP: timestamp,
  };
}

async function readLegacyWranglerStringVar(root: string, name: string): Promise<string | null> {
  let source: string;
  try {
    source = await readFile(join(root, "wrangler.toml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const match = source.match(new RegExp(`^\\s*${escapeRegExp(name)}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m"));
  if (!match?.[1]) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    return typeof value === "string" ? value.trim() : null;
  } catch {
    return null;
  }
}

function afterLaunchSkillUrl(
  owner: string,
  projectName: string,
  siteUrl: string,
  archetype: string,
  locale: string,
  purpose: string,
): string {
  const url = new URL("https://mantle.tools/skill/after-launch");
  url.searchParams.set("repo", `https://github.com/${owner}/${projectName}`);
  url.searchParams.set("site", siteUrl);
  url.searchParams.set("type", archetype);
  url.searchParams.set("locale", locale);
  if (purpose) url.searchParams.set("purpose", purpose);
  return url.toString();
}

interface DiffReport {
  readonly counts: { readonly differing: number; readonly missing_current: number; readonly removed_upstream: number };
  readonly differing: readonly JsonRecord[];
  readonly missing_current: readonly JsonRecord[];
  readonly removed_upstream: readonly JsonRecord[];
}

function ignoredProjectFiles(root: string, reportPath: string): ReadonlySet<string> {
  const ignored = new Set(IGNORE_FILES);
  const report = relative(resolve(root), reportPath);
  if (report && !report.startsWith("..") && !isAbsolute(report)) {
    ignored.add(report.replaceAll("\\", "/"));
  }
  return ignored;
}

async function compare(
  currentRoot: string,
  upstreamRoot: string,
  ignoredFiles: ReadonlySet<string>,
): Promise<DiffReport> {
  const upstreamFiles = await listFiles(upstreamRoot, "", ignoredFiles);
  const differing: JsonRecord[] = [];
  const missingCurrent: JsonRecord[] = [];
  for (const path of upstreamFiles) {
    const current = join(currentRoot, path);
    const upstream = join(upstreamRoot, path);
    if (!(await exists(current))) {
      missingCurrent.push({ path, upstream_sha256: await sha256(upstream) });
      continue;
    }
    const [currentSha, upstreamSha] = await Promise.all([sha256(current), sha256(upstream)]);
    if (currentSha !== upstreamSha) {
      differing.push({ path, current_sha256: currentSha, upstream_sha256: upstreamSha });
    }
  }
  const removedUpstream: JsonRecord[] = [];
  for (const path of await listFiles(currentRoot, "", ignoredFiles)) {
    if (!(await exists(join(upstreamRoot, path)))) {
      removedUpstream.push({ path, current_sha256: await sha256(join(currentRoot, path)) });
    }
  }
  return {
    counts: {
      differing: differing.length,
      missing_current: missingCurrent.length,
      removed_upstream: removedUpstream.length,
    },
    differing,
    missing_current: missingCurrent,
    removed_upstream: removedUpstream,
  };
}

async function listFiles(
  root: string,
  prefix = "",
  ignoredFiles: ReadonlySet<string> = IGNORE_FILES,
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, path, ignoredFiles));
    else if (entry.isFile() && !ignoredFiles.has(path)) files.push(path);
  }
  return files.sort();
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function readJson(path: string): Promise<JsonRecord> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(value) ? value : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => null));
}

function launchArchetype(launchState: JsonRecord, features: JsonRecord): string {
  const archetype = stringField(launchState, "archetype")
    ?? stringField(recordField(features, "archetype"), "name")
    ?? "blank";
  if (!/^[a-z0-9-]+$/.test(archetype)) throw new Error(`invalid archetype: ${archetype}`);
  return archetype;
}

function recordField(value: unknown, key: string): JsonRecord {
  if (!isRecord(value)) return {};
  const field = value[key];
  return isRecord(field) ? field : {};
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

function optionalStringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" ? field.trim() : null;
}

function arrayField(value: unknown, key: string): string[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return [];
  return value[key].filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
