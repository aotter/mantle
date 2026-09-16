import * as React from "react";
import { AuthenticatedLayout } from "../../layout/authenticated-layout";
import { NotFoundView } from "../system/not-found-view";
import { DataModelView } from "./data-model-view";
import { DeveloperOverviewView } from "./developer-overview-view";
import { InterfaceDocsView } from "./interface-docs-view";
import { LogicView } from "./logic-view";

export default function DeveloperWorkspace({ path }: { path: string }): React.ReactElement {
  const view = path === "/admin/dev" || path.startsWith("/admin/dev/overview/") ? <DeveloperOverviewView />
    : path === "/admin/dev/model" || path.startsWith("/admin/dev/model/") ? <DataModelView />
    : path === "/admin/dev/logic" || path.startsWith("/admin/dev/logic/") ? <LogicView />
    : path === "/admin/dev/docs" || path.startsWith("/admin/dev/docs/") ? <InterfaceDocsView />
    : <NotFoundView path={path} />;
  return <AuthenticatedLayout workspace="developer">{view}</AuthenticatedLayout>;
}
