import { DiagnosticError, runtimeDiagnostic } from "@aotter/mantle-spec";
import type { HandlerContext } from "../../domain/model/HandlerContext.js";
import type { MantleStore } from "../../domain/model/Store.js";
import type { IdGenerator } from "../../domain/port/IdGenerator.js";
import type { StoreReader } from "../../domain/port/StoreReader.js";
import type { ViewQueryOptions } from "../../domain/port/ViewQueryExecutor.js";
import type { ExecuteViewResponse } from "../view/ExecuteViewUseCase.js";

export interface StoreDependencies {
  /** Absent when the storage adapter cannot run Store queries. */
  readonly reader?: StoreReader;
  readonly runView: (
    name: string,
    options: Pick<ViewQueryOptions, "params" | "page" | "show">,
    ctx: HandlerContext | undefined,
  ) => Promise<ExecuteViewResponse<unknown>>;
  readonly idgen: IdGenerator;
}

/** The Store facade (ADR-0030), bound to one caller context when inside a Procedure. */
export function createStore(deps: StoreDependencies, ctx?: HandlerContext): MantleStore {
  return {
    select: (query) => {
      if (!deps.reader) {
        return Promise.reject(new DiagnosticError(runtimeDiagnostic({
          code: "RESOURCE_UNAVAILABLE", severity: "error", path: "store/select",
          expected: "storage adapter with the store capability",
          message: "This storage adapter cannot run Store queries.",
        })));
      }
      return deps.reader.select(query);
    },
    view: async (name, options = {}) => {
      const response = await deps.runView(name, options, ctx);
      if (!response.ok) throw new DiagnosticError(response.diagnostic);
      return response.result as never;
    },
    id: () => deps.idgen.next(),
  };
}
