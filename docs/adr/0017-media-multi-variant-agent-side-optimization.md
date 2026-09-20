# ADR-0017: Multi-variant media assets, agent-side optimization

**Status:** Accepted (v0.1.0-alpha.14)
**Issue:** [#272](https://github.com/aotter/mantle/issues/272)

## Context

The pre-#272 media subsystem treated each upload as one artifact: one
`create_media_upload` returned one presigned PUT URL, one
`commit_media_upload` returned one `MediaAsset` with one `publicUrl`,
and entry data fields embedded that URL directly. Two consumer pains
surfaced in `toa-shop`:

1. **URL embedding ties entries to bucket/CDN identity.** Moving
   buckets, switching custom domains, or auditing "where is asset X
   used" all require rewriting entries — there's no logical handle.
2. **One artifact = no `<picture>`.** Modern formats (avif, webp)
   cut bytes by 30–70 % on the storefront photos toa-shop measured,
   but the SDK had no way to deliver three formats from one logical
   asset. Consumers would have had to pre-encode three formats,
   upload three times, and store three URLs per image position —
   awkward for the MCP agent and impossible to express in the
   admin upload widget.

## Decision

Ship the corrected shape in one breaking change. Pre-v0.1 means there
is no production consumer to migrate; an intermediate "one URL, three
variants behind it" shape would be incoherent (renderer can't get the
variants without refetching by id) and not worth the
backwards-compat work.

### 1. `MediaAsset.variants[]` is required

Every committed asset carries one or more variants. Renderers consume
the array directly and emit `<picture>`. There is no top-level
`publicUrl` / `storageKey` / `mimeType` / `byteSize` — the single-URL
shape is what we're leaving behind.

### 2. Optimization runs **agent-side**, not on the Worker

workerd has no usable image-processing stack (no sharp / libvips —
WASM ports are large and slow). Rather than spin up a separate
transform Worker or pay for Cloudflare Images, the SDK shifts the
encode step to where it already runs in a real Node-like runtime:

- Scaffolders, ops scripts, the admin SPA's local helper, and MCP
  agents (Claude Code, etc.) all execute in environments where
  `sharp` works.
- The MCP client or operator tooling runs the agent-side image
  processor: take a source file, produce the format set, call
  `create_media_upload`, upload every variant, and call
  `commit_media_upload`.
- The Worker only **enforces policy**: required mime set, per-mime
  byte caps, suspicious-shape heuristic (modern format must not be
  larger than its fallback). It never decodes or re-encodes.

The Worker's contract: *received bytes are already optimized, or I
refuse them*. The agent's contract: *I optimize before uploading, in
a runtime that can run sharp*.

### 3. `siteDefaults.media.purposes` is a policy object

Replace the `string[]` shape with `MediaPurposePolicy[]`:

```ts
purposes: [
  {
    name: "post-cover",
    required: ["image/avif", "image/webp", "image/jpeg"],
    maxBytes: {
      "image/avif": 200_000,
      "image/webp": 300_000,
      "image/jpeg": 500_000,
    },
  },
]
```

Each purpose carries its own required mime set + per-mime byte cap.
The runtime emits the policy summary into `create_media_upload`'s
tool description so MCP agents see the contract via `tools/list`
without a separate round trip.

### 4. Asset-id refs in entries, `media_assets` table for resolution

Entries hold `MediaAsset.id` strings, not URLs:

```yaml
coverAssetId:
  type: string
  x-mantle-ref: media_assets
  x-mcp-hint: media-image
```

`x-mantle-ref` and `x-mcp-hint` are existing v0.1 grammar
extensions — no new manifest keys. The runtime contract changes
(these fields now hold ids instead of URLs), but the grammar surface
does not.

A new `media_assets` D1 table persists committed assets:

```sql
CREATE TABLE media_assets (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  owner_id    TEXT,
  alt         TEXT,
  caption     TEXT,
  variants    TEXT NOT NULL,    -- JSON
  metadata    TEXT
);
```

New port `MediaAssetRepository` (findById / findManyByIds / save /
delete); new runtime helper `runtime.media.resolve(id)` and
`resolveMany(ids)` for render-time materialisation. The renderer
batches a render-pass's worth of references in one DB round trip.

### 5. Adapter stays storage-key-shaped

`MediaStorage` port methods (`getPublicUrl`, `deleteObject`) take
storage keys — the asset-id → storage-key translation happens in the
use case layer via the repository. The R2 adapter:

- Mints storage keys under `<purpose>/<uploadGroupId>/<role>.<ext>`
  so every variant of one logical asset lives under a shared prefix.
- HEAD-verifies every variant before commit; any failure rejects
  the whole bundle (all-or-nothing).
- Enforces the primary-role invariant the renderer depends on.
- Orphan sweep (#254) can list a prefix to find partially-committed
  bundles.

## Consequences

### Positive

- One coherent shape ships at once — no migration debt for the
  "intermediate URL-in-entry world".
- Worker stays workerd-clean. No new infrastructure component
  (no sharp Worker, no Cloudflare Images dependency, no Queue +
  background worker).
- MCP agents see the full policy via `tools/list`; the type system
  and the diagnostic catalog catch most misuses before bytes flow.
- Asset-id refs decouple entries from CDN identity; the orphan
  sweeper, "where used", and asset metadata editing all become
  cheap follow-ups.

### Negative / accepted

- Agent-side optimization shifts compute to the uploader. Browser-
  side admin uploads (drag-drop in the SPA) would need to either
  invoke a local helper subprocess (Tauri / Electron) or call the
  scaffolder's helper indirectly — UI work tracked separately.
- Every starter using media needs to migrate schemas from URL
  fields to `*AssetId` fields + adopt the resolver in their renderer.
- `siteDefaults.media.purposes` is a breaking shape change. Pre-v0.1
  cadence allows this; downstream sweeps coordinate via the existing
  fix-forward release process.

## Why not the alternatives

- **CF Images binding**: vendor lock-in + per-image billing; rejected
  because the agent runtime can already produce the variants without
  introducing a new commercial dependency.
- **Separate transform Worker (with container running sharp)**: real
  infrastructure complexity (queue + worker + observability), much
  larger blast radius than a CLI helper.
- **Variant URLs stored inline in the entry**: re-introduces the URL-
  embedding problem the asset-id refs solve. Was the original
  "phase 1" plan; rejected after recognising the intermediate state
  is incoherent.

## References

- `packages/mantle-runtime/src/domain/port/MediaStorage.ts`
- `packages/mantle-runtime/src/domain/port/MediaAssetRepository.ts`
- `packages/mantle-runtime/src/infrastructure/persistence/DatabaseMediaAssetRepository.ts`
- `packages/mantle-spec/src/domain/model/SiteConfig.ts` (MediaPurposePolicy)
- `packages/adapters/cloudflare/src/bindings/R2MediaStorage.ts`
- MCP client / operator-side image processing tools
