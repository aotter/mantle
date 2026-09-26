import { expect, it } from "vitest";
import { checkSchemaAdminUi, checkViewAdminUi, schemaSortableFields } from "../src/domain/service/SchemaAdminUiChecker.js";
import { projectSchemaAdminUi, projectViewAdminUi } from "../src/domain/service/ValidatedAdminUiProjection.js";
import type { SchemaManifest, ViewManifest } from "../src/domain/model/ManifestGrammar.js";

it("projects the same Admin descriptors from validated manifests without rechecking", () => {
  const schema: SchemaManifest = {
    apiVersion: "cms.mantle.aotter.net/v1", kind: "Schema", metadata: { name: "orders" },
    spec: {
      title: "Orders", lifecycle: "operational",
      schema: { type: "object", required: ["customerId", "state"], properties: {
        customerId: { type: "string", "x-mantle-ref": "customers" },
        state: { type: "string", enum: ["open", "done"] },
      } },
      indexes: [["customerId"], ["state"]],
      uiSchema: { list: { filterField: "state", primaryField: "state", columns: ["id"] }, nav: { standalone: true } },
    },
  };
  const checked = checkSchemaAdminUi(schema);
  expect(checked.problems).toEqual([]);
  const projected = projectSchemaAdminUi(schema);
  expect(projected).toEqual({
    filter: checked.filter, list: checked.list, nav: checked.nav, sortableFields: schemaSortableFields(schema),
  });

  const view: ViewManifest = {
    apiVersion: "cms.mantle.aotter.net/v1", kind: "View", metadata: { name: "orders" },
    spec: { surface: "staff", from: "orders", uiSchema: { list: { columns: ["id"], searchFields: ["state"], filterFields: ["state"] } } },
  };
  expect(checkViewAdminUi(view).problems).toEqual([]);
  expect(projectViewAdminUi(view)).toEqual(checkViewAdminUi(view).list);
});
