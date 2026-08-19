import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, posix, resolve } from "node:path";
import { cwd, stderr, stdout } from "node:process";
import { parseArgs } from "node:util";
import { safeTarget } from "./provision.js";

const REPORT_PATH = ".mantle/update-report.json";
const IGNORE_DIRS = new Set([".git", "node_modules", ".wrangler", ".wrangler-test", "dist"]);
const IGNORE_FILES = new Set([".mantle/features.json", ".mantle/launch-state.json", REPORT_PATH]);

type JsonRecord = Record<string, unknown>;
type Snapshot = ReadonlyMap<string, string>;

interface ProvisionBundle {
  readonly version?: string;
  readonly files: Readonly<Record<string, string>>;
}

export async function runUpdate(rawArgs: readonly string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...rawArgs],
      options: {
        ref: { type: "string" },
        "bundle-base-url": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    stderr.write(`${message(error)}\n`);
    return 2;
  }
  if (values.help) {
    printHelp();
    return 0;
  }

  const root = cwd();
  try {
    const launchState = readJson(join(root, ".mantle", "launch-state.json"));
    const features = readJson(join(root, ".mantle", "features.json"));
    const registry = recordField(features, "registry");
    const sourceRef = stringField(launchState, "starter_ref");
    const targetRef = values.ref ?? stringField(registry, "version");
    const bundleBaseUrl = values["bundle-base-url"] ?? stringField(registry, "bundleBaseUrl");
    if (!sourceRef) throw new UsageError(".mantle/launch-state.json is missing starter_ref");
    if (!targetRef) throw new UsageError("pass --ref or configure registry.version");
    if (!bundleBaseUrl) {
      throw new UsageError("pass --bundle-base-url or configure registry.bundleBaseUrl");
    }
    if (!bundleBaseUrl.includes("{ref}")) {
      throw new UsageError("bundle base URL must contain {ref}");
    }

    const archetype = launchArchetype(launchState, features);
    const sourceBundle = await fetchBundle(bundleBaseUrl, sourceRef, archetype);
    const targetBundle = sourceRef === targetRef
      ? sourceBundle
      : await fetchBundle(bundleBaseUrl, targetRef, archetype);
    const timestamp = new Date().toISOString();
    const turnstileSiteKey = optionalStringField(launchState, "turnstile_site_key")
      ?? readWranglerStringVar(root, "TURNSTILE_SITE_KEY")
      ?? "";
    const source = materializeBundle(
      sourceBundle,
      placeholders(launchState, archetype, sourceRef, timestamp, turnstileSiteKey),
    );
    const target = materializeBundle(
      targetBundle,
      placeholders(launchState, archetype, targetRef, timestamp, turnstileSiteKey),
    );
    const upstream = compareSnapshots(source, target);
    const local = compareProject(root, source);
    const report = {
      schema_version: 3,
      generated_at: timestamp,
      source_ref: sourceRef,
      target_ref: targetRef,
      bundle_base_url: bundleBaseUrl,
      bundle_version: targetBundle.version ?? null,
      upstream,
      local,
      metadata_migration: metadataMigration(sourceRef, targetRef, bundleBaseUrl, registry),
      next_step:
        "Port reviewed upstream changes only, then apply the reported metadata migration while preserving all other instance state.",
    };
    writeReport(root, `${JSON.stringify(report, null, 2)}\n`);
    stdout.write(`mantle update report: ${REPORT_PATH}\n`);
    stdout.write(
      `${sourceRef} → ${targetRef}: ${upstream.counts.differing} changed, `
      + `${upstream.counts.missing_current} added, ${upstream.counts.removed_upstream} removed; `
      + `local: ${local.counts.differing} modified, ${local.counts.missing_current} missing, `
      + `${local.counts.removed_upstream} project-only\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(`mantle update: ${message(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

function printHelp(): void {
  stdout.write(`mantle update — compare this site with another provision bundle

Usage: mantle update [options]

Options:
  --ref <ref>              Target immutable starter ref; defaults to registry.version
  --bundle-base-url <url>  Bundle root containing {ref}; defaults to registry.bundleBaseUrl
  -h, --help               This help
`);
}

async function fetchBundle(
  baseTemplate: string,
  ref: string,
  archetype: string,
): Promise<ProvisionBundle> {
  let lastUrl = "";
  let lastStatus = 404;
  for (const candidate of bundleRefCandidates(ref)) {
    const base = baseTemplate.replaceAll("{ref}", encodeURIComponent(candidate)).replace(/\/+$/, "");
    const url = new URL(`${base}/${encodeURIComponent(archetype)}.json`);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("bundle base URL must use http or https");
    }
    lastUrl = url.toString();
    const response = await fetch(url, { headers: { accept: "application/json" } });
    lastStatus = response.status;
    if (!response.ok && response.status === 404) continue;
    if (!response.ok) throw new Error(`failed to fetch ${url}: HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!isRecord(value) || !isStringRecord(value.files)) {
      throw new Error(`invalid provision bundle at ${url}`);
    }
    if (typeof value.archetype === "string" && value.archetype !== archetype) {
      throw new Error(`provision bundle at ${url} is ${value.archetype}, expected ${archetype}`);
    }
    return {
      version: typeof value.version === "string" ? value.version : undefined,
      files: value.files,
    };
  }
  throw new Error(`failed to fetch ${lastUrl}: HTTP ${lastStatus}`);
}

function bundleRefCandidates(ref: string): readonly string[] {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(ref) ? [ref, `v${ref}`] : [ref];
}

function materializeBundle(
  bundle: ProvisionBundle,
  values: Readonly<Record<string, string>>,
): Snapshot {
  const files = new Map<string, string>();
  for (const [sourcePath, source] of Object.entries(bundle.files).sort(([a], [b]) => a.localeCompare(b))) {
    const path = safeTarget(sourcePath);
    if (files.has(path)) throw new Error(`duplicate provision bundle path: ${path}`);
    let text = substitute(source, values);
    if (path === "wrangler.toml") text = materializeLegacyWranglerToml(text, values);
    files.set(path, text);
  }
  return files;
}

function substitute(source: string, values: Readonly<Record<string, string>>): string {
  return source.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (token, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`unknown provision placeholder ${token}`);
    return value;
  });
}

function materializeLegacyWranglerToml(
  text: string,
  values: Readonly<Record<string, string>>,
): string {
  const envStart = text.search(/\n\[env\./);
  const tail = envStart === -1 ? "" : text.slice(envStart);
  let head = envStart === -1 ? text : text.slice(0, envStart);
  head = head.replace(/^name = ".*"$/m, `name = ${JSON.stringify(values.PROJECT_NAME)}`);
  head = head.replace(
    /^database_name = ".*"$/m,
    `database_name = ${JSON.stringify(`${values.PROJECT_NAME}-db`)}`,
  );
  head = upsertWranglerStringVar(head, "PUBLIC_ORIGIN", values.SITE_URL ?? "");
  if (values.TURNSTILE_SITE_KEY?.trim()) {
    head = upsertWranglerStringVar(head, "TURNSTILE_SITE_KEY", values.TURNSTILE_SITE_KEY.trim());
  }
  return `${head}${tail}`;
}

function upsertWranglerStringVar(text: string, name: string, value: string): string {
  const line = `${name} = ${JSON.stringify(value)}`;
  const existing = new RegExp(`^\\s*#?\\s*${escapeRegExp(name)}\\s*=.*$`, "m");
  if (existing.test(text)) return text.replace(existing, line);
  const vars = text.match(/^\[vars\]\s*$/m);
  if (!vars || vars.index === undefined) return `${text.trimEnd()}\n\n[vars]\n${line}\n`;
  const index = vars.index + vars[0].length;
  return `${text.slice(0, index)}\n${line}${text.slice(index)}`;
}

function readWranglerStringVar(root: string, name: string): string | null {
  const path = join(root, "wrangler.toml");
  if (!existsSync(path) || !lstatSync(path).isFile()) return null;
  const source = readFileSync(path, "utf8");
  const match = source.match(
    new RegExp(`^\\s*${escapeRegExp(name)}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m"),
  );
  if (!match?.[1]) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    return typeof value === "string" ? value.trim() : null;
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function placeholders(
  launchState: JsonRecord,
  archetype: string,
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
  const siteUrl = stringField(launchState, "site_url") ?? "https://example.com";
  const locale = stringField(launchState, "canonical_locale") ?? locales[0] ?? "en";
  const description = stringField(launchState, "description")
    ?? stringField(launchState, "purpose")
    ?? `${projectName} site.`;
  return {
    PROJECT_NAME: projectName,
    ARCHETYPE: archetype,
    BRAND: stringField(launchState, "brand") ?? projectName,
    DESCRIPTION: description,
    INSTALL_SUMMARY: stringField(launchState, "summary") ?? description,
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
    TURNSTILE_SITE_KEY: turnstileSiteKey,
    AFTER_LAUNCH_SKILL_URL: stringField(launchState, "after_launch_skill_url") ?? "",
    INSTALL_TIMESTAMP: timestamp,
  };
}

interface DiffReport {
  readonly counts: {
    readonly differing: number;
    readonly missing_current: number;
    readonly removed_upstream: number;
  };
  readonly differing: readonly JsonRecord[];
  readonly missing_current: readonly JsonRecord[];
  readonly removed_upstream: readonly JsonRecord[];
}

function compareSnapshots(current: Snapshot, upstream: Snapshot): DiffReport {
  const differing: JsonRecord[] = [];
  const missingCurrent: JsonRecord[] = [];
  for (const [path, source] of [...upstream].sort(([a], [b]) => a.localeCompare(b))) {
    if (IGNORE_FILES.has(path)) continue;
    const existing = current.get(path);
    if (existing === undefined) missingCurrent.push({ path, upstream_sha256: sha256(source) });
    else if (existing !== source) {
      differing.push({ path, current_sha256: sha256(existing), upstream_sha256: sha256(source) });
    }
  }
  const removedUpstream = [...current]
    .filter(([path]) => !IGNORE_FILES.has(path) && !upstream.has(path))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, source]) => ({ path, current_sha256: sha256(source) }));
  return diffReport(differing, missingCurrent, removedUpstream);
}

function compareProject(root: string, upstream: Snapshot): DiffReport {
  const differing: JsonRecord[] = [];
  const missingCurrent: JsonRecord[] = [];
  for (const [path, source] of [...upstream].sort(([a], [b]) => a.localeCompare(b))) {
    if (IGNORE_FILES.has(path)) continue;
    const currentPath = join(root, path);
    if (!existsSync(currentPath) || !lstatSync(currentPath).isFile()) {
      missingCurrent.push({ path, upstream_sha256: sha256(source) });
      continue;
    }
    const current = readFileSync(currentPath);
    if (sha256(current) !== sha256(source)) {
      differing.push({ path, current_sha256: sha256(current), upstream_sha256: sha256(source) });
    }
  }
  const removedUpstream = listProjectFiles(root)
    .filter((path) => !upstream.has(path))
    .map((path) => ({ path, current_sha256: sha256(readFileSync(join(root, path))) }));
  return diffReport(differing, missingCurrent, removedUpstream);
}

function listProjectFiles(root: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listProjectFiles(root, path));
    else if (entry.isFile() && !IGNORE_FILES.has(path)) files.push(path);
  }
  return files.sort();
}

function diffReport(
  differing: readonly JsonRecord[],
  missingCurrent: readonly JsonRecord[],
  removedUpstream: readonly JsonRecord[],
): DiffReport {
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

function metadataMigration(
  sourceRef: string,
  targetRef: string,
  bundleBaseUrl: string,
  registry: JsonRecord,
): JsonRecord {
  return {
    required: sourceRef !== targetRef
      || stringField(registry, "version") !== targetRef
      || stringField(registry, "bundleBaseUrl") !== bundleBaseUrl,
    apply_after_reviewed_port: true,
    files: [
      {
        path: ".mantle/launch-state.json",
        set: { starter_ref: targetRef },
      },
      {
        path: ".mantle/features.json",
        set: {
          "registry.version": targetRef,
          "registry.bundleBaseUrl": bundleBaseUrl,
        },
      },
    ],
  };
}

function writeReport(root: string, source: string): void {
  const directory = join(root, ".mantle");
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
    throw new Error(".mantle must be a real directory");
  }
  const path = join(root, REPORT_PATH);
  if (existsSync(path) && !lstatSync(path).isFile()) {
    throw new Error(`${REPORT_PATH} must be a regular file`);
  }
  writeFileSync(path, source, "utf8");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path: string): JsonRecord {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isRecord(value) ? value : {};
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
  return isRecord(value[key]) ? value[key] : {};
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

class UsageError extends Error {}
