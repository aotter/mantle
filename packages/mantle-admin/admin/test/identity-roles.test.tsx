import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PreferencesProvider } from "../src/app/preferences";
import { AdminRouterProvider } from "../src/app/router";
import { AdminView } from "../src/features/system/admin-view";
import { MembersView } from "../src/features/system/members-view";

it("renders role lists on both identity pages, including a configured admin role", () => {
  const client = new QueryClient();
  client.setQueryData(["me"], { userId: "admin", admin: true });
  client.setQueryData(["admin"], { adminRoles: ["admin", "org-admin", "none"], users: ["admin", "org-admin", "none"].map(role => ({ id: role, name: "Admin", email: `${role}@example.test`, role: `${role},approver`, emailVerified: true })) });
  client.setQueryData(["members", "", "first", "forward"], { items: [{ id: "member", name: "Member", email: "member@example.test", role: "editor,approver", emailVerified: true, createdAt: "2026-01-01T00:00:00Z" }], previous_cursor: null, next_cursor: null });
  const render = (view: React.ReactNode) => renderToStaticMarkup(<PreferencesProvider initialLanguage="en"><QueryClientProvider client={client}><AdminRouterProvider>{view}</AdminRouterProvider></QueryClientProvider></PreferencesProvider>);
  try {
    const admins = render(<AdminView />);
    for (const role of ["admin", "org-admin", "none"]) expect(admins).toContain(`${role === "admin" ? "Administrators" : role}, approver`);
    expect(render(<MembersView />)).toContain("editor, approver");
  } finally { client.clear(); }
});
