import { describe, expect, it } from "vitest";
import { API, api, createUser, setupTestDatabase } from "./helpers.js";
import { testOutbox } from "../src/emails/mailer.js";
import { waitForJobs } from "../src/jobs/queue.js";

setupTestDatabase();

describe("POST /auth/register", () => {
    it("creates a buyer and sends a welcome email", async () => {
        const res = await api().post(`${API}/auth/register`)
            .send({ name: "Asha", email: "Asha@Example.com", password: "password123" });

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ name: "Asha", email: "asha@example.com", role: "BUYER" });
        expect(res.body.data.password).toBeUndefined();

        await waitForJobs();
        expect(testOutbox.map(e => e.subject)).toEqual(["Welcome to Shoyo!"]);
    });

    it("ignores a role sent in the body (no self-made admins)", async () => {
        const res = await api().post(`${API}/auth/register`)
            .send({ name: "Sneaky", email: "sneaky@example.com", password: "password123", role: "ADMIN" });
        expect(res.status).toBe(201);
        expect(res.body.data.role).toBe("BUYER");
    });

    it("lists every invalid field", async () => {
        const res = await api().post(`${API}/auth/register`).send({ email: "not-an-email", password: "short" });
        expect(res.status).toBe(400);
        expect(res.body.errors).toEqual([
            { field: "name", message: "is required" },
            { field: "email", message: "must be a valid email address" },
            { field: "password", message: "must be at least 8 characters" },
        ]);
    });

    it("rejects a duplicate email", async () => {
        const { user } = await createUser();
        const res = await api().post(`${API}/auth/register`)
            .send({ name: "Again", email: user.email, password: "password123" });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe("Email is already registered.");
    });
});

describe("login", () => {
    it("returns a token that works on /auth/me", async () => {
        const { user, password } = await createUser();
        const login = await api().post(`${API}/auth/login`).send({ email: user.email, password });
        expect(login.status).toBe(200);

        const me = await api().get(`${API}/auth/me`).set("Authorization", `Bearer ${login.body.token}`);
        expect(me.status).toBe(200);
        expect(me.body.data).toMatchObject({ id: user.id, email: user.email });
    });

    it("gives the same answer for a wrong password and an unknown email", async () => {
        const { user } = await createUser();
        const wrongPassword = await api().post(`${API}/auth/login`).send({ email: user.email, password: "nope" });
        const unknownEmail = await api().post(`${API}/auth/login`).send({ email: "ghost@example.com", password: "nope" });
        expect(wrongPassword.status).toBe(401);
        expect(unknownEmail.status).toBe(401);
        expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
    });

    it("rejects missing or invalid tokens with 401", async () => {
        expect((await api().get(`${API}/auth/me`)).status).toBe(401);
        expect((await api().get(`${API}/auth/me`).set("Authorization", "Bearer not.a.token")).status).toBe(401);
    });
});

describe("admin accounts", () => {
    it("admin login: 401 for a wrong password, 403 for a buyer, 200 for an admin", async () => {
        const buyer = await createUser("BUYER");
        const admin = await createUser("ADMIN");

        expect((await api().post(`${API}/auth/admin/login`).send({ email: buyer.user.email, password: "wrong" })).status).toBe(401);
        expect((await api().post(`${API}/auth/admin/login`).send({ email: buyer.user.email, password: buyer.password })).status).toBe(403);
        const ok = await api().post(`${API}/auth/admin/login`).send({ email: admin.user.email, password: admin.password });
        expect(ok.status).toBe(200);
        expect(ok.body.token).toBeTypeOf("string");
    });

    it("only an admin can create another admin", async () => {
        const buyer = await createUser("BUYER");
        const admin = await createUser("ADMIN");
        const newAdmin = { name: "Second Admin", email: "admin2@example.com", password: "password123" };

        expect((await api().post(`${API}/auth/admin/register`).send(newAdmin)).status).toBe(401);
        expect((await api().post(`${API}/auth/admin/register`).set(buyer.auth).send(newAdmin)).status).toBe(403);
        const res = await api().post(`${API}/auth/admin/register`).set(admin.auth).send(newAdmin);
        expect(res.status).toBe(201);
        expect(res.body.data.role).toBe("ADMIN");
    });
});
