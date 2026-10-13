/** Next caller reads apply Core's admin visibility; system/public modes retain their own rules. */
import type { RowMode } from "../build/compiler.js";
export const nextMode = (mode: RowMode): RowMode => mode === "caller" ? "admin" : mode;

