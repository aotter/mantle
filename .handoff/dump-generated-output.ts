import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
const [root, out] = process.argv.slice(2) as [string, string];
const pkg = join(root, "packages/mantle");
const { generateFromSources } = await import(join(pkg, "src/infrastructure/generate.ts"));
const targets = ["cloudflare-d1", "cloudflare-postgres", "bun-postgres", "bun-sqlite"];
const sets: Record<string, string[]> = {};
const apps = join(pkg, "tests/apps");
for (const f of readdirSync(apps).filter(f => f.endsWith(".yaml"))) sets["tests-apps/" + f] = [join(apps, f)];
const ex = join(root, "docs/examples");
for (const d of readdirSync(ex, { withFileTypes: true }).filter(d => d.isDirectory())) {
  const m = join(ex, d.name, "manifests");
  if (existsSync(m)) sets["examples/" + d.name] = readdirSync(m).filter(f => f.endsWith(".yaml")).sort().map(f => join(m, f));
}
sets["examples/generated-web"] = [join(ex, "generated-web/posts.yaml")];
sets["examples/frontend-mcp-app"] = [join(ex, "frontend-mcp-app/manifest.yaml")];
const cf = join(pkg, "compiler-tests/spec/fixtures");
sets["compiler-fixtures/pipeline-valid"] = [join(cf, "pipeline/valid.yaml")];
sets["compiler-fixtures/spec-only-host"] = [join(cf, "spec-only-host.yaml")];
sets["compiler-fixtures/i18n-parent-child"] = [join(cf, "i18n-parent-child/manifests/site.yaml")];
sets["tests-apps/COMBO-store-equivalence+purchase"] = ["purchase.yaml","store-equivalence.yaml"].map(f => join(apps, f));
sets["tests-apps/COMBO-publishing-visibility+publishing"] = ["publishing.yaml","publishing-visibility.yaml"].map(f => join(apps, f));
sets["tests-apps/COMBO-store-transactions+store-extra"] = ["store-extra.yaml","store-transactions.yaml"].map(f => join(apps, f));
sets["tests-apps/COMBO-store-transactions+purchase"] = ["purchase.yaml","store-transactions.yaml"].map(f => join(apps, f));
sets["tests-apps/ALL-purchase+store-extra+publishing"] = ["purchase.yaml", "store-extra.yaml", "publishing.yaml"].map(f => join(apps, f));
const write = (p: string, t: string) => { const f = join(out, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, t); };
let n = 0, errs = 0;
for (const [name, files] of Object.entries(sets))
  for (const target of targets)
    for (const admin of [false, true]) {
      const sources = files.map(f => ({ sourceId: f.split("/").pop()!, text: readFileSync(f, "utf8") }));
      let r: any;
      try { r = await generateFromSources({ target, admin, sources: { sources } }); } catch (e: any) { r = { ok: false, diagnostics: String(e?.message ?? e) }; }
      const base = `gen/${name}/${target}${admin ? "+admin" : ""}`;
      if (!r.ok) { write(base + "/__ERROR.txt", JSON.stringify(r.diagnostics, null, 1)); errs++; n++; continue; }
      for (const [fn, text] of Object.entries<string>(r.files)) { write(`${base}/${fn}`, text); n++; }
    }
const { loadModule, parseSync } = await import("libpg-query");
await loadModule();
const { print: pd1 } = await import(join(pkg, "src/build/d1/print.ts"));
const { print: pp } = await import(join(pkg, "src/build/postgres/print.ts"));
const { corpus } = await import(join(pkg, "compiler-tests/corpus.ts"));
const j = JSON.parse(readFileSync(join(cf, "sql-corpus.json"), "utf8"));
const extra = [
  "GRANT USAGE ON TYPE s.t TO r", "GRANT USAGE ON DOMAIN s.d TO r", "COMMENT ON TRIGGER t ON s.tbl IS 'x'", "COMMENT ON RULE r ON s.tbl IS 'x'",
  "COMMENT ON POLICY \"My Pol\" ON s.tbl IS 'x'", "DROP POLICY \"My Pol\" ON s.tbl", "COMMENT ON OPERATOR s.+ (int, int) IS 'x'",
  "CREATE OPERATOR s.=== (LEFTARG=int, RIGHTARG=int, PROCEDURE=f, COMMUTATOR = OPERATOR(s.===), NEGATOR = OPERATOR(s.!==))",
  "ALTER OPERATOR s.=== (int,int) SET (COMMUTATOR = OPERATOR(s.===))",
  "CREATE POLICY \"Own Rows\" ON items USING (owner = current_user)",
  "CREATE TABLE s.t (id text PRIMARY KEY, \"Order\" int CHECK (\"Order\" > 0))", "CREATE INDEX i ON s.t (lower(id)) WHERE id > 'a'",
];
const items = [...corpus.map((c: any) => c.sql), ...j.map((c: any) => c.sql), ...extra];
let pr = 0;
const lines: string[] = [];
for (const [i, sql] of items.entries()) {
  for (const [nm, pf] of [["d1", pd1], ["pg", pp]] as const) {
    let o: string;
    try { o = pf((parseSync(sql) as any).stmts[0].stmt); } catch (e: any) { o = "ERR " + String(e?.message ?? e).split("\n")[0]; }
    lines.push(`[${i}] ${nm}: ${sql}\n  => ${o}`); pr++;
  }
}
write("printer-corpus.txt", lines.join("\n") + "\n");
console.log(JSON.stringify({ sets: Object.keys(sets).length, files: n, generateErrorDirs: errs, printerItems: items.length, printerOutputs: pr }));
