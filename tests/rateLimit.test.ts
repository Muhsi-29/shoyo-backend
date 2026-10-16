import { describe, expect, it, vi } from "vitest";

// Use small limits for this file only. vi.hoisted runs before the imports below load the app.
vi.hoisted(() => {
    process.env.LOGIN_RATE_LIMIT = "3";
    process.env.REGISTER_RATE_LIMIT = "2";
});

const { API, api, createUser, setupTestDatabase } = await import("./helpers.js");

setupTestDatabase();

describe("rate limiting", () => {
    // Runs first: the limiter remembers this IP for the rest of the file
    it("doesn't count successful logins", async () => {
        const { user, password } = await createUser();
        for (let i = 0; i < 5; i++) {
            expect((await api().post(`${API}/auth/login`).send({ email: user.email, password })).status).toBe(200);
        }
    });

    it("blocks an IP after too many failed logins", async () => {
        const { user } = await createUser();
        const attempt = () => api().post(`${API}/auth/login`).send({ email: user.email, password: "wrong-password" });

        for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
        const blocked = await attempt();
        expect(blocked.status).toBe(429);
        expect(blocked.body.message).toMatch(/Too many failed login attempts/);
    });

    it("limits sign-ups", async () => {
        const register = (n: number) => api().post(`${API}/auth/register`)
            .send({ name: "Bot", email: `bot${n}@example.com`, password: "password123" });
        expect((await register(1)).status).toBe(201);
        expect((await register(2)).status).toBe(201);
        expect((await register(3)).status).toBe(429);
    });
});
