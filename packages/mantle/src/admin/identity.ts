/**
 * `AdminIdentity` (ADR-0032 decision 8): what Admin may ask an identity provider for. Every member is optional and Admin hides
 * what is absent, so an identity that only signs people in (a custom resolver) needs none of it. Display names come from
 * `directory`, never from a Store join.
 */

/** A user as the staff-management surface sees them: identity columns only, never a password hash or ban metadata. */
export interface StaffUserInfo {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: string | null;
  readonly githubLogin: string | null;
  /** `false` with no linked account is a pending invitation (it already carries its staff role). */
  readonly emailVerified: boolean;
  readonly createdAt: Date;
}

export type MemberUserInfo = Pick<StaffUserInfo, "id" | "email" | "name" | "emailVerified" | "createdAt">;

export interface ListMembersArgs {
  readonly search?: string;
  readonly cursor?: string;
  readonly cursorDirection?: "forward" | "backward";
  readonly limit: number;
}

export interface MemberListResult {
  readonly items: readonly MemberUserInfo[];
  readonly previousCursor: string | null;
  readonly nextCursor: string | null;
}

/** A stable, secret-free user projection for a service's own code. */
export interface AuthUserInfo extends StaffUserInfo {
  readonly image: string | null;
}

/** `exists` carries the prior row's id, so Admin can point at the existing user instead of failing bare. */
export type InviteUserResult = { readonly kind: "created"; readonly id: string } | { readonly kind: "exists"; readonly id: string };

/** Members that take the `Request` act as the signed-in owner who sent it, so the identity provider authorizes them too. */
export interface AdminIdentity {
  readonly directory?: {
    getUser?(userId: string): Promise<AuthUserInfo | null>;
    /** Only users with a staff role, oldest first. */
    listUsers(request: Request): Promise<readonly StaffUserInfo[]>;
    /** Everyone else, for the member-management surface. */
    listMembers(args: ListMembersArgs): Promise<MemberListResult>;
  };
  readonly roles?: {
    /** `null` revokes staff access (the user can still sign in, but every staff-gated surface refuses). False when no row matched. */
    setUserRole(request: Request, userId: string, role: "owner" | "editor" | "contributor" | null): Promise<boolean>;
    /** Pre-creates an unverified user that already holds the role, so the invitee's first sign-in lands with it. */
    inviteUser(request: Request, email: string, role: "owner" | "editor" | "contributor"): Promise<InviteUserResult>;
    /** Only an invitation nobody ever signed in to; a real user is never deleted through it. */
    revokeInvite(userId: string): Promise<boolean>;
    sendStaffInvitation?(email: string, role: "owner" | "editor" | "contributor"): Promise<void>;
  };
  /** Account deletion: the identity provider owns its users, so services stop running raw SQL against its tables. */
  deleteUser?(userId: string): Promise<boolean>;
}
