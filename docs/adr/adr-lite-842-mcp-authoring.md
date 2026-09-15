# ADR-lite #842: Applicable generic MCP authoring

Status: Accepted for implementation following maintainer approval.

The staff catalog and dispatcher remain shared by remote MCP and Admin
WebMCP (ADR-0014, ADR-0019, ADR-lite-861). No new manifest switch or tool
registry is introduced. Adapters retain current staff-role verification;
declared Procedures and Views retain their own authorization and guards.

Generic lifecycle tools are offered only when at least one writable content
Schema exists. Delete is offered only when a writable Schema exists. Read
tools list actual collection names, lifecycle, searchable and sortable fields.
Root readOnly remains the existing way to require Procedure-owned writes;
declaring a Procedure alone does not disable normal authoring.

Discovery is not enforcement: the dispatcher rejects absent catalog names,
checks the target row for readOnly and lifecycle suitability, and binds
per-collection updates to their declared collection before mutation. Unsupported
lifecycle calls return CONFLICT with an explicit reason; wrong-collection IDs
return NOT_FOUND. Existing status/OCC checks remain in the use cases.

Compatibility: operational-only and read-only sites lose unusable generic
tools. Clients must rediscover tools rather than retaining a global tool list.
Mixed sites must choose a collection listed in the tool description. Public
catalogs remain only declared capabilities and gain no collection metadata.
