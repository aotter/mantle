/**
 * Shared provision-bundle renderer.
 *
 * validated provision bundle + explicit launch values
 *   -> deterministic text files + validated base64 binary files
 *
 * Its three callers are `mantle create` (writes a local directory),
 * `mantle-starters` (contributor preview and smoke tests), and
 * `mantle-landing` (commits a GitHub tree). It takes values and returns
 * values, reporting failures as stable neutral codes the hosts map to their
 * own error shapes, and holds no filesystem, process, git, GitHub, auth, or
 * deploy code.
 *
 * One exception is outstanding: `applyWrangler` rewrites a Cloudflare project
 * and D1 database name, because the shipped bundles hard-code those instead of
 * templating them. Removing it before the bundles change would only move the
 * same rewrite into all three hosts. It leaves once the starter templates those
 * fields — see aotter/mantle#705. Do not add a second host-shaped exception.
 */
import {
  canonicalizeLocaleList,
  ManifestLocaleTrimError,
  trimManifestLocales as trimLocales,
} from "@aotter/mantle-spec";

export const PROVISION_BUNDLE_KIND = "mantle-provision-bundle";

/** Stable across releases: hosts map these to their own error surfaces. */
export type ProvisionErrorCode =
  | "bundle_invalid"
  | "bundle_kind_mismatch"
  | "bundle_archetype_mismatch"
  | "bundle_too_large"
  | "binary_invalid"
  | "path_unsafe"
  | "path_collision"
  | "placeholder_unknown"
  | "placeholder_unresolved"
  | "launch_value_invalid"
  | "locale_unsupported"
  | "locale_catalog_invalid"
  | "manifest_invalid";

export class ProvisionRenderError extends Error {
  constructor(readonly code: ProvisionErrorCode, message: string) {
    super(message);
    this.name = "ProvisionRenderError";
  }
}

