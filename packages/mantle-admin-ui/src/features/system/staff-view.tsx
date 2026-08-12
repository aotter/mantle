import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, MailWarning, UserPlus } from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { asRenderable } from "../../lib/errors";
import { authMethodsQueryOptions } from "../../lib/queries";
import type { AdminUser, StaffRole, StaffUser } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ErrorBox, PageHeader, SectionCard } from "../../ui/page";

const EMAIL_SETUP_GUIDE_URL = "https://developers.cloudflare.com/email-service/";
const EMAIL_SETUP_PROMPT = `Enable email sign-in for this Mantle site. Implement the Mantle EmailSender port with a transactional email provider. For Cloudflare, prefer an Email Service binding. Register either { kind: "email-otp", sender } or { kind: "magic-link", sender } in createAuth(), keep credentials in Worker secrets, deploy, then verify that /api/auth/methods lists the method and a real email arrives.`;

/** Owner-only staff management: list every user, assign roles, invite
 *  by email. The server enforces owner-only (403 for editor and
 *  contributor) and the self-role-change guard; this view renders
 *  those denials, it does not re-derive them. */

const ASSIGNABLE: ReadonlyArray<StaffRole | "none"> = [
  "owner",
  "editor",
  "contributor",
  "none",
];
const INVITABLE: ReadonlyArray<StaffRole> = ["owner", "editor", "contributor"];

