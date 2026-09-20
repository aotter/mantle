import type { MantleRuntime } from "@aotter/mantle-runtime";
import { TemplateRegistry } from "./model/TemplateRegistry.js";
import type { MediaAssetResolver } from "./service/io/MediaAssetReferences.js";
import type { PublicPathResolver } from "./service/PublicPathResolver.js";
import {
  ComposeEntrySeoMetaUseCase,
  ComposeLlmsTxtUseCase,
  ComposeSitemapUseCase,
  PreviewEntryUseCase,
  RenderEntryLiveUseCase,
  RenderListLiveUseCase,
} from "./usecase/index.js";

export interface CreateMantleWebOptions {
  readonly templates?: TemplateRegistry;
  readonly paths?: PublicPathResolver;
  readonly mediaAssets?: MediaAssetResolver;
}

export interface MantleWeb {
  readonly templates: TemplateRegistry;
  readonly paths: PublicPathResolver | null;
  readonly composeLlmsTxt: ComposeLlmsTxtUseCase;
  readonly composeSitemap: ComposeSitemapUseCase;
  readonly composeEntrySeoMeta: ComposeEntrySeoMetaUseCase;
  readonly renderEntryLive: RenderEntryLiveUseCase;
  readonly renderListLive: RenderListLiveUseCase;
  readonly previewEntry: PreviewEntryUseCase;
}

/** Add public document composition to an existing headless runtime. */
export function createMantleWeb(
  runtime: Pick<MantleRuntime, "entries" | "schemas">,
  options: CreateMantleWebOptions = {},
): MantleWeb {
  const templates = options.templates ?? new TemplateRegistry();
  const paths = options.paths ?? null;
  const composeEntrySeoMeta = new ComposeEntrySeoMetaUseCase(runtime.entries);
  return {
    templates,
    paths,
    composeLlmsTxt: new ComposeLlmsTxtUseCase(runtime.entries, paths),
    composeSitemap: new ComposeSitemapUseCase(runtime.entries),
    composeEntrySeoMeta,
    renderEntryLive: new RenderEntryLiveUseCase(
      runtime.entries,
      templates,
      paths,
      composeEntrySeoMeta,
      runtime.schemas,
      options.mediaAssets ?? null,
    ),
    renderListLive: new RenderListLiveUseCase(
      runtime.entries,
      templates,
      runtime.schemas,
      options.mediaAssets ?? null,
    ),
    previewEntry: new PreviewEntryUseCase(
      runtime.entries,
      templates,
      paths,
      composeEntrySeoMeta,
      runtime.schemas,
      options.mediaAssets ?? null,
    ),
  };
}
