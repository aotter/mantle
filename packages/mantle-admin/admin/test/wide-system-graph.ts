import type { DeveloperAtom, DeveloperAtomRelation, DeveloperAudience, DeveloperConsoleSnapshot } from "../src/lib/types";

// Synthetic regression fixture for #1666: dozens of Triggers and Views across several audiences,
// exposed Procedures, internal Procedures without an incoming trigger-target relation, and
// Procedure-to-Schema relations, plus one Schema nothing writes or reads.
export function wideSystemGraph(): DeveloperConsoleSnapshot["graph"] {
  const atoms: DeveloperAtom[] = [];
  const relations: DeveloperAtomRelation[] = [];
  const relate = (kind: DeveloperAtomRelation["kind"], sourceId: string, targetId: string): void => {
    relations.push({ id: `${sourceId}->${targetId}`, kind, sourceId, targetId, pointer: "/spec", value: targetId.split(":")[1]! });
  };
  for (let i = 0; i < 12; i += 1) atoms.push({ id: `Schema:s${i}`, kind: "Schema", name: `s${i}`, title: null });
  atoms.push({ id: "Schema:unused", kind: "Schema", name: "unused", title: null });
  for (let i = 0; i < 24; i += 1) {
    atoms.push({ id: `Procedure:p${i}`, kind: "Procedure", name: `p${i}`, title: null });
    relate("procedure-schema", `Procedure:p${i}`, `Schema:s${i % 12}`);
  }
  for (let i = 0; i < 10; i += 1) {
    atoms.push({ id: `Procedure:internal${i}`, kind: "Procedure", name: `internal${i}`, title: null });
    relate("procedure-schema", `Procedure:internal${i}`, `Schema:s${(i * 5) % 12}`);
  }
  const audiences: Array<[DeveloperAudience, number]> = [["public", 14], ["members", 10], ["admin", 16], ["system", 4], ["api-clients", 8]];
  let n = 0;
  for (const [audience, count] of audiences) {
    for (let i = 0; i < count; i += 1, n += 1) {
      if (i % 3 === 2) {
        atoms.push({ id: `View:v${n}`, kind: "View", name: `v${n}`, title: null, audience });
        relate("view-source", `View:v${n}`, `Schema:s${n % 12}`);
      } else {
        atoms.push({ id: `Trigger:t${n}`, kind: "Trigger", name: `t${n}`, title: null, audience, transport: "http" });
        relate("trigger-target", `Trigger:t${n}`, `Procedure:p${n % 24}`);
      }
    }
  }
  return { atoms, relations };
}

// Taller than wide (#1666 review): one audience whose Triggers each start their own Procedure.
export function tallSystemGraph(): DeveloperConsoleSnapshot["graph"] {
  const atoms: DeveloperAtom[] = [];
  const relations: DeveloperAtomRelation[] = [];
  for (let i = 0; i < 120; i += 1) {
    atoms.push({ id: `Trigger:t${i}`, kind: "Trigger", name: `t${i}`, title: null, audience: "public", transport: "http" });
    atoms.push({ id: `Procedure:p${i}`, kind: "Procedure", name: `p${i}`, title: null });
    relations.push({ id: `t${i}->p${i}`, kind: "trigger-target", sourceId: `Trigger:t${i}`, targetId: `Procedure:p${i}`, pointer: "/spec", value: `p${i}` });
  }
  atoms.push({ id: "Schema:s", kind: "Schema", name: "s", title: null });
  return { atoms, relations };
}
