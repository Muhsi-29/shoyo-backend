import { describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

// Account settings for this file only. vi.hoisted runs before the imports below load the config.
vi.hoisted(() => {
    process.env.ADMIN_EMAIL = "Boss@Example.com";
    process.env.ADMIN_PASSWORD = "admin-password-1";
    process.env.DEMO_BUYER_EMAIL = "shopper@example.com";
    process.env.DEMO_BUYER_PASSWORD = "shopper-password-1";
});

const { default: prisma } = await import("../src/db.js");
const { ensureAdminAccount, ensureDemoBuyerAccount } = await import("../src/services/accounts.js");
const { API, api, setupTestDatabase } = await import("./helpers.js");

setupTestDatabase();

const passwordMatches = async (email: string, password: string) =>
    bcrypt.compare(password, (await prisma.user.findUniqueOrThrow({ where: { email } })).password);

describe("accounts from .env", () => {
    it("creates the admin (email lowercased) and the demo shopper, who can then log in", async () => {
        expect(await ensureAdminAccount()).toBe("boss@example.com");
        expect(await ensureDemoBuyerAccount()).toBe("shopper@example.com");

        const admin = await api().post(`${API}/auth/admin/login`).send({ email: "boss@example.com", password: "admin-password-1" });
        expect(admin.status).toBe(200);
        const shopper = await api().post(`${API}/auth/login`).send({ email: "shopper@example.com", password: "shopper-password-1" });
        expect(shopper.body.data.role).toBe("BUYER");
    });

    it("makes an existing account with ADMIN_EMAIL an admin", async () => {
        await prisma.user.create({ data: { email: "boss@example.com", password: await bcrypt.hash("old-password", 4), name: "Boss", role: "BUYER" } });
        await ensureAdminAccount();
        expect((await prisma.user.findUniqueOrThrow({ where: { email: "boss@example.com" } })).role).toBe("ADMIN");
    });

    it("leaves existing passwords alone on server start, but the seed syncs them to .env", async () => {
        await prisma.user.create({ data: { email: "shopper@example.com", password: await bcrypt.hash("old-password", 4), name: "Shopper", role: "BUYER" } });

        await ensureDemoBuyerAccount(); // What server start does
        expect(await passwordMatches("shopper@example.com", "old-password")).toBe(true);

        await ensureDemoBuyerAccount({ syncPassword: true }); // What the seed does
        expect(await passwordMatches("shopper@example.com", "shopper-password-1")).toBe(true);
    });
});
