import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, MailWarning, UserPlus } from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { useAdminLocation, useAdminRouter } from "../../app/router";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { asRenderable } from "../../lib/errors";
import { authMethodsQueryOptions, siteQueryOptions } from "../../lib/queries";
import type { AdminUser, AdminRole, AdminIdentity } from "../../lib/types";
import { Button } from "@aotter/mantle-ui/kit";
import { Badge } from "@aotter/mantle-ui/kit";
import { Input } from "@aotter/mantle-ui/kit";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aotter/mantle-ui/kit";
import { Skeleton } from "@aotter/mantle-ui/kit";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aotter/mantle-ui/kit";
import { ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { ListQueryToolbar } from "../../ui/list-query-toolbar";
import { IdValue } from "../../ui/id-value";

const EMAIL_SETUP_GUIDE_URL = "https://developers.cloudflare.com/email-service/";
const EMAIL_SETUP_PROMPT = `Enable email sign-in for this Mantle site. Implement the Mantle EmailSender port with a transactional email provider. For Cloudflare, prefer an Email Service binding. Wire the app-owned Better Auth emailOTP or magicLink plugin to that sender, select its native auth schema when generating, keep credentials in Worker secrets, deploy, then verify that /api/auth/methods lists the method and a real email arrives.`;

export function AdminView(): React.ReactElement {
  const { language } = usePreferences();
  const { search: locationSearch } = useAdminLocation();
  const { navigate } = useAdminRouter();
  const queryClient = useQueryClient();
  const search = new URLSearchParams(locationSearch).get("search")?.trim() ?? "";

  const me = useQuery<AdminUser>({
    queryKey: ["me"],
    queryFn: () => api.get<AdminUser>("/me"),
    retry: false,
  });
  const admin = useQuery<{ users: AdminIdentity[]; adminRoles?: string[] }>({
    queryKey: ["admin"],
    queryFn: () => api.get<{ users: AdminIdentity[]; adminRoles?: string[] }>("/admin"),
    retry: false,
  });
  const authMethods = useQuery(authMethodsQueryOptions());
  const hasEmailSignIn = authMethods.data?.some(
    ({ kind }) => kind === "email-otp" || kind === "magic-link",
  );

  const refetch = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
  };

  const setRole = useMutation({
    mutationFn: (input: { userId: string; role: AdminRole | null }) =>
      api.patch(`/admin/${encodeURIComponent(input.userId)}/role`, {
        role: input.role,
      }),
    onSettled: refetch,
  });
  const revoke = useMutation({
    mutationFn: (userId: string) =>
      api.delete(`/admin/invitations/${encodeURIComponent(userId)}`),
    onSettled: refetch,
  });

  if (admin.isError) return <ErrorBox error={admin.error} />;
  if (admin.isLoading || !admin.data) {
    return <Skeleton className="h-64 w-full" />;
  }

  const adminRoles = admin.data.adminRoles ?? ["admin"];
  const roleLabel = (role: AdminRole | "__none"): string =>
    role === "__none" ? t(language, "admin.role.none") : role === "admin" ? t(language, "admin.role.admin") : role;
  const term = search.toLowerCase();
  const users = term
    ? admin.data.users.filter((user) =>
        [user.id, user.name, user.email, user.githubLogin].some((value) => value?.toLowerCase().includes(term)))
    : admin.data.users;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t(language, "admin.page.title")}
        description={t(language, "admin.page.body")}
      />
      {setRole.isError ? <ErrorBox error={asRenderable(setRole.error)} /> : null}
      {revoke.isError ? <ErrorBox error={asRenderable(revoke.error)} /> : null}
      {authMethods.data && !hasEmailSignIn ? <EmailSignInSetup /> : null}
      <InviteCard onInvited={refetch} role={adminRoles[0]} />
      <ListQueryToolbar
        key={search}
        language={language}
        searchValue={search}
        onSubmit={({ search: next }) => navigate(next ? `/admin/admin?${new URLSearchParams({ search: next })}` : "/admin/admin")}
      />
      <SectionCard className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t(language, "collection.table.id")}</TableHead>
              <TableHead>{t(language, "admin.table.name")}</TableHead>
              <TableHead>{t(language, "admin.table.email")}</TableHead>
              <TableHead>{t(language, "admin.table.status")}</TableHead>
              <TableHead>{t(language, "admin.table.role")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => {
              const isSelf = user.id === me.data?.userId;
              const invited = !user.emailVerified && !user.githubLogin;
              const roles = (user.role ?? "").split(",").map(role => role.trim()).filter(Boolean);
              const current = roles.find(role => adminRoles.includes(role)) ?? "__none";
              return (
                <TableRow key={user.id}>
                  <TableCell><IdValue value={user.id} language={language} /></TableCell>
                  <TableCell>{user.name}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>
                    {invited ? (
                      <span className="inline-flex items-center gap-2">
                        <Badge variant="secondary">
                          {t(language, "admin.badge.invited")}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(user.id)}
                        >
                          {t(language, "admin.invite.revoke")}
                        </Button>
                      </span>
                    ) : user.githubLogin ? (
                      `GitHub: ${user.githubLogin}`
                    ) : (
                      t(language, "admin.status.emailSignIn")
                    )}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={current}
                      disabled={setRole.isPending}
                      onValueChange={(next) => {
                        setRole.mutate({
                          userId: user.id,
                          role: next === "__none" ? null : next,
                        });
                      }}
                    >
                      <SelectTrigger className="w-44">
                        <SelectValue>{roles.map(roleLabel).join(", ") || roleLabel("__none")}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {[...adminRoles, "__none"].map((role) => (
                          <SelectItem key={role} value={role}>
                            {roleLabel(role)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {isSelf ? <span className="text-muted-foreground">{t(language, "admin.self")}</span> : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </SectionCard>
    </div>
  );
}

function InviteCard({ onInvited, role }: { onInvited: () => void; role?: string }): React.ReactElement {
  const { language } = usePreferences();
  const site = useQuery(siteQueryOptions());
  const [email, setEmail] = React.useState("");

  const invite = useMutation({
    mutationFn: () => api.post("/admin/invitations", { email, role }),
    onSuccess: () => {
      setEmail("");
      onInvited();
    },
  });

  return (
    <SectionCard className="grid gap-4">
      <h2 className="text-sm font-semibold">{t(language, "admin.invite.title")}</h2>
      {invite.isError ? <ErrorBox error={asRenderable(invite.error)} /> : null}
      <form
        className="grid max-w-4xl gap-4 md:grid-cols-[minmax(0,1fr)_18rem]"
        onSubmit={(event) => {
          event.preventDefault();
          invite.mutate();
        }}
      >
        <label className="grid min-w-64 flex-1 gap-1.5 text-sm font-medium">
          <span>{t(language, "admin.invite.emailLabel")}</span>
          <Input
            type="email"
            value={email}
            placeholder={t(language, "admin.invite.emailPlaceholder")}
            onChange={(event) => setEmail(event.target.value)}
          />
          <span className="text-xs font-normal leading-5 text-muted-foreground">
            {t(language, site.data?.capabilities?.invitationEmail === true ? "admin.invite.hint" : "admin.invite.hintNoEmail")}
          </span>
        </label>
        <div className="grid content-start gap-1.5 text-sm">
          <span className="font-medium">{t(language, "admin.role.admin")}</span>
          <span className="text-xs leading-5 text-muted-foreground">{t(language, "admin.role.admin.help")}</span>
        </div>
        <div className="flex justify-end md:col-span-2">
          <Button
            type="submit"
            disabled={!role || invite.isPending || email.trim() === ""}
          >
            <UserPlus className="size-4" aria-hidden />
            {invite.isPending
              ? t(language, "admin.invite.sending")
              : t(language, "admin.invite.button")}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}

function EmailSignInSetup(): React.ReactElement {
  const { language } = usePreferences();
  const [copied, setCopied] = React.useState(false);

  async function copySetupPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(EMAIL_SETUP_PROMPT);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <SectionCard className="flex-row flex-wrap items-center gap-4">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
        <MailWarning className="size-5" aria-hidden />
      </span>
      <div className="min-w-64 flex-1">
        <h2 className="font-semibold">{t(language, "admin.emailSetup.title")}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {t(language, "admin.emailSetup.body")}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => void copySetupPrompt()}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {t(language, copied ? "admin.emailSetup.copied" : "admin.emailSetup.copy")}
        </Button>
        <Button asChild variant="outline">
          <a href={EMAIL_SETUP_GUIDE_URL} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden />
            {t(language, "admin.emailSetup.guide")}
          </a>
        </Button>
      </div>
    </SectionCard>
  );
}
