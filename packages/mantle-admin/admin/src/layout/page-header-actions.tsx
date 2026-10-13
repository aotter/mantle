import * as React from "react";
import { createPortal } from "react-dom";

/** SDK-owned slot for the current page's controls in the Admin navigation. */
export const PageHeaderActionsHostContext = React.createContext<HTMLElement | null>(null);

export function PageHeaderActions({ children }: { children: React.ReactNode }): React.ReactElement {
  const host = React.useContext(PageHeaderActionsHostContext);
  return host ? createPortal(children, host) : <></>;
}
