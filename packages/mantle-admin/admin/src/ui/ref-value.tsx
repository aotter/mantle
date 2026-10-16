import * as React from "react";
import { AdminLink } from "../app/slots";
import { entryLandingPath } from "../lib/collection-nav";
import type { RefTitles } from "../lib/types";

const RefTitlesContext = React.createContext<RefTitles | undefined>(undefined);

/** The titles the server resolved for the reference fields of the page below (`ref_titles` of a list, `refTitles` of a record). */
export const RefTitlesProvider = RefTitlesContext.Provider;

/**
 * The resolved target of a reference value, for this caller. A missing, deleted and unreadable target are all absent, so a
 * caller shows the stored value as it always did (the exact ID with copy) and the page tells the three apart by nothing.
 */
export function useRefTarget(field: string, value: unknown): { collection: string; id: string; title: string } | undefined {
  const titles = React.useContext(RefTitlesContext);
  return typeof value === "string" ? titles?.[field]?.[value] : undefined;
}

/** A resolved reference: the target's title as a link to its record; the stored value is its tooltip. */
export function RefLink({ target, value }: { target: { collection: string; id: string; title: string }; value: string }): React.ReactElement {
  return <AdminLink href={entryLandingPath(target.collection, target.id)} title={value} className="font-medium hover:underline">{target.title}</AdminLink>;
}
