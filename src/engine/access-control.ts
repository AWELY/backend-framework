/**
 * Role-based access control: roles map to permissions, and routes check a
 * PERMISSION ("products:write"), not a role name. Adding a role or moving a
 * permission between roles is then a change to this map only - no route changes.
 *
 * Permission strings are "<resource>:<action>". A role may hold "*" (everything)
 * or "<resource>:*" (every action on one resource).
 */

export type Permission = string;
export type RolePermissions = Record<string, readonly Permission[]>;

/** Default policy for a small store. Applications can pass their own map instead. */
export const DEFAULT_ROLES: RolePermissions = {
  owner: ["*"],
  customer: [
    "products:read",
    "categories:read",
    "cart:manage",
    "orders:create",
    "orders:read-own",
    "profile:manage",
  ],
};

export class AccessControl {
  constructor(private readonly roles: RolePermissions = DEFAULT_ROLES) {}

  can(role: string | undefined, permission: Permission): boolean {
    if (!role) return false;
    const granted = this.roles[role];
    if (!granted) return false;
    const resource = permission.split(":")[0];
    return granted.some((p) => p === "*" || p === permission || p === `${resource}:*`);
  }

  hasRole(role: string): boolean {
    return role in this.roles;
  }
}
