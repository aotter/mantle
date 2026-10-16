import * as React from "react";
import type { AdminDefinition } from "./define-admin";

/** What the application's `defineAdmin` declared for the sidebar, and its own pages. */
export type ProjectNav = AdminDefinition["nav"] & { readonly pages?: AdminDefinition["pages"] };

const NONE: ProjectNav = { groups: {}, items: [] };
const ProjectNavContext = React.createContext<ProjectNav>(NONE);

/** Internal: `<MantleAdmin>` provides the application's sidebar groups, items and pages to the shell. */
export function ProjectNavProvider({ nav, children }: React.PropsWithChildren<{ nav: ProjectNav }>): React.ReactElement {
  return <ProjectNavContext.Provider value={nav}>{children}</ProjectNavContext.Provider>;
}

export function useProjectNav(): ProjectNav {
  return React.useContext(ProjectNavContext);
}
