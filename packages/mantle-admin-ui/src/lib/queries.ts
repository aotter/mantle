import { api } from "./api";
import { navigationTools, type AdminToolCatalog } from "./admin-tools";
import type { AuthMethodInfo, DeveloperConsoleSnapshot, StaffOperation, ViewManifestInfo } from "./types";

export function developerConsoleQueryOptions(): {
  queryKey: readonly ["developer-console"];
  queryFn: () => Promise<DeveloperConsoleSnapshot>;
} {
  return {
    queryKey: ["developer-console"] as const,
    queryFn: () => api.get<DeveloperConsoleSnapshot>("/developer-console"),
  };
}

export function adminWebMcpQueryOptions(): {
  queryKey: readonly ["admin-webmcp"];
  queryFn: () => Promise<AdminToolCatalog>;
} {
  return {
    queryKey: ["admin-webmcp"] as const,
    queryFn: async () => {
      const catalog = await api.get<AdminToolCatalog>("/webmcp");
      const tools = [...catalog.tools, ...navigationTools];
      if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error("Admin navigation tool name collision.");
      return { ...catalog, tools };
    },
  };
}

export function authMethodsQueryOptions(): {
  queryKey: readonly ["auth-methods"];
  queryFn: () => Promise<AuthMethodInfo[]>;
  retry: false;
} {
  return {
    queryKey: ["auth-methods"] as const,
    queryFn: async () => {
      const res = await fetch("/api/auth/methods", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { methods?: AuthMethodInfo[] };
      return data.methods ?? [];
    },
    retry: false,
  };
}

/** Keep every consumer of this query key on the same unwrapped shape. */
export function viewsManifestQueryOptions(): {
  queryKey: readonly ["views-manifest"];
  queryFn: () => Promise<ViewManifestInfo[]>;
} {
  return {
    queryKey: ["views-manifest"] as const,
    queryFn: async () => {
      const res = await api.get<{ views: ViewManifestInfo[] }>("/views-manifest");
      return res.views;
    },
  };
}

/** Shared options keep operation consumers on one cache entry. */
export function operationsQueryOptions(): {
  queryKey: readonly ["operations"];
  queryFn: () => Promise<StaffOperation[]>;
} {
  return {
    queryKey: ["operations"] as const,
    queryFn: async () => {
      const res = await api.get<{ operations: StaffOperation[] }>("/operations");
      return res.operations;
    },
  };
}
