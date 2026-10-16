import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ContactRound, Search } from "lucide-react";
import { useAdminLocation, useAdminRouter } from "../../app/router";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type { MemberListResult, AdminRole } from "../../lib/types";
import { useCursorPagination } from "../../lib/use-cursor-pagination";
import { formatTimestampMs } from "../content/field-render";
import { Badge } from "@aotter/mantle-ui/kit";
import { Button } from "@aotter/mantle-ui/kit";
import { Input } from "@aotter/mantle-ui/kit";
import { Skeleton } from "@aotter/mantle-ui/kit";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aotter/mantle-ui/kit";
import { EmptyState, ErrorBox, LoadMore, PageHeader, SectionCard } from "../../ui/page";
import { IdValue } from "../../ui/id-value";

const MEMBER_PAGE_SIZE = 50;

export function MembersView(): React.ReactElement {
  const { language } = usePreferences();
  const queryClient = useQueryClient();
  const { search: locationSearch } = useAdminLocation();
  const params = new URLSearchParams(locationSearch);
  const search = params.get("search")?.trim() ?? "";
  const membersPage = (cursor?: string) => {
    const query = new URLSearchParams({ limit: String(MEMBER_PAGE_SIZE) });
    if (search) query.set("search", search);
    if (cursor) query.set("cursor", cursor);
    return api.get<MemberListResult>(`/members?${query.toString()}`);
  };
  const members = useQuery<MemberListResult>({ queryKey: ["members", search], queryFn: () => membersPage() });
  const pagination = useCursorPagination(members.data, { resetKey: search, resetOnPageChange: true, loadPage: membersPage });
  const promote = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: AdminRole }) =>
      api.patch(`/admin/${encodeURIComponent(userId)}/role`, { role }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["members"] });
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
  });

  return (
    <div>
      <PageHeader
        title={t(language, "members.page.title")}
        description={t(language, "members.page.body")}
      />
      <MemberSearch search={search} />
      {promote.isError ? <ErrorBox error={promote.error} /> : null}
      {members.isLoading ? <Skeleton className="h-64 w-full" /> : null}
      {members.isError ? <ErrorBox error={members.error} /> : null}
      {members.data && pagination.items.length === 0 ? (
        <EmptyState
          icon={ContactRound}
          title={t(language, search ? "members.emptySearch.title" : "members.empty.title")}
          description={t(language, search ? "members.emptySearch.body" : "members.empty.body")}
        />
      ) : null}
      {members.data && pagination.items.length > 0 ? (
        <>
          <SectionCard className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t(language, "collection.table.id")}</TableHead>
                  <TableHead>{t(language, "members.table.name")}</TableHead>
                  <TableHead>{t(language, "members.table.email")}</TableHead>
                  <TableHead>{t(language, "members.table.status")}</TableHead>
                  <TableHead>{t(language, "admin.table.role")}</TableHead>
                  <TableHead>{t(language, "members.table.joined")}</TableHead>
                  <TableHead>{t(language, "members.table.teamAccess")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagination.items.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell><IdValue value={member.id} language={language} /></TableCell>
                    <TableCell className="font-medium">{member.name}</TableCell>
                    <TableCell>{member.email}</TableCell>
                    <TableCell>
                      <Badge variant={member.emailVerified ? "default" : "secondary"}>
                        {t(language, member.emailVerified ? "members.verified" : "members.unverified")}
                      </Badge>
                    </TableCell>
                    <TableCell>{(member.role ?? "").split(",").map(role => role.trim()).filter(Boolean).join(", ") || t(language, "admin.role.none")}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTimestampMs(Date.parse(member.createdAt)) ?? "-"}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        disabled={promote.isPending}
                        onClick={() => promote.mutate({ userId: member.id, role: members.data?.adminRoles?.[0] ?? "admin" })}
                        aria-label={`${t(language, "members.promote")}: ${member.name}`}
                      >
                        {t(language, "members.promote")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </SectionCard>
          <LoadMore pagination={pagination} language={language} />
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

function membersHref(search: string): string {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  const suffix = params.toString();
  return `/admin/members${suffix ? `?${suffix}` : ""}`;
}
