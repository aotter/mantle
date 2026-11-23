/** Required application seam `admin-brand-placement` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import { defineAdmin, type BrandPlacement, type BrandProps } from "@aotter/mantle-admin/app";

const compact: readonly BrandPlacement[] = ["sidebar", "loading"];

export const admin = defineAdmin(
  {},
  {
    components: {
      Brand: (props: BrandProps) =>
        compact.includes(props.placement) ? props.title : `${props.title} (${props.placement})`,
    },
  },
);
