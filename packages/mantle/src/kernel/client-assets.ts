/** The content-hashed copies of one browser entry, as paths the edge serves. */
export interface ClientAsset {
  /** `/assets/client/h/<name>-<hash>.js` */
  readonly js: string;
  /** `/assets/client/h/<name>-<hash>.css`, when the entry imports CSS. */
  readonly css?: string;
}

// Application seam: applications depend on this. Do not remove or narrow it because Core has no internal use (CONTRIBUTING.md, "Application seams").
/**
 * Each browser entry (`client/<name>.ts|tsx` beside the Worker entry) by name: `clientAssets.page` is the content-hashed
 * copy of `/assets/client/page.js` and its CSS. `mantle bundle` replaces this module with the map of the build it
 * bundles the Worker from, so HTML a Worker version renders names files that version deployed. It is for the Worker
 * (server) only: in a browser file, a `bun-*` server (whose build writes no hashed copies) or a test, the map is empty,
 * so fall back to the stable name. Browser code reads a hashed URL from the HTML the Worker rendered.
 */
export const clientAssets: Readonly<Partial<Record<string, ClientAsset>>> = {};
