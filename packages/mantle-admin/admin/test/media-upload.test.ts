import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/api";
import type { MediaPurposePolicy } from "../src/lib/types";
import { selectPurpose } from "../src/features/media/media-upload";
import { isMediaNotConfigured } from "../src/features/media/media-library-view";

describe("media setup state", () => {
  it("only treats the explicit missing-storage diagnostic as setup work", () => {
    expect(isMediaNotConfigured(new ApiError("501", 501, {
      diagnostic: { code: "MEDIA_NOT_CONFIGURED" },
    }))).toBe(true);
    expect(isMediaNotConfigured(new ApiError("503", 503, {
      diagnostic: { code: "MEDIA_NOT_CONFIGURED" },
    }))).toBe(false);
  });
});

function fakeCanvas(supportedMimes: ReadonlySet<string>): {
  toBlob: (cb: (blob: Blob | null) => void, mimeType?: string) => void;
  width: number;
  height: number;
  getContext: () => unknown;
} {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toBlob(cb: (blob: Blob | null) => void, mimeType?: string) {
      const requested = mimeType ?? "image/png";
      const actual = supportedMimes.has(requested) ? requested : "image/png";
      cb(new Blob([new Uint8Array([1, 2, 3])], { type: actual }));
    },
  };
}

function stubDocument(supportedMimes: ReadonlySet<string>): void {
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error(`unexpected createElement(${tag})`);
      return fakeCanvas(supportedMimes);
    },
  });
}

function policy(maxBytes: Record<string, number>): MediaPurposePolicy {
  return { name: "content", required: [], maxBytes };
}

describe("chooseMime", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips a declared-but-unencodable mime and picks the next encodable alternative", async () => {
    stubDocument(new Set(["image/webp"]));
    const { chooseMime } = await import("../src/features/media/media-upload");
    const mime = await chooseMime(
      ["image/avif", "image/webp"],
      policy({ "image/avif": 200_000, "image/webp": 200_000 }),
      "en",
    );
    expect(mime).toBe("image/webp");
  });

  it("throws a localized, diagnostics-friendly error when no mime in the slot is encodable", async () => {
    stubDocument(new Set()); // encoder supports nothing requested
    const { chooseMime } = await import("../src/features/media/media-upload");
    await expect(
      chooseMime(["image/avif"], policy({ "image/avif": 200_000 }), "en"),
    ).rejects.toThrow(/cannot produce.*image\/avif/);
    await (await import("../src/app/i18n")).loadLanguage("zh-TW");
    await expect(chooseMime(["image/avif"], policy({ "image/avif": 200_000 }), "zh-TW"))
      .rejects.toThrow(/瀏覽器無法產生.*image\/avif/);
  });

  it("reports the mime that has maxBytes-but-no-encoder, not just the slot's first entry", async () => {
    stubDocument(new Set()); // neither alternative is encodable
    const { chooseMime } = await import("../src/features/media/media-upload");
    await expect(
      chooseMime(
        ["image/jxl", "image/avif"],
        policy({ "image/jxl": 100, "image/avif": 200_000 }),
        "en",
      ),
    ).rejects.toThrow(/cannot produce.*image\/jxl/);
  });

  it("never selects a mime the policy has no maxBytes for, even if encodable", async () => {
    stubDocument(new Set(["image/avif", "image/webp"]));
    const { chooseMime } = await import("../src/features/media/media-upload");
    const mime = await chooseMime(
      ["image/avif", "image/webp"],
      policy({ "image/webp": 200_000 }), // no maxBytes entry for avif
      "en",
    );
    expect(mime).toBe("image/webp");
  });
});

describe("encodeBitmap", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const bitmap = { width: 10, height: 10, close: () => {} } as unknown as ImageBitmap;

  it("bails on the first toBlob mismatch instead of looping 6 scales x 4 qualities", async () => {
    stubDocument(new Set()); // every toBlob call falls back to image/png
    let calls = 0;
    vi.stubGlobal("document", {
      createElement: (tag: string) => {
        if (tag !== "canvas") throw new Error(`unexpected createElement(${tag})`);
        const canvas = fakeCanvas(new Set());
        const original = canvas.toBlob.bind(canvas);
        canvas.toBlob = (cb, mimeType) => {
          calls += 1;
          original(cb, mimeType);
        };
        return canvas;
      },
    });
    const { encodeBitmap } = await import("../src/features/media/media-upload");
    await expect(encodeBitmap(bitmap, "image/avif", 200_000, "en")).rejects.toThrow(
      /cannot produce.*image\/avif/,
    );
    expect(calls).toBe(1);
  });

  it("succeeds immediately when the encoder supports the mime and the first attempt fits maxBytes", async () => {
    stubDocument(new Set(["image/webp"]));
    const { encodeBitmap } = await import("../src/features/media/media-upload");
    const blob = await encodeBitmap(bitmap, "image/webp", 200_000, "en");
    expect(blob.type).toBe("image/webp");
  });
});

