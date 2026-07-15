import type { ViewManifest } from "@aotter/mantle-spec";
import type { HandlerContext } from "../../../domain/model/HandlerContext.js";
import type { CompileViewOptions } from "../../../domain/service/ViewSqlCompiler.js";

export interface ExecuteViewRequest {
  readonly view: ViewManifest;
  readonly pathPrefix?: string;
  readonly options?: CompileViewOptions;
  /** Normalized caller context for static auth and an optional guard.
   *  Required for guarded Views; the use case returns `UNAUTHENTICATED`
   *  if absent. Adapters may pass a guest context for anonymous Views;
   *  protected predicates then fail closed with 401. */
  readonly ctx?: HandlerContext;
}
