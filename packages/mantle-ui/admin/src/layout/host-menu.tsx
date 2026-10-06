import * as React from "react";
import { isAdminPreview } from "../app/frame-policy";
import { Braces } from "lucide-react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@aotter/mantle-ui/kit";

export function HostMenu(): React.ReactElement | null {
  const [menu, setMenu] = React.useState(() => window.__MANTLE_ADMIN_PREVIEW__?.menu);
  React.useEffect(() => {
    const update = () => setMenu(window.__MANTLE_ADMIN_PREVIEW__?.menu);
    window.addEventListener("mantle:host-ui:menu", update);
    update();
    return () => window.removeEventListener("mantle:host-ui:menu", update);
  }, []);
  if (!isAdminPreview() || !menu) return null;
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={menu.label} title={menu.label} data-slot="host-menu"><Braces aria-hidden /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="max-h-[80vh] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto"><DropdownMenuLabel className="whitespace-normal">{menu.description}</DropdownMenuLabel>
      {menu.items.map(item => <DropdownMenuItem key={item.id} disabled={item.disabled} onSelect={() => window.parent.postMessage({ type: "mantle:host-ui:action", protocolVersion: 1, id: item.id }, location.origin)}>{item.label}</DropdownMenuItem>)}
    </DropdownMenuContent></DropdownMenu>;
}
