import { describe, expect, it } from "vitest";
import prisma from "../src/db.js";
import { testOutbox } from "../src/emails/mailer.js";
import { waitForJobs } from "../src/jobs/queue.js";
import {
    API, api, createProduct, createSeller, createUser, deliverOrder, getStock, placeCodOrder, setupTestDatabase,
} from "./helpers.js";

setupTestDatabase();

const requestReturn = (auth: Record<string, string>, itemId: number, body: object = { reason: "DAMAGED", refundUpi: "asha@okhdfc" }) =>
    api().post(`${API}/orders/items/${itemId}/return`).set(auth).send(body);

describe("asking for a return", () => {
    it("is possible only after delivery, once per item, within the return window", async () => {
        const buyer = await createUser();
        const admin = await createUser("ADMIN");
        const product = await createProduct({ price: 800 });
        const order = await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 1 }]);
        const itemId = order.items[0].id;

        expect((await requestReturn(buyer.auth, itemId)).status).toBe(400); // Not delivered yet
        await deliverOrder(order.id, admin.auth);

        const orders = await api().get(`${API}/orders`).set(buyer.auth);
        expect(orders.body.data[0].items[0].canReturn).toBe(true);

        const res = await requestReturn(buyer.auth, itemId);
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ status: "REQUESTED", refundAmount: 800, reason: "DAMAGED" });
        expect((await requestReturn(buyer.auth, itemId)).status).toBe(409);
    });

    it("closes after the return window", async () => {
        const buyer = await createUser();
        const admin = await createUser("ADMIN");
        const product = await createProduct();
        const order = await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 1 }]);
        await deliverOrder(order.id, admin.auth);
        await prisma.shipment.updateMany({ where: { orderId: order.id }, data: { deliveredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } });

        const res = await requestReturn(buyer.auth, order.items[0].id);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/7-day return window/);
    });

    it("cash-on-delivery returns need a UPI ID for the refund, and other people can't return your items", async () => {
        const buyer = await createUser();
        const stranger = await createUser();
        const admin = await createUser("ADMIN");
        const product = await createProduct();
        const order = await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 1 }]);
        await deliverOrder(order.id, admin.auth);

        expect((await requestReturn(buyer.auth, order.items[0].id, { reason: "DAMAGED" })).body.message).toMatch(/refundUpi/);
        expect((await requestReturn(stranger.auth, order.items[0].id)).status).toBe(404);
    });
});

describe("handling returns", () => {
    it("the seller approves: the item is restocked, the refund recorded and the customer emailed", async () => {
        const buyer = await createUser();
        const admin = await createUser("ADMIN");
        const { auth: sellerAuth, seller } = await createSeller();
        const product = await createProduct({ price: 1000, stock: 5, sellerId: seller.id });
        const order = await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 2 }]);
        await deliverOrder(order.id, admin.auth);
        const request = (await requestReturn(buyer.auth, order.items[0].id)).body.data;

        const list = await api().get(`${API}/seller/returns`).set(sellerAuth);
        expect(list.body.data.map((r: any) => r.id)).toEqual([request.id]);

        const approved = await api().patch(`${API}/seller/returns/${request.id}`).set(sellerAuth).send({ action: "approve" });
        expect(approved.status).toBe(200);
        expect(approved.body.data.status).toBe("REFUNDED");
        expect(await getStock(product.id)).toBe(5);
        expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).refundedAmount).toBe(2000);

        // The seller's earnings for that item come off their balance
        const payouts = await api().get(`${API}/seller/payouts`).set(sellerAuth);
        expect(payouts.body.data.earnings).toMatchObject({ earned: 1800, returns: 1800, available: 0 });

        await waitForJobs();
        expect(testOutbox.map(e => e.subject)).toContain(`Refund started for order #${order.id}`);
        expect(testOutbox.find(e => e.subject === `Refund started for order #${order.id}`)!.text).toContain("UPI ID");
    });

    it("refunds the discounted price when a coupon was used", async () => {
        const buyer = await createUser();
        const admin = await createUser("ADMIN");
        await prisma.coupon.create({ data: { code: "TENOFF", description: "10% off", type: "PERCENT", value: 10 } });
        const product = await createProduct({ price: 1000 });
        const other = await createProduct({ price: 1000 });
        const order = await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 1 }, { productId: other.id, quantity: 1 }], { couponCode: "TENOFF" });
        expect(order).toMatchObject({ subtotal: 2000, discount: 200, totalAmount: 1800 });
        await deliverOrder(order.id, admin.auth);

        const request = await requestReturn(buyer.auth, order.items[0].id);
        expect(request.body.data.refundAmount).toBe(900);
    });

    it("sellers can't handle other sellers' returns; admins can handle Shoyo's own", async () => {
        const buyer = await createUser();
        const admin = await createUser("ADMIN");
        const otherSeller = await createSeller();
        const product = await createProduct(); // Sold by Shoyo itself
        const order = await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 1 }]);
        await deliverOrder(order.id, admin.auth);
        const request = (await requestReturn(buyer.auth, order.items[0].id)).body.data;

        expect((await api().patch(`${API}/seller/returns/${request.id}`).set(otherSeller.auth).send({ action: "approve" })).status).toBe(403);
        const rejected = await api().patch(`${API}/admin/returns/${request.id}`).set(admin.auth).send({ action: "reject", note: "Item was used" });
        expect(rejected.body.data).toMatchObject({ status: "REJECTED", resolutionNote: "Item was used" });
        expect((await api().patch(`${API}/admin/returns/${request.id}`).set(admin.auth).send({ action: "approve" })).status).toBe(409);
    });
});
