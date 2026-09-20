import { DEFAULT_SITE_ICONS, type MediaPurposePolicy, type SiteConfig, type SiteDefaults } from "@aotter/mantle-spec";
import type {
  SiteConfigRepository,
  UpdateEditableSiteConfigArgs,
} from "../../src/domain/port/SiteConfigRepository.js";

/** Minimal `SiteConfigRepository` for tests. Holds `mediaPurposes` in
 *  memory — tests can hand a custom set or leave it empty to exercise
 *  fail-closed paths. Accepts either the older string-only shape (auto-
 *  upgraded to a default-policy object) or full `MediaPurposePolicy`
 *  objects (#272) directly. */
export class InMemorySiteConfigRepository implements SiteConfigRepository {
  private purposes: readonly MediaPurposePolicy[];

  constructor(input: ReadonlyArray<string | MediaPurposePolicy> = []) {
    this.purposes = input.map((p) =>
      typeof p === "string" ? defaultPolicyForName(p) : p,
    );
  }

  async seed(_defaults: SiteDefaults | undefined): Promise<void> {
    /* noop */
  }

  async load(): Promise<SiteConfig> {
    return {
      title: "Test",
      description: "",
      origin: "",
      locales: [],
      canonicalLocale: null,
      brand: "Test",
      icons: DEFAULT_SITE_ICONS,
      media: { purposes: this.purposes },
    };
  }

  async updateEditable(_args: UpdateEditableSiteConfigArgs): Promise<void> {
    /* noop */
  }

  async readLocales(): Promise<readonly string[]> {
    return [];
  }

  async readMediaPurposes(): Promise<readonly MediaPurposePolicy[]> {
    return this.purposes;
  }

  setPurposes(input: ReadonlyArray<string | MediaPurposePolicy>): void {
    this.purposes = input.map((p) =>
      typeof p === "string" ? defaultPolicyForName(p) : p,
    );
  }
}

/** Default policy for tests that only care about the purpose name —
 *  three-format requirement (avif/webp/jpeg) with generous byte caps
 *  that also cover the legacy allowlist mimes. Tests pinning specific
 *  caps should hand a full policy object instead. */
function defaultPolicyForName(name: string): MediaPurposePolicy {
  return {
    name,
    required: ["image/avif", "image/webp", "image/jpeg"],
    maxBytes: {
      "image/avif": 1_000_000,
      "image/webp": 1_000_000,
      "image/jpeg": 1_000_000,
      "image/png": 1_000_000,
      "image/gif": 1_000_000,
      "image/svg+xml": 1_000_000,
    },
  };
}
