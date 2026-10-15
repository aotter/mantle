import * as React from "react";
import type { LucideIcon } from "lucide-react";
import type { AdminBrand } from "./types";

/** What Admin's built-in sidebar and header read from the shell around them, so a replacement component need not pass it on. */
export interface ShellContextValue {
  readonly brand: AdminBrand;
  readonly publicUrl: string | undefined;
  readonly workspaceLink: { href: string; label: string; icon: LucideIcon } | undefined;
  readonly actionsHostRef: React.Ref<HTMLDivElement>;
  readonly user: { login: string | null; image: string | null; role: string | null };
}

export const ShellContext = React.createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const value = React.useContext(ShellContext);
  if (!value) throw new Error("The sidebar and header render inside Admin's shell.");
  return value;
}
