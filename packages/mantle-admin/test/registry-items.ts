import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isBothSlot } from "../admin/src/app/slots";

export const pkg = resolve(import.meta.dirname, "..");

export interface RegistryItem {
  readonly name: string;
  readonly files: readonly { readonly path: string; readonly type: string; readonly target: string }[];
  readonly meta: { readonly surface: "both" | "browser"; readonly slots: readonly string[] };
}

export const items: readonly RegistryItem[] = JSON.parse(readFileSync(resolve(pkg, "registry/registry.json"), "utf8")).items;

export const source = (file: { readonly path: string }): string => readFileSync(resolve(pkg, file.path), "utf8");

/**
 * The registry items that render in the browser and in the Admin MCP App. The MCP App compatibility test
 * (registry-compat.test.ts) runs each of these through the host bridge.
 */
export const bothItems: readonly RegistryItem[] = items.filter(item => item.meta.surface === "both");

/** The surface a slot key renders in: Admin's own `isBothSlot`. */
export const slotSurface = (slot: string): "both" | "browser" => isBothSlot(slot) ? "both" : "browser";

/** A concrete key for a slot template, for the typecheck consumer. */
export const sampleKey = (slot: string): string => slot.replace("<schema>", "requests").replace("<field>", "status").replace("<view>", "pending-requests").replace("<column>", "amount");