/** Bounds memory and disk before anything is materialized. */
export interface ProvisionLimits {
  readonly maxFiles: number;
  readonly maxTextBytes: number;
  readonly maxDecodedBinaryBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_PROVISION_LIMITS: ProvisionLimits = {
  maxFiles: 2_000,
  maxTextBytes: 2 * 1024 * 1024,
  maxDecodedBinaryBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

export interface ProvisionBundle {
  readonly kind?: string;
  readonly version?: string;
  readonly archetype?: string;
  readonly files?: Record<string, string>;
  readonly binaryFiles?: Record<string, string>;
  readonly localizedFiles?: readonly string[];
}

/**
 * Every placeholder a bundle may reference. A bundle placeholder outside this
 * set fails as `placeholder_unknown`. Hosts that do not own a value yet (a
 * local `create` has no GitHub owner) pass an empty string on purpose.
 */
export const PROVISION_PLACEHOLDERS = [
  "ADMIN_GITHUB_LOGIN",
  "AFTER_LAUNCH_SKILL_URL",
  "ARCHETYPE",
  "AUTH_MODE",
  "BRAND",
  "CANONICAL_LOCALE",
  "DESCRIPTION",
  "GITHUB_OWNER",
  "INSTALL_SUMMARY",
  "INSTALL_TIMESTAMP",
  "LOCALES",
  "PROJECT_NAME",
  "SITE_URL",
  "STARTER_REF",
  "TURNSTILE_SITE_KEY",
] as const;

export type ProvisionPlaceholder = (typeof PROVISION_PLACEHOLDERS)[number];

export interface LaunchValues {
  readonly archetype: string;
  readonly projectName: string;
  readonly brand: string;
  readonly description: string;
  readonly locales: readonly string[];
  readonly canonicalLocale: string;
  readonly authMode: string;
  readonly starterRef: string;
  /** ISO-8601. Passed in so one input set always renders one output set. */
  readonly installTimestamp: string;
  readonly siteUrl?: string;
  readonly githubOwner?: string;
  readonly adminGithubLogin?: string;
  readonly afterLaunchSkillUrl?: string;
  readonly installSummary?: string;
  readonly turnstileSiteKey?: string;
  /** Extra `[vars]` entries upserted into wrangler.toml (deployment facts). */
  readonly wranglerVars?: Readonly<Record<string, string>>;
}

export interface RenderProvisionBundleInput {
  readonly bundle: ProvisionBundle;
  readonly launch: LaunchValues;
  readonly limits?: ProvisionLimits;
}

export interface RenderedProject {
  /** Relative POSIX path -> file text. */
  readonly files: ReadonlyMap<string, string>;
  /** Relative POSIX path -> canonical base64. */
  readonly binaryFiles: ReadonlyMap<string, string>;
}

const TEXT_SUBSTITUTION_EXTENSIONS = new Set([
  "", ".css", ".html", ".json", ".md", ".mjs", ".sql", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
/**
 * In JSON and TS sources a placeholder sits inside a string literal, so its
 * value is escaped by default. Only the placeholders a bundle substitutes as
 * raw JSON are exempt — an allowlist, so a new placeholder is escaped unless
 * someone deliberately says otherwise.
 */
const RAW_JSON_PLACEHOLDERS = new Set(["LOCALES"]);
const MANIFEST_PATH = "manifests/site.yaml";
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const PLACEHOLDER_PATTERN = /\{\{([A-Z0-9_]+)\}\}/g;

const fail = (code: ProvisionErrorCode, message: string): never => {
  throw new ProvisionRenderError(code, message);
};

export function renderProvisionBundle(input: RenderProvisionBundleInput): RenderedProject {
  const limits = input.limits ?? DEFAULT_PROVISION_LIMITS;
  const launch = validateLaunchValues(input.launch);
  const bundle = validateBundle(input.bundle, launch.archetype, limits);

  const files = new Map<string, string>();
  const binaryFiles = new Map<string, string>();
  const claimed = new Map<string, string>();

  const claim = (rawPath: string): string => {
    const target = safeTarget(rawPath);
    const folded = target.toLowerCase();
    const previous = claimed.get(folded);
    if (previous !== undefined) {
      fail("path_collision", `${rawPath} collides with ${previous} after path normalization.`);
    }
    claimed.set(folded, rawPath);
    return target;
  };

  for (const [path, content] of Object.entries(bundle.files)) files.set(claim(path), content);
  for (const [path, content] of Object.entries(bundle.binaryFiles)) binaryFiles.set(claim(path), content);

  substitute(files, launch);
  assertLocalesSupported(bundle, launch);
  selectLocaleCatalogs(files, bundle.localizedFiles, launch);
  trimManifestLocales(files, launch.locales);
  applyWrangler(files, launch);
  // Limits are declared over what gets written. Measure the finished tree:
  // substitution expands, and locale, manifest, and wrangler transforms all
  // run after the input measurement in validateBundle.
  assertProjectSize(files, binaryFiles, limits);

  return { files, binaryFiles };
}

function assertProjectSize(
  files: Iterable<readonly [string, string]>,
  binaryFiles: Iterable<readonly [string, string]>,
  limits: ProvisionLimits,
): void {
  let total = 0;
  for (const [path, content] of files) {
    const bytes = utf8Length(content);
    if (bytes > limits.maxTextBytes) {
      fail("bundle_too_large", `${path} exceeds ${limits.maxTextBytes} bytes.`);
    }
    total += bytes;
  }
  for (const [path, content] of binaryFiles) {
    const bytes = decodedBase64Length(content);
    if (bytes > limits.maxDecodedBinaryBytes) {
      fail("bundle_too_large", `${path} decodes to more than ${limits.maxDecodedBinaryBytes} bytes.`);
    }
    total += bytes;
  }
  if (total > limits.maxTotalBytes) {
    fail("bundle_too_large", `the project is ${total} bytes; the limit is ${limits.maxTotalBytes}.`);
  }
}

// --- validation ------------------------------------------------------------

function validateLaunchValues(launch: LaunchValues): LaunchValues {
  if (!PROJECT_NAME_PATTERN.test(launch.projectName)) {
    fail("launch_value_invalid", "projectName must be lowercase letters, digits, and dashes (max 63 characters).");
  }
  if (!/^[a-z][a-z0-9-]*$/.test(launch.archetype)) fail("launch_value_invalid", "archetype must be a lowercase slug.");
  if (!/^[a-z][a-z0-9-]*$/.test(launch.authMode)) fail("launch_value_invalid", "authMode must be a lowercase slug.");
  if (launch.locales.length === 0) fail("launch_value_invalid", "at least one locale is required.");
  // Spec owns the locale grammar; do not grow a second one here.
  const { valid: locales, invalid } = canonicalizeLocaleList(launch.locales);
  if (invalid.length > 0) fail("launch_value_invalid", `unsupported locale: ${invalid.join(", ")}`);
  if (locales.length !== launch.locales.length) fail("launch_value_invalid", "locales contain a duplicate.");
  const canonical = canonicalizeLocaleList([launch.canonicalLocale]);
  if (canonical.invalid.length > 0) fail("launch_value_invalid", `unsupported locale: ${launch.canonicalLocale}`);
  const canonicalLocale = canonical.valid[0] ?? fail("launch_value_invalid", `unsupported locale: ${launch.canonicalLocale}`);
  if (!locales.includes(canonicalLocale)) fail("launch_value_invalid", "canonicalLocale is absent from locales.");
  if (!Number.isFinite(Date.parse(launch.installTimestamp))) {
    fail("launch_value_invalid", "installTimestamp must be an ISO-8601 timestamp.");
  }
  // Every value below is substituted into project files verbatim, so all of
  // them are checked — not only the ones with an obvious grammar. A newline
  // here becomes a new line of agent instructions or of wrangler config.
  for (const [name, value] of Object.entries(placeholderValues(launch))) {
    if (value.length > 500) fail("launch_value_invalid", `${name} must be at most 500 characters.`);
    if (CONTROL_CHARACTERS.test(value)) fail("launch_value_invalid", `${name} contains control characters.`);
  }
  for (const [name, value] of [["brand", launch.brand], ["description", launch.description]] as const) {
    if (value.length === 0) fail("launch_value_invalid", `${name} must not be empty.`);
  }
  for (const [name, value] of Object.entries(launch.wranglerVars ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) fail("launch_value_invalid", `wrangler var ${name} must be SCREAMING_SNAKE_CASE.`);
    if (value.length > 500) fail("launch_value_invalid", `wrangler var ${name} must be at most 500 characters.`);
    if (CONTROL_CHARACTERS.test(value)) fail("launch_value_invalid", `wrangler var ${name} must be a single line.`);
    if (value.includes('"')) fail("launch_value_invalid", `wrangler var ${name} must not contain a quote.`);
  }
  return { ...launch, locales, canonicalLocale };
}

function validateBundle(
  bundle: ProvisionBundle,
  archetype: string,
  limits: ProvisionLimits,
): ProvisionBundle & { readonly files: Record<string, string>; readonly binaryFiles: Record<string, string> } {
  if (bundle.kind !== PROVISION_BUNDLE_KIND) {
    fail("bundle_kind_mismatch", `bundle kind must be ${PROVISION_BUNDLE_KIND}; got ${String(bundle.kind)}.`);
  }
  if (typeof bundle.version !== "string" || bundle.version.length === 0) {
    fail("bundle_invalid", "bundle version is missing.");
  }
  if (bundle.archetype !== archetype) {
    fail("bundle_archetype_mismatch", `bundle is ${String(bundle.archetype)}, expected ${archetype}.`);
  }
  if (!isPlainRecord(bundle.files)) fail("bundle_invalid", "bundle files are missing.");
  if (bundle.binaryFiles !== undefined && !isPlainRecord(bundle.binaryFiles)) {
    fail("bundle_invalid", "bundle binaryFiles must be an object.");
  }

  const files = bundle.files as Record<string, string>;
  const binaryFiles = (bundle.binaryFiles ?? {}) as Record<string, string>;

  const count = Object.keys(files).length + Object.keys(binaryFiles).length;
  if (count > limits.maxFiles) fail("bundle_too_large", `bundle has ${count} files; the limit is ${limits.maxFiles}.`);

  const fileEntries = Object.entries(files);
  const binaryEntries = Object.entries(binaryFiles);
  for (const [path, content] of fileEntries) {
    if (typeof content !== "string") fail("bundle_invalid", `bundle file ${path} is not text.`);
  }
  for (const [path, content] of binaryEntries) {
    if (typeof content !== "string" || !isCanonicalBase64(content)) {
      fail("binary_invalid", `bundle binary file ${path} is not canonical base64.`);
    }
  }
  assertProjectSize(fileEntries, binaryEntries, limits);

  if (bundle.localizedFiles !== undefined) {
    if (!Array.isArray(bundle.localizedFiles)) fail("bundle_invalid", "localizedFiles must be an array.");
    for (const path of bundle.localizedFiles) {
      if (typeof path !== "string" || files[path] === undefined) {
        fail("bundle_invalid", `localizedFiles references a missing text file: ${String(path)}`);
      }
    }
  }
  return { ...bundle, files, binaryFiles };
}

/**
 * Normalizes both slash styles and rejects anything that could escape the
 * target. Returns the path a host will join onto its destination, so every
 * rule below runs on that final string — never on the raw bundle key.
 */
export function safeTarget(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) fail("path_unsafe", "bundle path is empty.");
  if (CONTROL_CHARACTERS.test(rawPath)) fail("path_unsafe", `bundle path contains control characters: ${JSON.stringify(rawPath)}`);
  if (/^[a-zA-Z]:/.test(rawPath)) fail("path_unsafe", `bundle path is a drive path: ${rawPath}`);
  if (rawPath.startsWith("\\\\")) fail("path_unsafe", `bundle path is a UNC path: ${rawPath}`);
  const normalized = rawPath.replace(/\\/g, "/");
  // `.template` marks a file the bundle renders through substitution. Strip it
  // BEFORE validating: `...template` would pass a segment check run on the raw
  // key and only then become `..`.
  const target = normalized.endsWith(".template") ? normalized.slice(0, -".template".length) : normalized;
  if (target.length === 0) fail("path_unsafe", `bundle path resolves to no file: ${rawPath}`);
  if (target.startsWith("/")) fail("path_unsafe", `bundle path is absolute: ${rawPath}`);
  const segments = target.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("path_unsafe", `bundle path has an empty, dot, or parent segment: ${rawPath}`);
  }
  return target;
}

// --- substitution ----------------------------------------------------------

function substitute(files: Map<string, string>, launch: LaunchValues): void {
  const values = placeholderValues(launch);
  for (const [path, content] of [...files]) {
    if (!shouldSubstitute(path)) {
      // A non-substituted file keeping a placeholder would ship a literal
      // `{{TOKEN}}` into the project; refuse rather than emit it.
      const leftover = new RegExp(PLACEHOLDER_PATTERN.source).exec(content);
      if (leftover) {
        fail("placeholder_unresolved", `${path} is not a substituted file type but contains ${leftover[0]}.`);
      }
      continue;
    }
    const jsonLike = /\.(?:json|[cm]?[jt]sx?)$/.test(path);
    const next = content.replace(new RegExp(PLACEHOLDER_PATTERN.source, "g"), (_match, key: string) => {
      if (!Object.hasOwn(values, key)) fail("placeholder_unknown", `${path} references unknown placeholder {{${key}}}.`);
      const value = values[key as ProvisionPlaceholder];
      return jsonLike && !RAW_JSON_PLACEHOLDERS.has(key)
        ? JSON.stringify(value).slice(1, -1)
        : value;
    });
    // No post-check here: every bundle-side token already went through the
    // callback above, so anything left can only have come from a launch value
    // (a brand may legitimately contain "{{...}}").
    files.set(path, next);
  }
}

function placeholderValues(launch: LaunchValues): Record<ProvisionPlaceholder, string> {
  return {
    ADMIN_GITHUB_LOGIN: launch.adminGithubLogin ?? "",
    AFTER_LAUNCH_SKILL_URL: launch.afterLaunchSkillUrl ?? "",
    ARCHETYPE: launch.archetype,
    AUTH_MODE: launch.authMode,
    BRAND: launch.brand,
    CANONICAL_LOCALE: launch.canonicalLocale,
    DESCRIPTION: launch.description,
    GITHUB_OWNER: launch.githubOwner ?? "",
    INSTALL_SUMMARY: launch.installSummary ?? launch.description,
    INSTALL_TIMESTAMP: launch.installTimestamp,
    LOCALES: JSON.stringify(launch.locales),
    PROJECT_NAME: launch.projectName,
    SITE_URL: launch.siteUrl ?? "",
    STARTER_REF: launch.starterRef,
    TURNSTILE_SITE_KEY: launch.turnstileSiteKey ?? "",
  };
}

function shouldSubstitute(path: string): boolean {
  let basename = path.split("/").pop() ?? path;
  // A sample file is text by definition (`.dev.vars.example`, `.env.example`).
  if (basename.endsWith(".example")) return true;
  // A leading dot names the file, it does not start an extension: `.gitignore`
  // and `.npmrc` are extensionless text, not files of type `.gitignore`.
  if (basename.startsWith(".")) basename = basename.slice(1);
  const dot = basename.lastIndexOf(".");
  return TEXT_SUBSTITUTION_EXTENSIONS.has(dot === -1 ? "" : basename.slice(dot));
}

// --- locales ---------------------------------------------------------------

function assertLocalesSupported(bundle: ProvisionBundle, launch: LaunchValues): void {
  const seed = `.mantle/overlays/${launch.archetype}/seed.json`;
  const localizable = launch.archetype === "blank" || (bundle.localizedFiles ?? []).includes(seed);
  if (localizable) return;
  const unsupported = launch.locales.filter((locale) => locale !== "en");
  if (unsupported.length > 0) {
    fail("locale_unsupported", `${launch.archetype} does not support locales: ${unsupported.join(", ")}`);
  }
}

function selectLocaleCatalogs(
  files: Map<string, string>,
  localizedFiles: readonly string[] | undefined,
  launch: LaunchValues,
): void {
  for (const rawPath of localizedFiles ?? []) {
    const path = safeTarget(rawPath);
    const text = files.get(path);
    if (text === undefined) fail("locale_catalog_invalid", `localized file is absent: ${path}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text as string);
    } catch {
      return fail("locale_catalog_invalid", `localized file is not valid JSON: ${path}`);
    }
    if (!isPlainRecord(parsed)) fail("locale_catalog_invalid", `localized file is not a JSON object: ${path}`);
    const value = parsed as { locales?: unknown };
    if (!isPlainRecord(value.locales)) fail("locale_catalog_invalid", `localized file has no locale catalog: ${path}`);
    const available = value.locales as Record<string, unknown>;
    const missing = launch.locales.filter((locale) => !(locale in available));
    if (missing.length > 0) fail("locale_unsupported", `${path} does not support locales: ${missing.join(", ")}`);
    value.locales = Object.fromEntries(launch.locales.map((locale) => [locale, available[locale]]));
    files.set(path, `${JSON.stringify(value, null, 2)}\n`);
  }
}

function trimManifestLocales(files: Map<string, string>, locales: readonly string[]): void {
  const text = files.get(MANIFEST_PATH);
  if (text === undefined) return;
  try {
    files.set(MANIFEST_PATH, trimLocales(text, locales));
  } catch (error) {
    if (!(error instanceof ManifestLocaleTrimError)) throw error;
    fail(
      error.reason === "invalid_yaml" ? "manifest_invalid" : "locale_unsupported",
      `${MANIFEST_PATH}: ${error.message}`,
    );
  }
}

// --- wrangler --------------------------------------------------------------

/**
 * The bundle ships a starter-shaped `wrangler.toml`; the project name, its D1
 * database name, and any host-supplied `[vars]` are the only parts a caller
 * must rewrite. Everything else stays exactly as the starter authored it.
 */
function applyWrangler(files: Map<string, string>, launch: LaunchValues): void {
  const text = files.get("wrangler.toml");
  if (text === undefined) return;
  const envStart = text.search(/\n\[env\./);
  const head = envStart === -1 ? text : text.slice(0, envStart);
  const tail = envStart === -1 ? "" : text.slice(envStart);
  let next = head
    .replace(/^name = ".*"$/m, `name = ${JSON.stringify(launch.projectName)}`)
    .replace(/^database_name = ".*"$/m, `database_name = ${JSON.stringify(`${launch.projectName}-db`)}`);
  for (const [name, value] of Object.entries(launch.wranglerVars ?? {})) {
    next = upsertWranglerVar(next, name, value);
  }
  files.set("wrangler.toml", `${next}${tail}`);
}

export function upsertWranglerVar(text: string, name: string, value: string): string {
  const line = `${name} = ${JSON.stringify(value)}`;
  const existing = new RegExp(`^\\s*#?\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*$`, "m");
  // Replacer function, not a string: a `$&` in the value must stay literal.
  if (existing.test(text)) return text.replace(existing, () => line);
  const vars = /^\[vars\]\s*$/m.exec(text);
  if (!vars || vars.index === undefined) return `${text.trimEnd()}\n\n[vars]\n${line}\n`;
  const insertAt = vars.index + vars[0].length;
  return `${text.slice(0, insertAt)}\n${line}${text.slice(insertAt)}`;
}

// --- small helpers ---------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
}

function decodedBase64Length(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}
