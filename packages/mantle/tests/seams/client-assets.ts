/** Required application seam `client-assets` (packages/mantle/tests/application-seams.ts). Public code only, no casts. */
import { type ClientAsset, clientAssets } from "@aotter/mantle/client-assets";

const page: ClientAsset | undefined = clientAssets.page;
export const script: string = page?.js ?? "/assets/client/page.js";
export const stylesheet: string = page?.css ?? "/assets/client/page.css";
