import type { StaffRole } from "@prisma/client";

// What each admin role can do. Routes check one permission each (see requirePermission), and the admin
// panel receives the list with the logged-in admin, so it only shows what they can use.

export const PERMISSIONS = [
    "dashboard",  // Store numbers and charts
    "orders",     // View, ship and cancel orders; export them
    "returns",    // Approve or reject return requests
    "customers",  // View customers; block and unblock accounts
    "messages",   // Contact messages and newsletter subscribers
    "reviews",    // Remove reviews
    "catalog",    // Add and edit products; approve or reject seller listings
    "homepage",   // Homepage banners
    "coupons",    // Discount codes
    "sellers",    // Approve, suspend and set commission for stores
    "payouts",    // Record payouts to sellers
    "settings",   // Store rules: delivery, returns, commission, payments, offers bar
    "admins",     // Add, change and remove admins
    "activity",   // The activity log
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
    FULL: PERMISSIONS,
    SUPPORT: ["dashboard", "orders", "returns", "customers", "messages", "reviews"],
    CATALOG: ["dashboard", "catalog", "homepage", "coupons", "reviews"],
};

export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
    FULL: "Full access",
    SUPPORT: "Support",
    CATALOG: "Catalog & marketing",
};

export const permissionsFor = (staffRole: StaffRole | null | undefined): Permission[] =>
    staffRole ? [...ROLE_PERMISSIONS[staffRole]] : [];

export const can = (staffRole: StaffRole | null | undefined, permission: Permission) =>
    permissionsFor(staffRole).includes(permission);
