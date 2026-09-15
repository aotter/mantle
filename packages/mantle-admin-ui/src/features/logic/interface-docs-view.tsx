import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Eye, Search } from "lucide-react";

import { t } from "../../app/i18n";
import { usePreferences } from "../../app/preferences";
import { useAdminLocation } from "../../app/router";
import { adminWebMcpQueryOptions, developerConsoleQueryOptions } from "../../lib/queries";
import type { AdminTool } from "../../lib/admin-tools";
import type { DeveloperCallableCapability, DeveloperHttpOperation, JsonSchema } from "../../lib/types";
import { ErrorBox } from "../../ui/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { atomKindLabel, audienceLabel } from "./atom-graph";
import { developerDetailHref } from "./developer-route";

const WEBMCP_SNIPPET = `import { bindWebMcp } from "@aotter/mantle-web/webmcp";

const binding = await bindWebMcp();`;

export function InterfaceDocsView(): React.ReactElement {
  const { language } = usePreferences();
  const location = useAdminLocation();
  const snapshot = useQuery(developerConsoleQueryOptions());
  const adminWebMcp = useQuery(adminWebMcpQueryOptions());
  const [search, setSearch] = React.useState("");
  const section = location.pathname.split("/").pop();
  const page = section === "mcp" || section === "webmcp" ? section : "api";

  if (snapshot.isError) return <div className="p-6"><ErrorBox error={snapshot.error} /></div>;
  if (snapshot.isLoading) return <Skeleton className="h-full w-full rounded-none" />;
  if (!snapshot.data) return <></>;

  const { http, callable } = snapshot.data.interfaces;
  const matches = (values: readonly (string | null | undefined)[]): boolean => !search || values.some((value) => value?.toLowerCase().includes(search.toLowerCase()));
  const publicServices = http.filter((operation) => operation.kind === "view" && matches([operation.method, operation.path, operation.name, operation.description, operation.target]));
  const httpTriggers = http.filter((operation) => operation.kind === "procedure" && matches([operation.method, operation.path, operation.name, operation.description, operation.target]));
  const filteredCallable = callable.filter((capability) => matches([capability.name, capability.description, capability.target, capability.trigger, capability.surface, capability.audience]));
  const webMcp = filteredCallable.filter((capability) => capability.surface === "public" && capability.kind === "view");
  return (
    <section className="h-full min-h-0 overflow-y-auto" aria-label={t(language, "docs.title")}>
      {page === "api" ? (
          <DocSection intro={t(language, "docs.httpIntro")} search={search} onSearch={setSearch}>
            {publicServices.length ? <OperationSection title={t(language, "docs.publicEndpoint")} operations={publicServices} /> : null}
            {httpTriggers.length ? <OperationSection title={atomKindLabel(language, "Trigger")} operations={httpTriggers} /> : null}
            {!publicServices.length && !httpTriggers.length ? <EmptyDocs /> : null}
          </DocSection>
      ) : null}
      {page === "mcp" ? (
          <DocSection intro={t(language, "docs.mcpIntro")} search={search} onSearch={setSearch} endpoints={<><Endpoint label={t(language, "docs.publicEndpoint")} value="/mcp" /><Endpoint label={t(language, "docs.staffEndpoint")} value="/mcp/staff" /></>}>
            {(["public", "staff"] as const).map((surface) => {
              const entries = filteredCallable.filter((capability) => capability.surface === surface);
              return entries.length ? <section key={surface} className="space-y-3"><h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{surface}</h2><OperationList>{entries.map((capability) => <CapabilityOperation key={`${surface}:${capability.name}`} capability={capability} />)}</OperationList></section> : null;
            })}
            {!filteredCallable.length ? <EmptyDocs /> : null}
          </DocSection>
      ) : null}
      {page === "webmcp" ? (
          <DocSection intro={t(language, "docs.intro")} search={search} onSearch={setSearch}>
            <section className="space-y-3">
              <div className="flex flex-wrap items-center gap-3"><h2 className="me-auto text-sm font-semibold uppercase tracking-wider text-muted-foreground">Admin WebMCP</h2><Endpoint label={t(language, "docs.catalogEndpoint")} value="/admin/api/webmcp" /></div>
              {adminWebMcp.data ? <OperationList>{adminWebMcp.data.tools.filter((tool) => matches([tool.name, tool.description])).map(tool => <AdminToolOperation key={tool.name} tool={tool} />)}</OperationList> : null}
              {adminWebMcp.isLoading ? <Skeleton className="h-32 w-full" /> : null}
              {adminWebMcp.isError ? <ErrorBox error={adminWebMcp.error} /> : null}
            </section>
            <section className="space-y-3"><div className="flex flex-wrap items-center gap-3"><h2 className="me-auto text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t(language, "docs.publicEndpoint")} WebMCP</h2><Endpoint label={t(language, "docs.catalogEndpoint")} value="/api/views" /></div>
            <pre className="overflow-x-auto rounded-xl border bg-muted/40 p-4 text-xs leading-6"><code>{WEBMCP_SNIPPET}</code></pre>
            <p className="text-sm text-muted-foreground">{t(language, "docs.webmcpNote")}</p>
            <OperationList>{webMcp.map((capability) => <CapabilityOperation key={capability.name} capability={capability} webMcp />)}</OperationList>
            {!webMcp.length ? <EmptyDocs /> : null}
            </section>
          </DocSection>
      ) : null}
    </section>
  );
}

