import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api, ApiError } from "../../lib/api";
import type { AdminUser, StaffRole, StaffUser } from "../../lib/types";
import { Button } from "../../ui/button";
import { ErrorBox, PageHeader, SectionCard } from "../../ui/page";

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
    return <div className="glass-card h-64 animate-pulse" />;
  }

  const roleLabel = (role: StaffRole | "none"): string =>
    t(language, `staff.role.${role}`);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="AotterMantle"
        title={t(language, "staff.page.title")}
        description={t(language, "staff.page.body")}
      />
      {setRole.isError ? <ErrorBox error={asRenderable(setRole.error)} /> : null}
      {revoke.isError ? <ErrorBox error={asRenderable(revoke.error)} /> : null}
      <InviteCard onInvited={refetch} />
      <SectionCard className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left [&>th]:px-4 [&>th]:py-3 [&>th]:font-medium">
              <th>{t(language, "staff.table.name")}</th>
              <th>{t(language, "staff.table.email")}</th>
              <th>{t(language, "staff.table.status")}</th>
              <th>{t(language, "staff.table.role")}</th>
            </tr>
          </thead>
          <tbody>
            {staff.data.users.map((user) => {
              const isSelf = user.id === me.data?.userId;
              const invited = !user.emailVerified && !user.githubLogin;
              const current: StaffRole | "none" = isStaffRole(user.role)
                ? user.role
                : "none";
              return (
                <tr key={user.id} className="border-b last:border-b-0 [&>td]:px-4 [&>td]:py-3">
                  <td>{user.name}</td>
                  <td>{user.email}</td>
                  <td>
                    {invited ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                          {t(language, "staff.badge.invited")}
                        </span>
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
                  </td>
                  <td>
                    {isSelf ? (
                      <span className="text-muted-foreground">
                        {roleLabel(current)} · {t(language, "staff.self")}
                      </span>
                    ) : (
                      <select
                        className="admin-input max-w-56"
                        value={current}
                        disabled={setRole.isPending}
                        onChange={(event) => {
                          const next = event.target.value;
                          setRole.mutate({
                            userId: user.id,
                            role: isStaffRole(next) ? next : null,
                          });
                        }}
                      >
                        {ASSIGNABLE.map((role) => (
                          <option key={role} value={role}>
                            {roleLabel(role)}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </SectionCard>
      <p className="text-sm text-muted-foreground">
        {t(language, "staff.invite.hint")}
      </p>
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
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid min-w-64 flex-1 gap-1.5 text-sm font-medium">
          <span>{t(language, "staff.invite.emailLabel")}</span>
          <input
            className="admin-input"
            type="email"
            value={email}
            placeholder={t(language, "staff.invite.emailPlaceholder")}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          <span>{t(language, "staff.invite.roleLabel")}</span>
          <select
            className="admin-input"
            value={role}
            onChange={(event) => {
              const next = event.target.value;
              if (isStaffRole(next)) setRole(next);
            }}
          >
            {INVITABLE.map((option) => (
              <option key={option} value={option}>
                {t(language, `staff.role.${option}`)}
              </option>
            ))}
          </select>
        </label>
        <Button
          onClick={() => invite.mutate()}
          disabled={invite.isPending || email.trim() === ""}
        >
          <UserPlus className="size-4" aria-hidden />
          {invite.isPending
            ? t(language, "staff.invite.sending")
            : t(language, "staff.invite.button")}
        </Button>
      </div>
    </SectionCard>
  );
}

function isStaffRole(value: string | null): value is StaffRole {
  return value === "owner" || value === "editor" || value === "contributor";
}

/** The server returns structured diagnostics; surface their `message`
 *  instead of the generic "409 Conflict" statusText. */
function asRenderable(error: unknown): unknown {
  if (error instanceof ApiError) {
    const body = error.body as { diagnostic?: { message?: string } } | null;
    const message = body?.diagnostic?.message;
    if (message) return new Error(message);
  }
  return error;
}
