import {
  assertSiteDefaultsCanonical,
  type MediaPurposePolicy,
  type SiteConfig,
  type SiteDefaults,
  type SiteIcon,
} from "@aotter/mantle-spec";
import type {
  SiteConfigRepository,
  UpdateEditableSiteConfigArgs,
} from "@aotter/mantle-runtime";
import { z } from "zod";
import { requestDiagnosticContext, type CatalogSource } from "../requestDiagnostics.js";

const SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_AGE_MS = 3_600_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_PUT_BACKOFF_MS = 60_000;
const SCOPE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export type McpCatalogSiteConfig = Pick<
  SiteConfig,
  "origin" | "brand" | "description" | "icons" | "media"
>;

export interface McpCatalogKvBinding {
  readonly namespace: KVNamespace;
  /** Stable deployment-owned scope. Never derive this from a request. */
  readonly scope: string;
}

export interface McpCatalogSiteConfigReader {
  /** Resolve caller-independent catalog data after the transport auth gate. */
  loadCatalogSite(runtime: object): Promise<McpCatalogSiteConfig>;
}

interface CatalogSnapshotV1 {
  readonly version: 1;
  readonly scope: string;
  readonly observedAt: number;
  readonly repairAfter: number;
  readonly contentHash: string;
  readonly site: McpCatalogSiteConfig;
}

const snapshotSchema = z.strictObject({
  version: z.literal(SNAPSHOT_VERSION),
  scope: z.string(),
  observedAt: z.number().int().nonnegative(),
  repairAfter: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  site: z.strictObject({
    origin: z.string(),
    brand: z.string(),
    description: z.string(),
    icons: z.array(z.strictObject({
      src: z.string(),
      mimeType: z.enum(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]).optional(),
      sizes: z.array(z.string()).optional(),
      theme: z.enum(["light", "dark"]).optional(),
    })),
    media: z.strictObject({
      purposes: z.array(z.strictObject({
        name: z.string(),
        required: z.array(z.string()),
        maxBytes: z.record(z.string(), z.number().positive()),
      })),
    }),
  }),
});

interface InFlightCatalogLoad {
  readonly generation: number;
  readonly observation: { source: CatalogSource };
  readonly promise: Promise<McpCatalogSiteConfig>;
}

/**
 * Cloudflare-owned write-through decorator for MCP catalog configuration.
 * The delegate remains canonical: ordinary repository reads always hit D1,
 * while only the caller-independent MCP projection is stored in KV.
 */
