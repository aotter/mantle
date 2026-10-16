import { type InputProps, type SurfaceProp } from "@aotter/mantle-admin/app";

/**
 * Surface: both (the browser, and the Admin MCP App in an MCP host's sandboxed iframe).
 * Slots: input:<schema>.<field>
 * Rules: read data only through @aotter/mantle-admin/hooks, link only with <AdminLink> or useOpenLink(), make no
 * network calls of your own, keep no auth in cookies or browser storage, open no windows, assume no width, load
 * nothing from a remote origin. Branch on `surface` if you must; both branches have to render.
 */

/** The control of one text field. Narrow `InputProps` to `InputProps<string>` once your generated types name the field. */
export function AdminInput({ value, onChange, readOnly, property }: InputProps & SurfaceProp) {
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
