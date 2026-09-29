/**
 * OpenAPI 3.1 document. Type kept loose (`Record<string, unknown>`)
 * because the spec doesn't pin a v3.1 type definition; consumers
 * stringify and validate downstream.
 */
export interface EmitOpenapiResponse {
  readonly document: Record<string, unknown>;
}