export function StaffView(): React.ReactElement {
  const { language } = usePreferences();
  const queryClient = useQueryClient();

  const me = useQuery<AdminUser>({
    queryKey: ["me"],
    queryFn: () => api.get<AdminUser>("/me"),
    retry: false,
  });
  const staff = useQuery<{ users: StaffUser[] }>({
    queryKey: ["staff"],
    queryFn: () => api.get<{ users: StaffUser[] }>("/staff"),
    retry: false,
  });
  const authMethods = useQuery(authMethodsQueryOptions());
  const hasEmailSignIn = authMethods.data?.some(
    ({ kind }) => kind === "email-otp" || kind === "magic-link",
  );

  const refetch = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["staff"] });
  };

  const setRole = useMutation({
    mutationFn: (input: { userId: string; role: StaffRole | null }) =>
      api.patch(`/staff/${encodeURIComponent(input.userId)}/role`, {
        role: input.role,
      }),
    onSettled: refetch,
  });
  const revoke = useMutation({
    mutationFn: (userId: string) =>
      api.delete(`/staff/invitations/${encodeURIComponent(userId)}`),
    onSettled: refetch,
  });

  if (staff.isError) return <ErrorBox error={staff.error} />;
  if (staff.isLoading || !staff.data) {
    return <Skeleton className="h-64 w-full" />;
  }

  const roleLabel = (role: StaffRole | "none"): string =>
    t(language, `staff.role.${role}`);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t(language, "staff.page.title")}
        description={t(language, "staff.page.body")}
      />
      {setRole.isError ? <ErrorBox error={asRenderable(setRole.error)} /> : null}
      {revoke.isError ? <ErrorBox error={asRenderable(revoke.error)} /> : null}
      {authMethods.data && !hasEmailSignIn ? <EmailSignInSetup /> : null}
      <InviteCard onInvited={refetch} />
      <SectionCard className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t(language, "staff.table.name")}</TableHead>
              <TableHead>{t(language, "staff.table.email")}</TableHead>
              <TableHead>{t(language, "staff.table.status")}</TableHead>
              <TableHead>{t(language, "staff.table.role")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {staff.data.users.map((user) => {
              const isSelf = user.id === me.data?.userId;
              const invited = !user.emailVerified && !user.githubLogin;
              const current: StaffRole | "none" = isStaffRole(user.role)
                ? user.role
                : "none";
              return (
                <TableRow key={user.id}>
                  <TableCell>{user.name}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>
                    {invited ? (
                      <span className="inline-flex items-center gap-2">
                        <Badge variant="secondary">
                          {t(language, "staff.badge.invited")}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(user.id)}
                        >
                          {t(language, "staff.invite.revoke")}
                        </Button>
                      </span>
                    ) : user.githubLogin ? (
                      `GitHub: ${user.githubLogin}`
                    ) : (
                      t(language, "staff.status.emailSignIn")
                    )}
                  </TableCell>
                  <TableCell>
                    {isSelf ? (
                      <span className="text-muted-foreground">
                        {roleLabel(current)} · {t(language, "staff.self")}
                      </span>
                    ) : (
                      <Select
                        value={current}
                        disabled={setRole.isPending}
                        onValueChange={(next) => {
                          setRole.mutate({
                            userId: user.id,
                            role: isStaffRole(next) ? next : null,
                          });
                        }}
                      >
                        <SelectTrigger className="w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ASSIGNABLE.map((role) => (
                            <SelectItem key={role} value={role}>
                              {roleLabel(role)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
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

function InviteCard({ onInvited }: { onInvited: () => void }): React.ReactElement {
  const { language } = usePreferences();
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<StaffRole>("contributor");

  const invite = useMutation({
    mutationFn: () => api.post("/staff/invitations", { email, role }),
    onSuccess: () => {
      setEmail("");
      onInvited();
    },
  });

  return (
    <SectionCard className="grid gap-4">
      <h2 className="text-sm font-semibold">{t(language, "staff.invite.title")}</h2>
      {invite.isError ? <ErrorBox error={asRenderable(invite.error)} /> : null}
      <form
        className="grid max-w-4xl gap-4 md:grid-cols-[minmax(0,1fr)_18rem]"
        onSubmit={(event) => {
          event.preventDefault();
          invite.mutate();
        }}
      >
        <label className="grid min-w-64 flex-1 gap-1.5 text-sm font-medium">
          <span>{t(language, "staff.invite.emailLabel")}</span>
          <Input
            type="email"
            value={email}
            placeholder={t(language, "staff.invite.emailPlaceholder")}
            onChange={(event) => setEmail(event.target.value)}
          />
          <span className="text-xs font-normal leading-5 text-muted-foreground">
            {t(language, "staff.invite.hint")}
          </span>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          <span>{t(language, "staff.invite.roleLabel")}</span>
          <Select
            value={role}
            onValueChange={(next) => {
              if (isStaffRole(next)) setRole(next);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue>{t(language, `staff.role.${role}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent className="min-w-72">
              {INVITABLE.map((option) => (
                <SelectItem
                  key={option}
                  value={option}
                  textValue={t(language, `staff.role.${option}`)}
                  className="items-start py-2"
                >
                  <span className="grid gap-0.5">
                    <span className="font-medium">
                      {t(language, `staff.role.${option}`)}
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {t(language, `staff.role.${option}.help`)}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="max-w-56 text-xs font-normal leading-5 text-muted-foreground">
            {t(language, `staff.role.${role}.help`)}
          </span>
        </label>
        <div className="flex justify-end md:col-span-2">
          <Button
            type="submit"
            disabled={invite.isPending || email.trim() === ""}
          >
            <UserPlus className="size-4" aria-hidden />
            {invite.isPending
              ? t(language, "staff.invite.sending")
              : t(language, "staff.invite.button")}
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
        <h2 className="font-semibold">{t(language, "staff.emailSetup.title")}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {t(language, "staff.emailSetup.body")}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => void copySetupPrompt()}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {t(language, copied ? "staff.emailSetup.copied" : "staff.emailSetup.copy")}
        </Button>
        <Button asChild variant="outline">
          <a href={EMAIL_SETUP_GUIDE_URL} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden />
            {t(language, "staff.emailSetup.guide")}
          </a>
        </Button>
      </div>
    </SectionCard>
  );
}

function isStaffRole(value: string | null): value is StaffRole {
  return value === "owner" || value === "editor" || value === "contributor";
}