export class KvSiteConfigRepository
  implements SiteConfigRepository, McpCatalogSiteConfigReader {
  readonly key: string;
  private readonly inFlight = new WeakMap<object, InFlightCatalogLoad>();
  private generation = 0;
  private lastKnownSnapshot: CatalogSnapshotV1 | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private putFailureCount = 0;
  private putBackoffUntil = 0;
  private readonly diagnosticCounts = new Map<string, number>();

  constructor(
    private readonly canonical: SiteConfigRepository,
    private readonly binding: McpCatalogKvBinding,
  ) {
    if (!SCOPE_PATTERN.test(binding.scope)) {
      throw new Error(
        "Mantle MCP catalog KV scope must contain 1-64 ASCII letters, digits, '_' or '-'.",
      );
    }
    this.key = `mantle:${binding.scope}:site-config:v1:mcp`;
  }

  load(): Promise<SiteConfig> {
    return this.canonical.load();
  }

  readLocales(): Promise<readonly string[]> {
    return this.canonical.readLocales();
  }

  readMediaPurposes(): Promise<readonly MediaPurposePolicy[]> {
    return this.canonical.readMediaPurposes();
  }

  async seed(defaults: SiteDefaults | undefined): Promise<void> {
    // Invalidate pre-mutation reads now, and reads started during the write
    // again after commit. Neither may repopulate the local snapshot later.
    this.generation += 1;
    await this.exclusive(async () => {
      await this.canonical.seed(defaults);
      this.generation += 1;
      await this.publishAfterCommittedWrite("seed");
    });
  }

  async updateEditable(values: UpdateEditableSiteConfigArgs): Promise<void> {
    if (!this.canonical.updateEditable) {
      throw new Error("SiteConfigRepository.updateEditable is unavailable");
    }
    this.generation += 1;
    await this.exclusive(async () => {
      await this.canonical.updateEditable!(values);
      this.generation += 1;
      await this.publishAfterCommittedWrite("update");
    });
  }

  loadCatalogSite(runtime: object): Promise<McpCatalogSiteConfig> {
    const generation = this.generation;
    let flight = this.inFlight.get(runtime);
    const record = requestDiagnosticContext.getStore();
    const sharedWait = flight?.generation === generation;
    const started = record && sharedWait ? performance.now() : null;
    if (!sharedWait) {
      const observation: { source: CatalogSource } = { source: "not-reached" };
      const pending = this.readCatalogSite(generation, observation).finally(() => {
        if (this.inFlight.get(runtime)?.promise === pending) this.inFlight.delete(runtime);
      });
      flight = { generation, observation, promise: pending };
      this.inFlight.set(runtime, flight);
    }
    const selected = flight!;
    if (!record) return selected.promise;
    return selected.promise.finally(() => {
      record.catalog.source = selected.observation.source;
      record.catalog.sharedWait ||= sharedWait;
      if (started !== null) record.catalog.waitMs = (record.catalog.waitMs ?? 0) + performance.now() - started;
    });
  }

  private async readCatalogSite(generation: number, observation: { source: CatalogSource }): Promise<McpCatalogSiteConfig> {
    let raw: string | null = null;
    let kvFailed = false;
    try {
      raw = await this.binding.namespace.get(this.key, "text");
    } catch (error) {
      kvFailed = true;
      this.diagnostic("get-failed", error);
    }
    if (raw !== null) {
      const snapshot = await parseSnapshot(raw, this.binding.scope, Date.now());
      if (snapshot && generation === this.generation) {
        this.lastKnownSnapshot = snapshot;
        observation.source = "kv-hit";
        return snapshot.site;
      }
    }
    observation.source = kvFailed ? "d1-kv-error" : raw === null ? "d1-miss" : "d1-repair";
    return this.repairCatalogSite();
  }

  private repairCatalogSite(): Promise<McpCatalogSiteConfig> {
    // Serialize miss fill with local setting mutations. Every publication
    // reloads canonical state inside the same critical section, so an older
    // local miss cannot overwrite a newer local write-through publication.
    return this.exclusive(async () => {
      const snapshot = await this.loadCanonicalSnapshot();
      await this.putSnapshot(snapshot, true);
      return snapshot.site;
    });
  }

  private async publishAfterCommittedWrite(reason: "seed" | "update"): Promise<void> {
    const record = requestDiagnosticContext.getStore();
    if (reason === "seed" && record) record.catalog.bootPublications++;
    try {
      const snapshot = await this.loadCanonicalSnapshot();
      await this.putSnapshot(snapshot);
    } catch (error) {
      // D1 already committed. Derived-cache repair must never turn a saved
      // setting into a misleading failure or suppress the public-cache purge.
      this.diagnostic(`${reason}-publication-failed`, error);
    }
  }

  private async loadCanonicalSnapshot(): Promise<CatalogSnapshotV1> {
    // Anchor freshness before the canonical read. A delayed load cannot gain
    // a fresh lifetime merely because serialization or KV put completed later.
    const observedAt = Date.now();
    const site = normalizeCatalogSite(await this.canonical.load());
    return {
      version: SNAPSHOT_VERSION,
      scope: this.binding.scope,
      observedAt,
      repairAfter: observedAt + MAX_SNAPSHOT_AGE_MS,
      contentHash: await contentHash(site),
      site,
    };
  }

  private async putSnapshot(snapshot: CatalogSnapshotV1, force = false): Promise<void> {
    const now = Date.now();
    // KV requires at least 60 seconds of remaining lifetime. Do not extend
    // an old observation just to satisfy the platform's expiration minimum.
    if (snapshot.repairAfter < now + 60_000 || now < this.putBackoffUntil) return;
    if (
      !force
      && this.lastKnownSnapshot?.contentHash === snapshot.contentHash
      && isSnapshotFresh(this.lastKnownSnapshot, now)
    ) return;
    const value = JSON.stringify(snapshot);
    const bytes = utf8Bytes(value);
    if (bytes > MAX_ENVELOPE_BYTES) {
      this.diagnostic("oversized", { bytes, limit: MAX_ENVELOPE_BYTES });
      return;
    }
    try {
      await this.binding.namespace.put(this.key, value, {
        expiration: Math.ceil(snapshot.repairAfter / 1000),
      });
      this.lastKnownSnapshot = snapshot;
      this.putFailureCount = 0;
      this.putBackoffUntil = 0;
    } catch (error) {
      this.putFailureCount += 1;
      this.putBackoffUntil = now + Math.min(
        MAX_PUT_BACKOFF_MS,
        1_000 * (2 ** Math.min(this.putFailureCount - 1, 6)),
      );
      this.diagnostic("put-failed", error);
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private diagnostic(kind: string, detail: unknown): void {
    const count = (this.diagnosticCounts.get(kind) ?? 0) + 1;
    this.diagnosticCounts.set(kind, count);
    // Bound repeated outage logs to the first occurrence and powers of two.
    if (count !== 1 && (count & (count - 1)) !== 0) return;
    const safeDetail = isRecord(detail) && typeof detail["bytes"] === "number"
      ? { bytes: detail["bytes"], limit: detail["limit"] }
      : detail instanceof Error
        ? { name: detail.name }
        : undefined;
    console.warn("[mantle] MCP catalog KV diagnostic", {
      kind,
      count,
      ...(safeDetail ? { detail: safeDetail } : {}),
    });
  }
}

function normalizeCatalogSite(site: McpCatalogSiteConfig): McpCatalogSiteConfig {
  return {
    origin: site.origin,
    brand: site.brand,
    description: site.description,
    icons: site.icons.map(normalizeIcon),
    media: {
      purposes: site.media.purposes.map((purpose) => ({
        name: purpose.name,
        required: [...purpose.required],
        maxBytes: Object.fromEntries(
          Object.entries(purpose.maxBytes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
        ),
      })),
    },
  };
}

function normalizeIcon(icon: SiteIcon): SiteIcon {
  return {
    src: icon.src,
    ...(icon.mimeType ? { mimeType: icon.mimeType } : {}),
    ...(icon.sizes ? { sizes: [...icon.sizes] } : {}),
    ...(icon.theme ? { theme: icon.theme } : {}),
  };
}

async function parseSnapshot(
  raw: string,
  scope: string,
  now: number,
): Promise<CatalogSnapshotV1 | null> {
  if (utf8Bytes(raw) > MAX_ENVELOPE_BYTES) return null;
  let snapshot: CatalogSnapshotV1;
  try {
    const parsed = snapshotSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    snapshot = parsed.data;
    assertSiteDefaultsCanonical(snapshot.site);
  } catch {
    return null;
  }
  if (snapshot.scope !== scope || !isSnapshotFresh(snapshot, now)) return null;
  const site = normalizeCatalogSite(snapshot.site);
  if (await contentHash(site) !== snapshot.contentHash) return null;
  return { ...snapshot, site };
}

function isSnapshotFresh(
  value: Pick<CatalogSnapshotV1, "observedAt" | "repairAfter">,
  now: number,
): boolean {
  return value.observedAt <= now + MAX_FUTURE_SKEW_MS
    && value.repairAfter > value.observedAt
    && value.repairAfter - value.observedAt <= MAX_SNAPSHOT_AGE_MS
    && value.repairAfter > now;
}

async function contentHash(site: McpCatalogSiteConfig): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(site)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
