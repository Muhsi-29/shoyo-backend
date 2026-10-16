import { describe, expect, it } from "vitest";
import prisma from "../src/db.js";
import { testOutbox } from "../src/emails/mailer.js";
import { waitForJobs } from "../src/jobs/queue.js";
import {
    API, api, createProduct, createUser, deliverOrder, getStock, placeCodOrder, setupTestDatabase, shippingAddress,
} from "./helpers.js";

setupTestDatabase();

const placeOrder = (auth: Record<string, string>, body: object = {}) =>
    api().post(`${API}/orders`).set(auth).send({ shippingAddress, ...body });

const shipmentOf = async (orderId: number) => prisma.shipment.findFirstOrThrow({ where: { orderId } });

describe("placing a cash-on-delivery order", () => {
    it("orders the cart: reserves stock, empties the cart and emails an invoice", async () => {
        const { auth } = await createUser();
        const product = await createProduct({ price: 1200, stock: 10 });
        await api().post(`${API}/cart/items`).set(auth).send({ productId: product.id, quantity: 3 });

        const res = await placeOrder(auth);
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
            status: "PENDING", paymentMethod: "COD", subtotal: 3600, deliveryFee: 0, totalAmount: 3600, shippingAddress, canCancel: true,
        });
        expect(await getStock(product.id)).toBe(7);
        expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).soldCount).toBe(3);
        expect((await api().get(`${API}/cart`).set(auth)).body.data.count).toBe(0);

        await waitForJobs();
        expect(testOutbox.map(e => e.subject)).toEqual([`Order #${res.body.data.id} confirmed`]);
        expect(testOutbox[0]!.html).toContain("Test Product");
    });

    it("charges delivery below the free-delivery amount", async () => {
        const { auth } = await createUser();
        const product = await createProduct({ price: 100 });
        const order = await placeCodOrder(auth, [{ productId: product.id, quantity: 2 }]);
        expect(order).toMatchObject({ subtotal: 200, deliveryFee: 40, totalAmount: 240 });
    });

    it("refuses an empty cart, a missing address and a bad PIN code", async () => {
        const { auth } = await createUser();
        expect((await placeOrder(auth)).body.message).toBe("Your cart is empty.");

        const noAddress = await api().post(`${API}/orders`).set(auth).send({ items: [{ productId: 1, quantity: 1 }] });
        expect(noAddress.body.errors[0].field).toBe("shippingAddress");

        const badPin = await placeOrder(auth, { items: [{ productId: 1, quantity: 1 }], shippingAddress: { ...shippingAddress, postalCode: "12345" } });
        expect(badPin.body.errors[0]).toEqual({ field: "shippingAddress.postalCode", message: "must be a valid 6-digit PIN code" });
    });

    it("counts repeated lines for the same product together", async () => {
        const { auth } = await createUser();
        const product = await createProduct({ stock: 50 });
        await placeCodOrder(auth, [{ productId: product.id, quantity: 5 }, { productId: product.id, quantity: 5 }]);
        expect(await getStock(product.id)).toBe(40);
    });

    it("rejects too little stock and bad quantities without changing stock", async () => {
        const { auth } = await createUser();
        const product = await createProduct({ stock: 2 });
        expect((await placeOrder(auth, { items: [{ productId: product.id, quantity: 3 }] })).status).toBe(400);
        expect((await placeOrder(auth, { items: [{ productId: product.id, quantity: 1.5 }] })).status).toBe(400);
        expect(await getStock(product.id)).toBe(2);
    });

    it("won't sell a product that isn't approved", async () => {
        const { auth } = await createUser();
        const product = await createProduct({ status: "PENDING" });
        const res = await placeOrder(auth, { items: [{ productId: product.id, quantity: 1 }] });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/no longer available/);
    });

    it("never oversells when many people order the last units at once", async () => {
        const buyers = await Promise.all(Array.from({ length: 8 }, () => createUser()));
        const product = await createProduct({ stock: 3 });

        const results = await Promise.all(buyers.map(b => placeOrder(b.auth, { items: [{ productId: product.id, quantity: 1 }] })));
        expect(results.filter(r => r.status === 201)).toHaveLength(3);
        expect(results.filter(r => r.status === 400)).toHaveLength(5);
        expect(await getStock(product.id)).toBe(0);
    });
});

describe("viewing orders", () => {
    it("shows only your own orders, and blocks other people's", async () => {
        const alice = await createUser();
        const bob = await createUser();
        const product = await createProduct();
        const order = await placeCodOrder(alice.auth, [{ productId: product.id, quantity: 1 }]);

        expect((await api().get(`${API}/orders`).set(alice.auth)).body.data).toHaveLength(1);
        expect((await api().get(`${API}/orders`).set(bob.auth)).body.data).toHaveLength(0);
        expect((await api().get(`${API}/orders/${order.id}`).set(bob.auth)).status).toBe(403);
        expect((await api().get(`${API}/orders/abc`).set(alice.auth)).status).toBe(400);
    });
});

