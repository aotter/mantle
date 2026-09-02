import type { QueryClient } from "@tanstack/react-query";

import type { DeveloperConsoleSnapshot } from "./types";

const QUERY_KEY = ["developer-console"] as const;

export function isDeveloperSnapshotPreview(): boolean {
  return typeof window !== "undefined"
    && window.parent !== window
    && new URLSearchParams(window.location.search).get("preview") === "snapshot";
}

export function readDeveloperSnapshotMessage(value: unknown): {
  revision: number;
  snapshot: DeveloperConsoleSnapshot;
} | null {
  if (!isRecord(value)
    || value.protocolVersion !== 1
    || value.type !== "mantle:admin-preview:snapshot"
    || !Number.isInteger(value.revision)
    || Number(value.revision) < 1
    || !isDeveloperConsoleSnapshot(value.snapshot)) return null;
  return { revision: Number(value.revision), snapshot: value.snapshot };
}

export function installDeveloperSnapshotPreview(queryClient: QueryClient): () => void {
  if (!isDeveloperSnapshotPreview()) return () => undefined;
  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const message = readDeveloperSnapshotMessage(event.data);
    if (!message) return;
    queryClient.setQueryData(QUERY_KEY, message.snapshot);
    window.parent.postMessage({
      protocolVersion: 1,
      type: "mantle:admin-preview:applied",
      revision: message.revision,
    }, window.location.origin);
  };
  window.addEventListener("message", onMessage);
  window.parent.postMessage({ protocolVersion: 1, type: "mantle:admin-preview:ready" }, window.location.origin);
  return () => window.removeEventListener("message", onMessage);
}

function isDeveloperConsoleSnapshot(value: unknown): value is DeveloperConsoleSnapshot {
  if (!isRecord(value)) return false;
  const { dataModel, logic, interfaces, graph } = value;
  return isRecord(dataModel)
    && Array.isArray(dataModel.schemas)
    && Array.isArray(dataModel.views)
    && isRecord(logic)
    && Array.isArray(logic.triggers)
    && Array.isArray(logic.procedures)
    && isRecord(interfaces)
    && Array.isArray(interfaces.http)
    && Array.isArray(interfaces.callable)
    && isRecord(graph)
    && Array.isArray(graph.atoms)
    && Array.isArray(graph.relations);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
