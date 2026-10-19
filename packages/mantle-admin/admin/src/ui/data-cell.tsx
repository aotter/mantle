import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { usePreferences } from "../app/preferences";
import { Slot } from "../app/slots";
import type { CellProps } from "../app/slot-props";
import { renderDataValue } from "../lib/render-data-value";
import { siteQueryOptions } from "../lib/queries";
import type { JsonSchema } from "../lib/types";
import { IdValue, isIdField } from "./id-value";
import { RefLink, useRefTarget } from "./ref-value";

type Property = Readonly<Record<string, unknown>> | undefined;
interface DefaultCellProps extends CellProps {
  /** The name the value is shown under; an id-like name renders as an id. */
  readonly field?: string;
}

function DefaultCell({ value, property, field }: DefaultCellProps): React.ReactElement {
  const { language } = usePreferences();
  const canonical = useQuery(siteQueryOptions()).data?.canonicalLocale ?? null;
  const schema = property as JsonSchema | undefined;
  const target = useRefTarget(field ?? "", value);
  return <>{target && typeof value === "string"
    ? <RefLink target={target} value={value} />
    : isIdField(field ?? "", schema) && typeof value === "string"
    ? <IdValue value={value} language={language} />
    : renderDataValue(schema, value, language, canonical)}</>;
}

/**
 * One value of a list or report, as Admin shows it unless the application's `cell:` slots replace it. `names` are the
 * slots that apply, the first nearest the built-in: a Schema field, then a View column.
 */
export function DataCell({ names, field, value, row, property }: {
  names: readonly string[];
  field: string;
  value: unknown;
  row: Readonly<Record<string, unknown>>;
  property: unknown;
}): React.ReactElement {
  return <Slot name={names} Default={DefaultCell} props={{ value, row, property: property as Property, field }} />;
}