describe("cancelling", () => {
    it("lets a shopper cancel a pending order and puts the stock back, once", async () => {
        const { auth } = await createUser();
        const product = await createProduct({ stock: 5 });
        const order = await placeCodOrder(auth, [{ productId: product.id, quantity: 2 }]);

        const res = await api().patch(`${API}/orders/${order.id}/cancel`).set(auth);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ status: "CANCELLED", canCancel: false });
        expect(res.body.data.shipments[0].status).toBe("CANCELLED");
        expect(await getStock(product.id)).toBe(5);

        expect((await api().patch(`${API}/orders/${order.id}/cancel`).set(auth)).status).toBe(409);
        expect(await getStock(product.id)).toBe(5);
    });

    it("won't let you cancel someone else's order, or one that has shipped", async () => {
        const alice = await createUser();
        const bob = await createUser();
        const admin = await createUser("ADMIN");
        const product = await createProduct();
        const order = await placeCodOrder(alice.auth, [{ productId: product.id, quantity: 1 }]);
        expect((await api().patch(`${API}/orders/${order.id}/cancel`).set(bob.auth)).status).toBe(403);

        await api().patch(`${API}/shipments/${(await shipmentOf(order.id)).id}`).set(admin.auth).send({ status: "SHIPPED" });
        const shipped = await api().patch(`${API}/orders/${order.id}/cancel`).set(alice.auth);
        expect(shipped.status).toBe(409);
    });
});

describe("shipping (admin)", () => {
    it("moves a COD order PENDING -> SHIPPED -> DELIVERED, counts the cash as paid on delivery, and emails each step", async () => {
        const admin = await createUser("ADMIN");
        const buyer = await createUser();
        const product = await createProduct({ price: 600 });
        const order = await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 1 }]);
        const shipment = await shipmentOf(order.id);

        const all = await api().get(`${API}/orders/all`).set(admin.auth);
        expect(all.body.data[0].shipments[0].nextStatuses).toEqual(["SHIPPED", "CANCELLED"]);

        const shipped = await api().patch(`${API}/shipments/${shipment.id}`).set(admin.auth)
            .send({ status: "SHIPPED", courier: "Blue Dart", trackingNumber: "BD123456" });
        expect(shipped.status).toBe(200);
        expect(shipped.body.data.status).toBe("SHIPPED");
        expect(shipped.body.data.shipments[0]).toMatchObject({ courier: "Blue Dart", trackingNumber: "BD123456", nextStatuses: ["DELIVERED"] });

        const delivered = await api().patch(`${API}/shipments/${shipment.id}`).set(admin.auth).send({ status: "DELIVERED" });
        expect(delivered.body.data.status).toBe("DELIVERED");
        expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).paidAt).not.toBeNull();

        await waitForJobs();
        expect(testOutbox.map(e => e.subject)).toEqual([
            `Order #${order.id} confirmed`,
            `Your order #${order.id} has shipped`,
            `Your order #${order.id} was delivered`,
        ]);
        expect(testOutbox[1]!.text).toContain("BD123456");
    });

    it("rejects impossible changes and non-admins", async () => {
        const admin = await createUser("ADMIN");
        const buyer = await createUser();
        const product = await createProduct();
        const order = await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 1 }]);
        const shipment = await shipmentOf(order.id);

        expect((await api().patch(`${API}/shipments/${shipment.id}`).set(admin.auth).send({ status: "DELIVERED" })).status).toBe(409);
        expect((await api().patch(`${API}/shipments/${shipment.id}`).set(admin.auth).send({ status: "LOST" })).status).toBe(400);
        expect((await api().patch(`${API}/shipments/${shipment.id}`).set(buyer.auth).send({ status: "SHIPPED" })).status).toBe(403);
    });

    it("cancelling the only shipment restocks it and cancels the order", async () => {
        const admin = await createUser("ADMIN");
        const buyer = await createUser();
        const product = await createProduct({ stock: 5 });
        const order = await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 4 }]);

        const res = await api().patch(`${API}/shipments/${(await shipmentOf(order.id)).id}`).set(admin.auth)
            .send({ status: "CANCELLED", reason: "Out of stock at the warehouse" });
        expect(res.body.data.status).toBe("CANCELLED");
        expect(await getStock(product.id)).toBe(5);
    });

    it("shows dashboard stats: revenue counts only money received", async () => {
        const admin = await createUser("ADMIN");
        const buyer = await createUser();
        const product = await createProduct({ price: 300, stock: 4 });
        const first = await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 1 }]); // 300 + 40 delivery
        await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 1 }]);
        await deliverOrder(first.id, admin.auth);

        expect((await api().get(`${API}/orders/all?status=PENDING`).set(admin.auth)).body.data).toHaveLength(1);
        const stats = await api().get(`${API}/admin/stats`).set(admin.auth);
        expect(stats.body.data).toMatchObject({
            productCount: 1, customerCount: 1, orderCount: 2, revenue: 340,
            ordersByStatus: { PENDING: 1, DELIVERED: 1 },
            lowStock: [{ id: product.id, title: "Test Product", stock: 2 }],
        });
        expect((await api().get(`${API}/admin/stats`).set(buyer.auth)).status).toBe(403);
    });
});
