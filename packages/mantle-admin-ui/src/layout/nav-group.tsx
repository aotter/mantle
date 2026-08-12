import * as React from "react";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "../lib/utils";
import { usePreferences } from "../app/preferences";
import {
  isCollapsible,
  type NavCollapsible,
  type NavGroupData,
  type NavItem,
  type NavLink,
} from "./types";

interface NavGroupProps {
  group: NavGroupData;
  pathname: string;
  search: string;
}

export function NavGroup({
  group,
  pathname,
  search,
}: NavGroupProps): React.ReactElement {
  return (
    <SidebarGroup>
      {group.title && <SidebarGroupLabel title={group.title}>{group.title}</SidebarGroupLabel>}
      <SidebarMenu>
        {group.items.map((item) => (
          <NavGroupItem
            key={navKey(item)}
            item={item}
            pathname={pathname}
            search={search}
          />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function navKey(item: NavItem): string {
  return isCollapsible(item) ? `g:${item.title}` : `l:${item.url}`;
}

function NavGroupItem({
  item,
  pathname,
  search,
}: {
  item: NavItem;
  pathname: string;
  search: string;
}): React.ReactElement {
  const { state, isMobile } = useSidebar();
  if (!isCollapsible(item)) {
    return <NavLinkItem item={item} pathname={pathname} search={search} />;
  }
  if (state === "collapsed" && !isMobile) {
    return (
      <NavCollapsibleDropdown
        item={item}
        pathname={pathname}
        search={search}
      />
    );
  }
  return (
    <NavCollapsibleExpanded
      item={item}
      pathname={pathname}
      search={search}
    />
  );
}

function NavLinkItem({
  item,
  pathname,
  search,
}: {
  item: NavLink;
  pathname: string;
  search: string;
}): React.ReactElement {
  const { setOpenMobile } = useSidebar();
  const active = isLinkActive(item, pathname, search);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <a
          href={item.url}
          title={item.title}
          onClick={() => setOpenMobile(false)}
          {...(item.external
            ? { target: "_blank", rel: "noreferrer" }
            : null)}
        >
          {item.icon && <item.icon aria-hidden />}
          <span data-sidebar-label className="flex-1 truncate">{item.title}</span>
          {item.marker && (
            <item.marker
              aria-hidden
              data-sidebar-label
              className="size-3.5 text-muted-foreground"
            />
          )}
        </a>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function NavCollapsibleExpanded({
  item,
  pathname,
  search,
}: {
  item: NavCollapsible;
  pathname: string;
  search: string;
}): React.ReactElement {
  const groupActive = isGroupActive(item, pathname, search);
  return (
    <Collapsible
      defaultOpen={groupActive}
      className="group/collapsible"
      asChild
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton isActive={groupActive}>
            {item.icon && <item.icon aria-hidden />}
            <span data-sidebar-label className="flex-1 truncate" title={item.title}>{item.title}</span>
            {item.marker && (
              <item.marker
                aria-hidden
                data-sidebar-label
                className="size-3.5 text-muted-foreground"
              />
            )}
            <ChevronRight
              aria-hidden
              data-sidebar-label
              className="transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90 rtl:rotate-180 rtl:group-data-[state=open]/collapsible:-rotate-90"
            />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {item.items.map((sub) => (
              <NavSubLink
                key={sub.url}
                link={sub}
                siblings={item.items}
                pathname={pathname}
                search={search}
              />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function NavSubLink({
  link,
  siblings,
  pathname,
  search,
}: {
  link: NavLink;
  siblings: ReadonlyArray<NavLink>;
  pathname: string;
  search: string;
}): React.ReactElement {
  const { setOpenMobile } = useSidebar();
  const active = isSubLinkActive(link, siblings, pathname, search);
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active}>
        <a href={link.url} title={link.title} onClick={() => setOpenMobile(false)}>
          {link.icon && <link.icon aria-hidden />}
          <span>{link.title}</span>
        </a>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

function NavCollapsibleDropdown({
  item,
  pathname,
  search,
}: {
  item: NavCollapsible;
  pathname: string;
  search: string;
}): React.ReactElement {
  const groupActive = isGroupActive(item, pathname, search);
  const { direction } = usePreferences();
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton isActive={groupActive}>
            {item.icon && <item.icon aria-hidden />}
            <span data-sidebar-label title={item.title}>{item.title}</span>
            <ChevronRight aria-hidden data-sidebar-label className="ms-auto" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={direction === "rtl" ? "left" : "right"}
          align="start"
          sideOffset={4}
        >
          <DropdownMenuLabel>{item.title}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {item.items.map((sub) => (
            <DropdownMenuItem asChild key={sub.url}>
              <a
                href={sub.url}
                className={cn(
                  isSubLinkActive(sub, item.items, pathname, search) && "font-medium",
                )}
              >
                {sub.title}
              </a>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

function isLinkActive(
  link: NavLink,
  pathname: string,
  search: string,
): boolean {
  const url = new URL(link.url, "http://x");
  if (url.pathname !== pathname) return false;
  // If the link includes any query string, every param it sets must match.
  if (!url.search) return true;
  const want = new URLSearchParams(url.search);
  const have = new URLSearchParams(search);
  for (const [key, value] of want.entries()) {
    if (have.get(key) !== value) return false;
  }
  return true;
}

export function isSubLinkActive(
  link: NavLink,
  siblings: ReadonlyArray<NavLink>,
  pathname: string,
  search: string,
): boolean {
  if (!isLinkActive(link, pathname, search)) return false;
  if (new URL(link.url, "http://x").search) return true;
  return !siblings.some((sibling) => {
    if (sibling.url === link.url || !new URL(sibling.url, "http://x").search) return false;
    return isLinkActive(sibling, pathname, search);
  });
}

// Highlight (and auto-expand) the group whenever the user is on a sub-link's
// pathname — regardless of query params. Lets a base path like /admin/c/posts
// (no `?status`) keep its parent group active, even though no individual
// sub-link with `?status=…` is the exact current URL.
function isGroupActive(
  item: NavCollapsible,
  pathname: string,
  search: string,
): boolean {
  if (item.items.some((sub) => isLinkActive(sub, pathname, search))) return true;
  return item.items.some((sub) => {
    const url = new URL(sub.url, "http://x");
    return url.pathname === pathname;
  });
}