function AdminToolOperation({ tool }: { tool: AdminTool }): React.ReactElement {
  const { language } = usePreferences();
  return <Operation summary={<><Badge variant="secondary">{t(language, "docs.staffEndpoint")}</Badge><code className="font-semibold">{tool.name}</code>{tool.annotations?.readOnlyHint ? <Badge variant="outline">{t(language, "docs.readOnly")}</Badge> : null}</>} description={tool.description}><SchemaDetails label={t(language, "docs.inputSchema")} schema={tool.inputSchema} /></Operation>;
}

function DocSection({ intro, endpoints, search, onSearch, children }: { intro: string; endpoints?: React.ReactNode; search: string; onSearch: (value: string) => void; children: React.ReactNode }): React.ReactElement {
  const { language } = usePreferences();
  return <div className="space-y-6 p-5 sm:p-7"><div className="flex flex-wrap items-center gap-3"><p className="me-auto text-sm leading-6 text-muted-foreground">{intro}</p>{endpoints}</div><div className="sticky top-0 z-20 -mx-2 bg-background/95 px-2 py-2 backdrop-blur"><label className="relative block max-w-xl"><Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden /><Input value={search} onChange={(event) => onSearch(event.target.value)} placeholder={t(language, "collection.search")} aria-label={t(language, "collection.search")} className="bg-background ps-9" /></label></div>{children}</div>;
}

function Endpoint({ label, value }: { label: string; value: string }): React.ReactElement {
  return <div className="rounded-lg border bg-card px-3 py-2"><div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div><code className="text-xs font-semibold">{value}</code></div>;
}

function OperationList({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="overflow-hidden rounded-xl border bg-card">{children}</div>;
}

function OperationSection({ title, operations }: { title: string; operations: DeveloperHttpOperation[] }): React.ReactElement {
  return <section className="space-y-3"><h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2><OperationList>{operations.map((operation) => <HttpOperation key={`${operation.method}:${operation.path}`} operation={operation} />)}</OperationList></section>;
}

function HttpOperation({ operation }: { operation: DeveloperHttpOperation }): React.ReactElement {
  const { language } = usePreferences();
  return (
    <Operation summary={<><Badge variant={operation.method === "GET" ? "secondary" : "default"} className="w-14 justify-center font-mono">{operation.method}</Badge><code className="min-w-0 break-all font-semibold">{operation.path}</code></>} description={operation.description}>
      <div className="space-y-3">
        <a href={developerDetailHref(`${operation.kind === "view" ? "View" : "Trigger"}:${operation.kind === "view" ? operation.target : operation.name}`)} className="inline-block font-mono text-sm font-semibold hover:underline">{operation.name}</a>
        <div className="flex flex-wrap gap-2"><Badge variant="outline">{atomKindLabel(language, operation.kind === "view" ? "View" : "Procedure")}</Badge><Badge variant="outline">{audienceLabel(language, operation.audience)}</Badge><Badge variant="outline">{t(language, "docs.target")}: {operation.target}</Badge></div>
        <SchemaDetails label={t(language, "docs.inputSchema")} schema={operation.input} />
        {operation.output ? <SchemaDetails label={t(language, "docs.outputSchema")} schema={operation.output} /> : null}
        {operation.kind === "view" ? <Button asChild variant="outline" size="sm"><a href={`/admin/views/${encodeURIComponent(operation.target)}`}><Eye aria-hidden />{t(language, "views.openInAdmin")}</a></Button> : null}
      </div>
    </Operation>
  );
}

function CapabilityOperation({ capability, webMcp = false }: { capability: DeveloperCallableCapability; webMcp?: boolean }): React.ReactElement {
  const { language } = usePreferences();
  return (
    <Operation summary={<><Badge variant="secondary">{atomKindLabel(language, capability.kind === "view" ? "View" : "Procedure")}</Badge><code className="font-semibold">{capability.name}</code><Badge variant="outline">{audienceLabel(language, capability.surface)}</Badge>{webMcp ? <Badge variant="outline">{t(language, "docs.readOnly")}</Badge> : null}</>} description={capability.description}>
      <div className="space-y-3">
        <a href={developerDetailHref(`${capability.kind === "view" ? "View" : "Procedure"}:${capability.target}`)} className="inline-block font-mono text-sm font-semibold hover:underline">{capability.target}</a>
        <div className="flex flex-wrap gap-2"><Badge variant="outline">{t(language, "docs.target")}: {capability.target}</Badge>{capability.trigger ? <Badge variant="outline">{atomKindLabel(language, "Trigger")}: {capability.trigger}</Badge> : null}</div>
        <SchemaDetails label={t(language, "docs.inputSchema")} schema={capability.input} />
        {capability.output ? <SchemaDetails label={t(language, "docs.outputSchema")} schema={capability.output} /> : null}
      </div>
    </Operation>
  );
}

function Operation({ summary, description, children }: { summary: React.ReactNode; description: string; children: React.ReactNode }): React.ReactElement {
  return <details className="group border-b last:border-b-0"><summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 marker:content-none hover:bg-muted/40"><span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">{summary}</span><span className="hidden max-w-[42%] truncate text-xs text-muted-foreground lg:block">{description}</span><ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden /></summary><div className="space-y-4 border-t bg-muted/15 px-4 py-4">{children}</div></details>;
}

function SchemaDetails({ label, schema }: { label: string; schema: JsonSchema }): React.ReactElement {
  return <details className="rounded-lg border bg-muted/25"><summary className="cursor-pointer px-3 py-2 text-xs font-medium">{label}</summary><pre className="max-h-72 overflow-auto border-t p-3 text-[11px] leading-5"><code>{JSON.stringify(schema, null, 2)}</code></pre></details>;
}

function EmptyDocs(): React.ReactElement {
  const { language } = usePreferences();
  return <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">{t(language, "docs.noEntries")}</p>;
}
