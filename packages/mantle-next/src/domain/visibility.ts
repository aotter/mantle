/** Next caller reads apply Core's staff visibility; system/public modes retain their own rules. */
import type { RowMode } from "@aotter/mantle/compiler";
export const nextMode = (mode: RowMode): RowMode => mode === "caller" ? "staff" : mode;

/** Single OSS role; additional role policy belongs to the application. */
export const STAFF_ROLES = ["staff"] as const;

