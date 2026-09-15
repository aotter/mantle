import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye } from "lucide-react";

import { t } from "../../app/i18n";
import { usePreferences } from "../../app/preferences";
import { useAdminLocation } from "../../app/router";
import { adminWebMcpQueryOptions, developerConsoleQueryOptions } from "../../lib/queries";
import type { AdminTool } from "../../lib/admin-tools";
import type { DeveloperCallableCapability, DeveloperHttpOperation, JsonSchema } from "../../lib/types";
import { ErrorBox } from "../../ui/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  const section = location.pathname.split("/").pop();
  const page = section === "mcp" || section === "webmcp" ? section : "api";

  if (snapshot.isError) return <div className="p-6"><ErrorBox error={snapshot.error} /></div>;
  if (snapshot.isLoading) return <Skeleton className="h-full w-full rounded-none" />;
  if (!snapshot.data) return <></>;

  const { http, callable } = snapshot.data.interfaces;
  const publicServices = http.filter((operation) => operation.kind === "view");
  const httpTriggers = http.filter((operation) => operation.kind === "procedure");
  const webMcp = callable.filter((capability) => capability.surface === "public" && capability.kind === "view");
  return (
    <section className="h-full min-h-0 overflow-y-auto" aria-label={t(language, "docs.title")}>
      <header className="border-b px-5 py-5 sm:px-7">
        <h1 className="text-xl font-semibold">{t(language, "docs.title")}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t(language, "docs.intro")}</p>
      </header>
      {page === "api" ? (
          <DocSection intro={t(language, "docs.httpIntro")}>
            {publicServices.length ? <OperationSection title={t(language, "docs.publicEndpoint")} operations={publicServices} /> : null}
            {httpTriggers.length ? <OperationSection title={atomKindLabel(language, "Trigger")} operations={httpTriggers} /> : null}
            {!http.length ? <EmptyDocs /> : null}
          </DocSection>
      ) : null}
      {page === "mcp" ? (
          <DocSection intro={t(language, "docs.mcpIntro")} endpoints={<><Endpoint label={t(language, "docs.publicEndpoint")} value="/mcp" /><Endpoint label={t(language, "docs.staffEndpoint")} value="/mcp/staff" /></>}>
            {(["public", "staff"] as const).map((surface) => {
              const entries = callable.filter((capability) => capability.surface === surface);
              return entries.length ? <section key={surface} className="space-y-3"><h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{surface}</h2><OperationGrid>{entries.map((capability) => <CapabilityCard key={`${surface}:${capability.name}`} capability={capability} />)}</OperationGrid></section> : null;
            })}
            {!callable.length ? <EmptyDocs /> : null}
          </DocSection>
      ) : null}
      {page === "webmcp" ? (
          <DocSection intro={t(language, "docs.intro")}>
            <section className="space-y-3">
              <div className="flex flex-wrap items-center gap-3"><h2 className="me-auto text-sm font-semibold uppercase tracking-wider text-muted-foreground">Admin WebMCP</h2><Endpoint label={t(language, "docs.catalogEndpoint")} value="/admin/api/webmcp" /></div>
              {adminWebMcp.data ? <OperationGrid>{adminWebMcp.data.tools.map(tool => <AdminToolCard key={tool.name} tool={tool} />)}</OperationGrid> : null}
              {adminWebMcp.isLoading ? <Skeleton className="h-32 w-full" /> : null}
              {adminWebMcp.isError ? <ErrorBox error={adminWebMcp.error} /> : null}
            </section>
            <section className="space-y-3"><div className="flex flex-wrap items-center gap-3"><h2 className="me-auto text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t(language, "docs.publicEndpoint")} WebMCP</h2><Endpoint label={t(language, "docs.catalogEndpoint")} value="/api/views" /></div>
            <pre className="overflow-x-auto rounded-xl border bg-muted/40 p-4 text-xs leading-6"><code>{WEBMCP_SNIPPET}</code></pre>
            <p className="text-sm text-muted-foreground">{t(language, "docs.webmcpNote")}</p>
            <OperationGrid>{webMcp.map((capability) => <CapabilityCard key={capability.name} capability={capability} webMcp />)}</OperationGrid>
            {!webMcp.length ? <EmptyDocs /> : null}
            </section>
          </DocSection>
      ) : null}
    </section>
  );
}

