import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ContactRound, Search } from "lucide-react";
import { useAdminLocation, useAdminRouter } from "../../app/router";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type { MemberListResult } from "../../lib/types";
import { cn } from "../../lib/utils";
import { formatTimestampMs } from "../content/field-render";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, ErrorBox, PageHeader, SectionCard } from "../../ui/page";

const MEMBER_PAGE_SIZE = 50;

export function MembersView(): React.ReactElement {
  const { language } = usePreferences();
  const { search: locationSearch } = useAdminLocation();
  const params = new URLSearchParams(locationSearch);
  const search = params.get("search")?.trim() ?? "";
  const cursor = params.get("cursor") || undefined;
  const cursorDirection = params.get("cursor_direction") === "backward" ? "backward" : "forward";
  const members = useQuery<MemberListResult>({
    queryKey: ["members", search, cursor ?? "first", cursorDirection],
    queryFn: () => {
      const query = new URLSearchParams({ limit: String(MEMBER_PAGE_SIZE) });
      if (search) query.set("search", search);
      if (cursor) query.set("cursor", cursor);
      if (cursorDirection === "backward") query.set("cursor_direction", "backward");
      return api.get<MemberListResult>(`/members?${query.toString()}`);
    },
  });

  return (
    <div>
      <PageHeader
        title={t(language, "members.page.title")}
        description={t(language, "members.page.body")}
      />
      <MemberSearch search={search} />
      {members.isLoading ? <Skeleton className="h-64 w-full" /> : null}
      {members.isError ? <ErrorBox error={members.error} /> : null}
      {members.data?.items.length === 0 ? (
        <EmptyState
          icon={ContactRound}
          title={t(language, search ? "members.emptySearch.title" : "members.empty.title")}
          description={t(language, search ? "members.emptySearch.body" : "members.empty.body")}
        />
      ) : null}
      {members.data && members.data.items.length > 0 ? (
        <>
          <SectionCard className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t(language, "members.table.name")}</TableHead>
                  <TableHead>{t(language, "members.table.email")}</TableHead>
                  <TableHead>{t(language, "members.table.status")}</TableHead>
                  <TableHead>{t(language, "members.table.joined")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.data.items.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell className="font-medium">{member.name}</TableCell>
                    <TableCell>{member.email}</TableCell>
                    <TableCell>
                      <Badge variant={member.emailVerified ? "default" : "secondary"}>
                        {t(language, member.emailVerified ? "members.verified" : "members.unverified")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTimestampMs(Date.parse(member.createdAt)) ?? "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </SectionCard>
          <MemberPagination
            search={search}
            previousCursor={members.data.previous_cursor}
            nextCursor={members.data.next_cursor}
          />
        </>
      ) : null}
    </div>
  );
}

function MemberSearch({ search }: { search: string }): React.ReactElement {
  const { language } = usePreferences();
  const { navigate } = useAdminRouter();
  const [draft, setDraft] = React.useState(search);
  React.useEffect(() => setDraft(search), [search]);
  return (
    <form
      className="mb-4 flex max-w-xl gap-2"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        navigate(membersHref(draft.trim()));
      }}
    >
      <label className="relative block flex-1" aria-label={t(language, "members.searchPlaceholder")}>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          className="h-9 ps-9"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t(language, "members.searchPlaceholder")}
        />
      </label>
      <Button type="submit" variant="secondary" size="sm" className="h-9">
        <Search aria-hidden />
        {t(language, "members.search")}
      </Button>
    </form>
  );
}

function MemberPagination({
  search,
  previousCursor,
  nextCursor,
}: {
  search: string;
  previousCursor: string | null;
  nextCursor: string | null;
}): React.ReactElement | null {
  const { language } = usePreferences();
  if (!previousCursor && !nextCursor) return null;
  return (
    <Pagination className="mt-4 justify-end" aria-label={t(language, "members.pagination")}>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href={previousCursor ? membersHref(search, previousCursor, "backward") : undefined}
            text={t(language, "members.previousPage")}
            aria-label={t(language, "members.previousPage")}
            aria-disabled={!previousCursor || undefined}
            tabIndex={previousCursor ? undefined : -1}
            className={cn(!previousCursor && "pointer-events-none opacity-50")}
          />
        </PaginationItem>
        <PaginationItem>
          <PaginationNext
            href={nextCursor ? membersHref(search, nextCursor, "forward") : undefined}
            text={t(language, "members.nextPage")}
            aria-label={t(language, "members.nextPage")}
            aria-disabled={!nextCursor || undefined}
            tabIndex={nextCursor ? undefined : -1}
            className={cn(!nextCursor && "pointer-events-none opacity-50")}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

function membersHref(
  search: string,
  cursor?: string,
  direction: "forward" | "backward" = "forward",
): string {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (cursor) params.set("cursor", cursor);
  if (direction === "backward") params.set("cursor_direction", "backward");
  const suffix = params.toString();
  return `/admin/members${suffix ? `?${suffix}` : ""}`;
}
