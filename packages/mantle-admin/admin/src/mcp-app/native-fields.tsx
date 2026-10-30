import { Children, cloneElement, createContext, isValidElement, useContext, useState, type ReactElement, type ReactNode } from "react";

// The App's Select and Popover keep the kit's API with native controls (as its calendar), so Radix's select, popper and
// floating-ui stay out of the single-file App.
export const SelectTrigger = (_: Record<string, unknown>) => null;
export const SelectValue = (_: { placeholder?: ReactNode }) => null;
export const SelectContent = (_: { children?: ReactNode }) => null;
export const SelectItem = (_: { value: string; disabled?: boolean; children?: ReactNode }) => null;

function walk(children: ReactNode, visit: (child: ReactElement<Record<string, unknown>>) => void): void {
  Children.forEach(children, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    visit(child);
    walk(child.props.children as ReactNode, visit);
  });
}

export function Select({ value, onValueChange, disabled, children }: { value?: string; onValueChange?: (value: string) => void; disabled?: boolean; children?: ReactNode }) {
  let trigger: Record<string, unknown> = {}, placeholder: ReactNode;
  const options: ReactElement[] = [];
  walk(children, (child) => {
    if (child.type === SelectTrigger) trigger = child.props;
    else if (child.type === SelectValue) placeholder = child.props.placeholder as ReactNode;
    else if (child.type === SelectItem) options.push(<option key={String(child.props.value)} value={String(child.props.value)} disabled={Boolean(child.props.disabled)}>{child.props.children as ReactNode}</option>);
  });
  const { children: _, className, ...rest } = trigger;
  const empty = !value;
  return <select {...rest} disabled={disabled} value={empty ? "" : value} onChange={(event) => onValueChange?.(event.target.value)}
    className={`h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50 ${String(className ?? "")}`}>
    {empty ? <option value="" disabled hidden>{placeholder}</option> : null}
    {options}
  </select>;
}

const Open = createContext<[boolean, (open: boolean) => void]>([false, () => {}]);
/** A disclosure: the content shows under its trigger. */
export function Popover({ children }: { children?: ReactNode }) {
  const state = useState(false);
  return <Open.Provider value={state}><div className="space-y-2">{children}</div></Open.Provider>;
}
export function PopoverTrigger({ children }: { asChild?: boolean; children: ReactElement<{ onClick?: (event: unknown) => void }> }) {
  const [open, setOpen] = useContext(Open);
  const child = Children.only(children);
  return cloneElement(child, { "aria-expanded": open, onClick: (event: unknown) => { child.props.onClick?.(event); setOpen(!open); } } as Record<string, unknown>);
}
export function PopoverContent({ children, className }: { children?: ReactNode; className?: string; align?: string }) {
  const [open] = useContext(Open);
  return open ? <div className={`rounded-md border bg-popover p-2 ${className ?? ""}`}>{children}</div> : null;
}
