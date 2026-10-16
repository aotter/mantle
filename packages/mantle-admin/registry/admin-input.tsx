import { type InputProps } from "@aotter/mantle-admin/app";

/**
 * Surface: browser (the record page; never an MCP Procedure action form).
 * Slots: input:<schema>.<field>
 * Server authorization still applies to reads and writes; replacing this component grants nothing.
 */

/** The control of one text field. Narrow `InputProps` to `InputProps<string>` once your generated types name the field. */
export function AdminInput({ value, onChange, readOnly, property }: InputProps) {
  const maxLength = typeof property["maxLength"] === "number" ? property["maxLength"] : undefined;
  return (
    <input
      type="text"
      className="w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm"
      value={typeof value === "string" ? value : ""}
      maxLength={maxLength}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
