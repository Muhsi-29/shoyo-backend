import { describe, expect, it } from "vitest";
import prisma from "../src/db.js";
import { testOutbox } from "../src/emails/mailer.js";
import { waitForJobs } from "../src/jobs/queue.js";
import { API, api, createProduct, createSeller, setupTestDatabase } from "./helpers.js";

setupTestDatabase();

describe("store config", () => {
    it("tells the website which payment options and delivery rules apply", async () => {
        const res = await api().get(`${API}/config`);
        expect(res.body.data).toMatchObject({
            currency: "INR",
            payments: { stripe: true, razorpay: true, cod: true },
            razorpayKeyId: "rzp_test_FakeKeyForTests",
            delivery: { fee: 40, freeThreshold: 499 },
            returnWindowDays: 7,
            platformSellerName: "Shoyo Retail",
        });
        expect(JSON.stringify(res.body)).not.toContain("razorpay_test_secret"); // Secrets never leave the server
    });
});

describe("delivery estimates", () => {
    it("are quicker for nearby PIN codes", async () => {
        const near = await api().get(`${API}/delivery/estimate?pincode=560034`); // Same district as the warehouse (560001)
        const far = await api().get(`${API}/delivery/estimate?pincode=110001`);  // Delhi
        expect(near.body.data).toMatchObject({ minDays: 1, maxDays: 2, codAvailable: true });
        expect(far.body.data).toMatchObject({ minDays: 4, maxDays: 7 });
        expect(new Date(far.body.data.latest).getTime()).toBeGreaterThan(new Date(near.body.data.latest).getTime());
    });

    it("measure from the seller's pickup PIN code, and reject invalid PIN codes", async () => {
        const { seller } = await createSeller(); // Ships from Mumbai (400001)
        const product = await createProduct({ sellerId: seller.id });
        const res = await api().get(`${API}/delivery/estimate?pincode=400070&productId=${product.id}`);
        expect(res.body.data).toMatchObject({ minDays: 1, maxDays: 2 });
        expect((await api().get(`${API}/delivery/estimate?pincode=12345`)).status).toBe(400);
    });
});

describe("newsletter and contact form", () => {
    it("subscribes once (one welcome email)", async () => {
        await api().post(`${API}/newsletter`).send({ email: "Fan@Example.com" });
        const again = await api().post(`${API}/newsletter`).send({ email: "fan@example.com" });
        expect(again.status).toBe(200);
        expect(await prisma.newsletterSubscriber.count()).toBe(1);
        await waitForJobs();
        expect(testOutbox.map(e => e.subject)).toEqual(["You're on the Shoyo list"]);
    });

    it("saves contact messages and emails them to support", async () => {
        const res = await api().post(`${API}/contact`).send({ name: "Asha", email: "asha@example.com", subject: "Order help", message: "Where is my order #12?" });
        expect(res.status).toBe(201);
        await waitForJobs();
        expect(testOutbox[0]).toMatchObject({ to: "support@example.com", subject: "Contact form: Order help" });

        const short = await api().post(`${API}/contact`).send({ name: "A", email: "a@example.com", subject: "Hi", message: "Hi" });
        expect(short.body.errors[0].field).toBe("message");
    });
});
