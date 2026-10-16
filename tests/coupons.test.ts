import { describe, expect, it } from "vitest";
import prisma from "../src/db.js";
import { API, api, createProduct, createUser, placeCodOrder, setupTestDatabase, shippingAddress } from "./helpers.js";

setupTestDatabase();

const createCoupon = (data: Partial<Parameters<typeof prisma.coupon.create>[0]["data"]> = {}) =>
    prisma.coupon.create({ data: { code: "WELCOME10", description: "10% off, up to Rs 500", type: "PERCENT", value: 10, maxDiscount: 500, minOrderAmount: 999, ...data } });

const fillCart = async (auth: Record<string, string>, price: number, quantity = 1) => {
    const product = await createProduct({ price, stock: 20 });
    await api().post(`${API}/cart/items`).set(auth).send({ productId: product.id, quantity });
    return product;
};

describe("checking a coupon against the cart", () => {
    it("shows the discount and new total", async () => {
        const { auth } = await createUser();
        await createCoupon();
        await fillCart(auth, 1500);
        const res = await api().post(`${API}/coupons/validate`).set(auth).send({ code: "welcome10" });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ code: "WELCOME10", description: "10% off, up to Rs 500", discount: 150, subtotal: 1500, deliveryFee: 0, total: 1350 });
    });

    it("caps percentage discounts, and explains why a coupon can't be used", async () => {
        const { auth } = await createUser();
        await createCoupon();
        await createCoupon({ code: "OLDDEAL", expiresAt: new Date(Date.now() - 1000) });
        await fillCart(auth, 9000);

        expect((await api().post(`${API}/coupons/validate`).set(auth).send({ code: "WELCOME10" })).body.data.discount).toBe(500);
        expect((await api().post(`${API}/coupons/validate`).set(auth).send({ code: "OLDDEAL" })).body.message).toBe("Coupon OLDDEAL has expired.");
        expect((await api().post(`${API}/coupons/validate`).set(auth).send({ code: "NOSUCH" })).body.message).toMatch(/doesn't exist/);
    });

    it("tells the shopper how much more to add", async () => {
        const { auth } = await createUser();
        await createCoupon();
        await fillCart(auth, 700);
        const res = await api().post(`${API}/coupons/validate`).set(auth).send({ code: "WELCOME10" });
        expect(res.body.message).toBe("Add items worth ₹299.00 more to use WELCOME10.");
    });
});

describe("using coupons on orders", () => {
    it("applies the discount, and each shopper can use a coupon only once", async () => {
        const { auth } = await createUser();
        await createCoupon({ code: "FLAT200", type: "FLAT", value: 200, maxDiscount: null, minOrderAmount: 0 });
        const product = await createProduct({ price: 1000, stock: 10 });

        const order = await placeCodOrder(auth, [{ productId: product.id, quantity: 1 }], { couponCode: "FLAT200" });
        expect(order).toMatchObject({ subtotal: 1000, discount: 200, totalAmount: 800, couponCode: "FLAT200" });
        expect(order.items[0].discount).toBe(200);

        const again = await api().post(`${API}/orders`).set(auth).send({ items: [{ productId: product.id, quantity: 1 }], shippingAddress, couponCode: "FLAT200" });
        expect(again.status).toBe(400);
        expect(again.body.message).toBe("You've already used coupon FLAT200.");
    });

    it("a coupon limited to one use goes to only one of two shoppers checking out at once", async () => {
        const [alice, bob] = await Promise.all([createUser(), createUser()]);
        await createCoupon({ code: "ONLYONE", type: "FLAT", value: 100, maxDiscount: null, minOrderAmount: 0, usageLimit: 1 });
        const product = await createProduct({ price: 1000, stock: 10 });

        const results = await Promise.all([alice, bob].map(b => api().post(`${API}/orders`).set(b.auth)
            .send({ items: [{ productId: product.id, quantity: 1 }], shippingAddress, couponCode: "ONLYONE" })));
        expect(results.map(r => r.status).sort()).toEqual([201, 400]);
        expect((await prisma.coupon.findUniqueOrThrow({ where: { code: "ONLYONE" } })).usedCount).toBe(1);
    });

    it("cancelling the order gives the coupon back", async () => {
        const { auth } = await createUser();
        await createCoupon({ code: "COMEBACK", type: "FLAT", value: 100, maxDiscount: null, minOrderAmount: 0, usageLimit: 1 });
        const product = await createProduct({ price: 1000 });
        const order = await placeCodOrder(auth, [{ productId: product.id, quantity: 1 }], { couponCode: "COMEBACK" });

        await api().patch(`${API}/orders/${order.id}/cancel`).set(auth);
        expect((await prisma.coupon.findUniqueOrThrow({ where: { code: "COMEBACK" } })).usedCount).toBe(0);
        expect((await api().get(`${API}/coupons`).set(auth)).body.data.map((c: any) => c.code)).toEqual(["COMEBACK"]);
    });
});

describe("admin coupon management", () => {
    it("creates, rejects duplicates, and switches off used coupons instead of deleting them", async () => {
        const admin = await createUser("ADMIN");
        const buyer = await createUser();
        const created = await api().post(`${API}/admin/coupons`).set(admin.auth)
            .send({ code: "diwali25", description: "Festive 25% off", type: "PERCENT", value: 25, maxDiscount: 1000 });
        expect(created.status).toBe(201);
        expect(created.body.data.code).toBe("DIWALI25");
        expect((await api().post(`${API}/admin/coupons`).set(admin.auth).send({ code: "DIWALI25", description: "x", type: "FLAT", value: 10 })).status).toBe(409);
        expect((await api().post(`${API}/admin/coupons`).set(admin.auth).send({ code: "TOOMUCH", description: "x", type: "PERCENT", value: 95 })).status).toBe(400);

        const product = await createProduct({ price: 2000 });
        await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 1 }], { couponCode: "DIWALI25" });
        const removed = await api().delete(`${API}/admin/coupons/${created.body.data.id}`).set(admin.auth);
        expect(removed.body.message).toMatch(/switched off/);
        expect((await prisma.coupon.findUniqueOrThrow({ where: { code: "DIWALI25" } })).active).toBe(false);
    });
});