function AdminToolCard({ tool }: { tool: AdminTool }): React.ReactElement {
  const { language } = usePreferences();
  return <Card><CardHeader><div className="flex gap-2"><Badge variant="secondary">{t(language, "docs.staffEndpoint")}</Badge>{tool.annotations?.readOnlyHint ? <Badge variant="outline">{t(language, "docs.readOnly")}</Badge> : null}</div><CardTitle className="font-mono text-sm">{tool.name}</CardTitle><CardDescription>{tool.description}</CardDescription></CardHeader><CardContent><SchemaDetails label={t(language, "docs.inputSchema")} schema={tool.inputSchema} /></CardContent></Card>;
}

function DocSection({ intro, endpoints, children }: { intro: string; endpoints?: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  return <div className="mx-auto max-w-6xl space-y-6 p-5 sm:p-7"><div className="flex flex-wrap items-center gap-3"><p className="me-auto max-w-3xl text-sm leading-6 text-muted-foreground">{intro}</p>{endpoints}</div>{children}</div>;
}

function Endpoint({ label, value }: { label: string; value: string }): React.ReactElement {
  return <div className="rounded-lg border bg-card px-3 py-2"><div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div><code className="text-xs font-semibold">{value}</code></div>;
}

function OperationGrid({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="grid gap-4 xl:grid-cols-2">{children}</div>;
}

function OperationSection({ title, operations }: { title: string; operations: DeveloperHttpOperation[] }): React.ReactElement {
  return <section className="space-y-3"><h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2><OperationGrid>{operations.map((operation) => <HttpCard key={`${operation.method}:${operation.path}`} operation={operation} />)}</OperationGrid></section>;
}

function HttpCard({ operation }: { operation: DeveloperHttpOperation }): React.ReactElement {
  const { language } = usePreferences();
  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-2"><Badge variant={operation.method === "GET" ? "secondary" : "default"} className="font-mono">{operation.method}</Badge><code className="min-w-0 break-all text-xs font-semibold">{operation.path}</code></div>
        <CardTitle className="font-mono text-sm"><a href={developerDetailHref(`${operation.kind === "view" ? "View" : "Trigger"}:${operation.kind === "view" ? operation.target : operation.name}`)} className="hover:underline">{operation.name}</a></CardTitle>
        <CardDescription>{operation.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2"><Badge variant="outline">{atomKindLabel(language, operation.kind === "view" ? "View" : "Procedure")}</Badge><Badge variant="outline">{audienceLabel(language, operation.audience)}</Badge><Badge variant="outline">{t(language, "docs.target")}: {operation.target}</Badge></div>
        <SchemaDetails label={t(language, "docs.inputSchema")} schema={operation.input} />
        {operation.output ? <SchemaDetails label={t(language, "docs.outputSchema")} schema={operation.output} /> : null}
        {operation.kind === "view" ? <Button asChild variant="outline" size="sm"><a href={`/admin/views/${encodeURIComponent(operation.target)}`}><Eye aria-hidden />{t(language, "views.openInAdmin")}</a></Button> : null}
      </CardContent>
    </Card>
  );
}

function CapabilityCard({ capability, webMcp = false }: { capability: DeveloperCallableCapability; webMcp?: boolean }): React.ReactElement {
  const { language } = usePreferences();
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{atomKindLabel(language, capability.kind === "view" ? "View" : "Procedure")}</Badge><Badge variant="outline">{audienceLabel(language, capability.surface)}</Badge><Badge variant="outline">{audienceLabel(language, capability.audience)}</Badge>{webMcp ? <Badge variant="outline">{t(language, "docs.readOnly")}</Badge> : null}</div>
        <CardTitle className="font-mono text-sm"><a href={developerDetailHref(`${capability.kind === "view" ? "View" : "Procedure"}:${capability.target}`)} className="hover:underline">{capability.name}</a></CardTitle>
        <CardDescription>{capability.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2"><Badge variant="outline">{t(language, "docs.target")}: {capability.target}</Badge>{capability.trigger ? <Badge variant="outline">{atomKindLabel(language, "Trigger")}: {capability.trigger}</Badge> : null}</div>
        <SchemaDetails label={t(language, "docs.inputSchema")} schema={capability.input} />
        {capability.output ? <SchemaDetails label={t(language, "docs.outputSchema")} schema={capability.output} /> : null}
      </CardContent>
    </Card>
  );
}

function SchemaDetails({ label, schema }: { label: string; schema: JsonSchema }): React.ReactElement {
  return <details className="rounded-lg border bg-muted/25"><summary className="cursor-pointer px-3 py-2 text-xs font-medium">{label}</summary><pre className="max-h-72 overflow-auto border-t p-3 text-[11px] leading-5"><code>{JSON.stringify(schema, null, 2)}</code></pre></details>;
}

function EmptyDocs(): React.ReactElement {
  const { language } = usePreferences();
  return <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">{t(language, "docs.noEntries")}</p>;
}