describe("uploadMediaAsset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not commit when a variant upload fails", async () => {
    stubDocument(new Set(["image/webp"]));
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({
      width: 10,
      height: 10,
      close: () => {},
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/admin/api/media/uploads") {
        return new Response(JSON.stringify({
          uploadGroupId: "upload-1",
          capabilities: [{
            mimeType: "image/webp",
            role: "primary",
            method: "PUT",
            uploadUrl: "https://upload.invalid/variant",
          }],
        }), { status: 200 });
      }
      return new Response(null, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { uploadMediaAsset } = await import("../src/features/media/media-upload");

    await expect(uploadMediaAsset({
      file: new File(["image"], "sample.webp", { type: "image/webp" }),
      purposes: [{
        name: "content",
        required: ["image/webp"],
        maxBytes: { "image/webp": 200_000 },
      }],
      language: "en",
    })).rejects.toThrow(/image\/webp upload failed/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// An explicit purpose is a policy choice, never a hint that can silently select a different policy.
it("refuses unknown explicit upload purposes before preparing an image or sending requests", async () => {
  const purposes = [{ name: "content", required: ["image/png"], maxBytes: { "image/png": 1000 } }];
  expect(selectPurpose(purposes)?.name).toBe("content");
  expect(selectPurpose(purposes, "unknown")).toBeNull();
  expect(selectPurpose(purposes, "")).toBeNull();
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  try {
    const { uploadMediaAsset } = await import("../src/features/media/media-upload");
    await expect(uploadMediaAsset({ file: new File(["image"], "x.png", { type: "image/png" }), purposes, preferredPurpose: "unknown" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it("an image purpose takes any image to re-encode; any other purpose takes its own types, or any file", async () => {
  const { acceptFor } = await import("../src/features/media/media-upload");
  expect(acceptFor(undefined)).toBe("");
  expect(acceptFor({ name: "cover", required: ["jpg,png", "webp"], maxBytes: {} })).toBe("image/*");
  expect(acceptFor({ name: "notes", required: ["*/*"], maxBytes: {} })).toBe("");
  expect(acceptFor({ name: "clips", required: ["video/*,application/pdf"], maxBytes: {} })).toBe(
    "video/*,application/pdf",
  );
});

it("a purpose that takes any type uploads the file as it is, without alt text, and refuses what it does not take", async () => {
  const bodies: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/admin/api/")) bodies.push(JSON.parse(String(init?.body)));
    if (url === "/admin/api/media/uploads")
      return new Response(
        JSON.stringify({
          uploadGroupId: "upload-1",
          capabilities: [{ mimeType: "application/pdf", role: "primary", method: "PUT", uploadUrl: "https://upload.invalid/1" }],
        }),
      );
    if (url === "https://upload.invalid/1") {
      expect(init?.body).toBeInstanceOf(File);
      return new Response(null, { status: 200 });
    }
    return new Response(JSON.stringify({ id: "upload-1", variants: [] }));
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const { uploadMediaAsset } = await import("../src/features/media/media-upload");
    const purposes: MediaPurposePolicy[] = [
      { name: "notes", required: ["*/*"], maxBytes: { "*/*": 100 } },
      { name: "clips", required: ["video/*"], maxBytes: { "video/*": 100 } },
    ];
    const file = new File(["%PDF-1.7"], "report.pdf", { type: "application/pdf" });
    await uploadMediaAsset({ file, purposes, preferredPurpose: "notes", language: "en" });
    expect(bodies).toEqual([
      {
        filename: "report.pdf",
        purpose: "notes",
        variants: [{ mimeType: "application/pdf", byteSize: file.size, role: "primary" }],
      },
      {},
    ]);
    await expect(uploadMediaAsset({ file, purposes, preferredPurpose: "clips", language: "en" })).rejects.toThrow(
      "report.pdf: 'clips' takes video/*, not application/pdf.",
    );
    await expect(
      uploadMediaAsset({
        file: new File([new Uint8Array(101)], "big.bin"),
        purposes,
        preferredPurpose: "notes",
        language: "en",
      }),
    ).rejects.toThrow("larger than the 100 bytes 'notes' takes");
    // a PDF on an image purpose is refused by name before anything is sent
    await expect(
      uploadMediaAsset({
        file,
        purposes: [{ name: "cover", required: ["image/png"], maxBytes: { "image/png": 100 } }],
        language: "en",
      }),
    ).rejects.toThrow("report.pdf is application/pdf, but 'cover' takes images");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  } finally {
    vi.unstubAllGlobals();
  }
});
