/** Checked-entry boundary only. Bare entries never import this module, so they never load Zod. */
import { config, type ZodMiniType } from "zod/mini";
import en from "zod/v4/locales/en.js";
import { ContractError } from "./contracts.js";

let english = false;
/** Validate with a generated official Zod schema. Never import/compile JSON Schema here. */
export function validate<T>(schema: ZodMiniType<T>, value: unknown, path: string, code = "INPUT_VALIDATION_FAILED"): T {
  try {
    assertJsonLimits(value, path);
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    // Zod Mini ships without messages: on the first failure, load English unless the application chose a locale.
    if (!english) { english = true; if (!config().localeError) config(en()); return validate(schema, value, path, code); }
    const issue = result.error.issues[0];
    const pointer = issue?.path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
    throw new ContractError(code, code === "OUTPUT_VALIDATION_FAILED" ? "Procedure output does not match its declared schema." : issue?.message ?? "validation failed", path + (pointer ? "/" + pointer : ""));
  } catch (error) {
    if (error instanceof ContractError) throw new ContractError(code, error.message, error.path);
    throw new ContractError(code, "the schema cannot check this value", path);
  }
}

/** Same finite JSON boundary as 0.2; paths may share objects but may not cycle. */
function assertJsonLimits(value: unknown, path: string): void {
  const stack: { value: unknown; depth: number; exit?: boolean }[] = [{ value, depth: 0 }];
  const active = new WeakSet<object>();
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (current.value === null || typeof current.value !== "object") continue;
    if (current.exit) { active.delete(current.value); continue; }
    if (active.has(current.value) || current.depth > 100 || ++nodes > 10000)
      throw new ContractError("INPUT_VALIDATION_FAILED", "value exceeds JSON validation limits or contains cycles", path);
    active.add(current.value);
    stack.push({ ...current, exit: true });
    for (const child of Array.isArray(current.value) ? current.value : Object.values(current.value))
      stack.push({ value: child, depth: current.depth + 1 });
  }
}
