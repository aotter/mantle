import { compileRuntimePlan, type RuntimePlan } from "@aotter/mantle-runtime";
import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";

/** Route object-literal fixtures through the same sealed parser/linker/compiler as production. */
export function compileTestPlan(atoms: readonly unknown[]): RuntimePlan {
  const parsed = parseManifestSources({
    sources: [{ sourceId: "test:cloudflare", text: atoms.map((atom) =>
      JSON.stringify(atom)).join("\n---\n") }],
  });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(({ message }) => message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map(({ message }) => message).join("\n"));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error(compiled.diagnostics.map(({ message }) => message).join("\n"));
  return compiled.value;
}
