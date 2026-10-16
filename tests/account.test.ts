import { describe, expect, it } from "vitest";
import prisma from "../src/db.js";
import { testOutbox } from "../src/emails/mailer.js";
import { waitForJobs } from "../src/jobs/queue.js";
import { API, api, createProduct, createUser, setupTestDatabase, shippingAddress } from "./helpers.js";

setupTestDatabase();

describe("wishlist", () => {
    it("adds, lists and removes products", async () => {
        const { auth } = await createUser();
        const product = await createProduct({ title: "Saved Lamp" });

        const added = await api().post(`${API}/wishlist`).set(auth).send({ productId: product.id });
        expect(added.body.data.map((i: any) => i.product.title)).toEqual(["Saved Lamp"]);
        await api().post(`${API}/wishlist`).set(auth).send({ productId: product.id }); // Adding twice is fine
        expect((await api().get(`${API}/wishlist`).set(auth)).body.data).toHaveLength(1);

        expect((await api().delete(`${API}/wishlist/${product.id}`).set(auth)).body.data).toEqual([]);
        expect((await api().post(`${API}/wishlist`).set(auth).send({ productId: 999 })).status).toBe(404);
    });

    it("marks products that are no longer on sale", async () => {
        const { auth } = await createUser();
        const product = await createProduct();
        await api().post(`${API}/wishlist`).set(auth).send({ productId: product.id });
        await prisma.product.update({ where: { id: product.id }, data: { status: "REJECTED" } });
        expect((await api().get(`${API}/wishlist`).set(auth)).body.data[0].available).toBe(false);
    });
});

describe("saved addresses", () => {
    it("the first address is the default; another can take over; deleting the default promotes the next", async () => {
        const { auth } = await createUser();
        const home = await api().post(`${API}/addresses`).set(auth).send({ ...shippingAddress, label: "Home" });
        expect(home.status).toBe(201);
        expect(home.body.data[0]).toMatchObject({ label: "Home", isDefault: true });

        const work = await api().post(`${API}/addresses`).set(auth).send({ ...shippingAddress, label: "Work", line1: "5 Infopark", isDefault: true });
        expect(work.body.data.map((a: any) => [a.label, a.isDefault])).toEqual([["Work", true], ["Home", false]]);

        const workId = work.body.data[0].id;
        const afterDelete = await api().delete(`${API}/addresses/${workId}`).set(auth);
        expect(afterDelete.body.data.map((a: any) => [a.label, a.isDefault])).toEqual([["Home", true]]);
    });

    it("validates PIN codes and keeps addresses private", async () => {
        const alice = await createUser();
        const bob = await createUser();
        const bad = await api().post(`${API}/addresses`).set(alice.auth).send({ ...shippingAddress, postalCode: "0123" });
        expect(bad.body.errors[0].field).toBe("postalCode");

        const saved = await api().post(`${API}/addresses`).set(alice.auth).send(shippingAddress);
        const id = saved.body.data[0].id;
        expect((await api().put(`${API}/addresses/${id}`).set(bob.auth).send(shippingAddress)).status).toBe(404);
        expect((await api().get(`${API}/addresses`).set(bob.auth)).body.data).toEqual([]);
    });
});

describe("profile and password", () => {
    it("updates the name and changes the password (checking the current one first)", async () => {
        const { auth, user, password } = await createUser();
        expect((await api().patch(`${API}/auth/me`).set(auth).send({ name: "Asha Rao" })).body.data.name).toBe("Asha Rao");

        const wrong = await api().post(`${API}/auth/change-password`).set(auth).send({ currentPassword: "nope", newPassword: "brand-new-pass" });
        expect(wrong.status).toBe(400);
        expect((await api().post(`${API}/auth/change-password`).set(auth).send({ currentPassword: password, newPassword: "brand-new-pass" })).status).toBe(200);

        expect((await api().post(`${API}/auth/login`).send({ email: user.email, password })).status).toBe(401);
        expect((await api().post(`${API}/auth/login`).send({ email: user.email, password: "brand-new-pass" })).status).toBe(200);
    });

    it("forgot password: same answer for unknown emails, a one-time link for real ones", async () => {
        const { user } = await createUser();
        const unknown = await api().post(`${API}/auth/forgot-password`).send({ email: "ghost@example.com" });
        const known = await api().post(`${API}/auth/forgot-password`).send({ email: user.email });
        expect(unknown.body.message).toBe(known.body.message);

        await waitForJobs();
        expect(testOutbox).toHaveLength(1);
        const token = testOutbox[0]!.text.match(/reset-password\?token=([\w-]+)/)![1]!;

        const reset = await api().post(`${API}/auth/reset-password`).send({ token, password: "a-new-password" });
        expect(reset.status).toBe(200);
        expect((await api().post(`${API}/auth/login`).send({ email: user.email, password: "a-new-password" })).status).toBe(200);

        // Links work once
        expect((await api().post(`${API}/auth/reset-password`).send({ token, password: "another-password" })).status).toBe(400);
    });

    it("expired reset links don't work", async () => {
        const { user } = await createUser();
        await api().post(`${API}/auth/forgot-password`).send({ email: user.email });
        await waitForJobs();
        const token = testOutbox[0]!.text.match(/reset-password\?token=([\w-]+)/)![1]!;
        await prisma.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
        expect((await api().post(`${API}/auth/reset-password`).send({ token, password: "a-new-password" })).status).toBe(400);
    });
});
