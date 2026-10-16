import bcrypt from "bcrypt";
import type { Prisma, Role } from "@prisma/client";
import prisma from "../db.js";
import {
    ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD,
    DEMO_BUYER_EMAIL, DEMO_BUYER_NAME, DEMO_BUYER_PASSWORD,
    DEMO_SELLER_EMAIL, DEMO_SELLER_NAME, DEMO_SELLER_PASSWORD,
} from "../config.js";

interface AccountSettings {
    email: string;
    password: string;
    name: string;
    role: Role;
}

// Creates an account from .env settings if it doesn't exist yet. Returns its email, or null when the
// email or password isn't set. With syncPassword, an existing account's password is changed to match
// .env (the seed does this, so you can pick a new password by editing .env and re-running the seed).
const ensureAccount = async ({ email, password, name, role }: AccountSettings, { syncPassword = false } = {}) => {
    if (!email || !password) return null;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (!existing) {
        await prisma.user.create({
            data: { email, password: await bcrypt.hash(password, 10), name, role, staffRole: role === "ADMIN" ? "FULL" : null },
        });
        return email;
    }

    const changes: Prisma.UserUpdateInput = {};
    // ADMIN_EMAIL is the store owner: always an admin with full access, never blocked
    if (role === "ADMIN" && existing.role !== "ADMIN") changes.role = "ADMIN";
    if (role === "ADMIN" && existing.staffRole !== "FULL") changes.staffRole = "FULL";
    if (role === "ADMIN" && existing.blockedAt) changes.blockedAt = null;
    if (syncPassword && !(await bcrypt.compare(password, existing.password))) {
        changes.password = await bcrypt.hash(password, 10);
    }
    if (Object.keys(changes).length > 0) {
        await prisma.user.update({ where: { id: existing.id }, data: changes });
    }
    return email;
};

// The admin from ADMIN_EMAIL / ADMIN_PASSWORD (created on server start and by the seed)
export const ensureAdminAccount = (options?: { syncPassword?: boolean }) =>
    ensureAccount({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: ADMIN_NAME, role: "ADMIN" }, options);

// A ready-made shopper account for trying the store, from DEMO_BUYER_EMAIL / DEMO_BUYER_PASSWORD (created by the seed)
export const ensureDemoBuyerAccount = (options?: { syncPassword?: boolean }) =>
    ensureAccount({ email: DEMO_BUYER_EMAIL, password: DEMO_BUYER_PASSWORD, name: DEMO_BUYER_NAME, role: "BUYER" }, options);

// A ready-made seller account for trying the seller dashboard, from DEMO_SELLER_EMAIL / DEMO_SELLER_PASSWORD
// (created by the seed, which also gives it an approved store)
export const ensureDemoSellerAccount = (options?: { syncPassword?: boolean }) =>
    ensureAccount({ email: DEMO_SELLER_EMAIL, password: DEMO_SELLER_PASSWORD, name: DEMO_SELLER_NAME, role: "SELLER" }, options);
