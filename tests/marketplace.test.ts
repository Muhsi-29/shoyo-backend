import { describe, expect, it } from "vitest";
import prisma from "../src/db.js";
import { testOutbox } from "../src/emails/mailer.js";
import { waitForJobs } from "../src/jobs/queue.js";
import {
    API, api, createProduct, createSeller, createUser, deliverOrder, placeCodOrder, pngBuffer, setupTestDatabase,
} from "./helpers.js";

setupTestDatabase();

const application = {
    storeName: "Urban Trend Co.",
    description: "Streetwear and sneakers",
    phone: "9876543210",
    pickupAddress: { line1: "4 Linking Road", city: "Mumbai", state: "Maharashtra", postalCode: "400050" },
    payoutUpi: "urbantrend@okicici",
};

describe("becoming a seller", () => {
    it("a shopper applies, an admin approves, and they get the SELLER role", async () => {
        const shopper = await createUser();
        const admin = await createUser("ADMIN");

        const applied = await api().post(`${API}/sellers/apply`).set(shopper.auth).send(application);
        expect(applied.status).toBe(201);
        expect(applied.body.data).toMatchObject({ status: "PENDING", slug: "urban-trend-co" });
        expect((await api().post(`${API}/sellers/apply`).set(shopper.auth).send(application)).status).toBe(409);

        // Pending stores can see their dashboard but not list products
        expect((await api().get(`${API}/seller/me`).set(shopper.auth)).status).toBe(200);
        const early = await api().post(`${API}/seller/products`).set(shopper.auth).field({ title: "T" });
        expect(early.status).toBe(403);

        const approve = await api().patch(`${API}/admin/sellers/${applied.body.data.id}`).set(admin.auth).send({ status: "APPROVED" });
        expect(approve.status).toBe(200);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: shopper.user.id } })).role).toBe("SELLER");

        const me = await api().get(`${API}/auth/me`).set(shopper.auth);
        expect(me.body.data.seller).toMatchObject({ storeName: "Urban Trend Co.", status: "APPROVED" });

        await waitForJobs();
        expect(testOutbox.map(e => e.subject)).toEqual([
            "We received your seller application",
            "New seller application: Urban Trend Co.",
            "Your Shoyo store is approved!",
        ]);
    });

    it("store names are unique regardless of capitals, and applications are validated", async () => {
        const first = await createUser();
        const second = await createUser();
        await api().post(`${API}/sellers/apply`).set(first.auth).send(application);
        const clash = await api().post(`${API}/sellers/apply`).set(second.auth).send({ ...application, storeName: "URBAN TREND CO." });
        expect(clash.status).toBe(409);

        const invalid = await api().post(`${API}/sellers/apply`).set(second.auth).send({ ...application, storeName: "Other", payoutUpi: "not-upi", gstin: "123" });
        expect(invalid.body.errors.map((e: any) => e.field)).toEqual(["gstin", "payoutUpi"]);
    });

    it("store settings update details and can clear the optional ones", async () => {
        const { auth } = await createSeller();
        const saved = await api().patch(`${API}/seller/me`).set(auth).send({ description: "Handmade decor", gstin: "27abcde1234f1z5" });
        expect(saved.body.data).toMatchObject({ description: "Handmade decor", gstin: "27ABCDE1234F1Z5" });

        const cleared = await api().patch(`${API}/seller/me`).set(auth).send({ description: "", gstin: "" });
        expect(cleared.body.data).toMatchObject({ description: "", gstin: null });
    });
});

describe("seller listings", () => {
    it("new products wait for approval, go live when approved, and return for review after a rejection", async () => {
        const { auth, seller } = await createSeller();
        const admin = await createUser("ADMIN");

        const created = await api().post(`${API}/seller/products`).set(auth)
            .field({ title: "Canvas Sneakers", price: "1999", mrp: "2999", description: "Light canvas sneakers", category: "Footwear", stock: "20", brand: "Urban" })
            .attach("image", pngBuffer, { filename: "shoe.png", contentType: "image/png" });
        expect(created.status).toBe(201);
        expect(created.body.data).toMatchObject({ status: "PENDING", sellerId: seller.id, discountPercent: 33 });
        const id = created.body.data.id;

        expect((await api().get(`${API}/products/${id}`)).status).toBe(404); // Not public yet
        expect((await api().get(`${API}/admin/products?status=PENDING`).set(admin.auth)).body.total).toBe(1);

        await api().patch(`${API}/admin/products/${id}/status`).set(admin.auth).send({ status: "REJECTED", reason: "Photo is blurry" });
        await api().put(`${API}/seller/products/${id}`).set(auth).send({ description: "Light canvas sneakers, new photos" });
        expect((await prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");

        await api().patch(`${API}/admin/products/${id}/status`).set(admin.auth).send({ status: "ACTIVE" });
        const live = await api().get(`${API}/products/${id}`);
        expect(live.status).toBe(200);
        expect(live.body.data.sellerName).toBe(seller.storeName);

        await waitForJobs();
        expect(testOutbox.map(e => e.subject)).toEqual(['"Canvas Sneakers" wasn\'t approved', '"Canvas Sneakers" is now live']);
    });

    it("sellers can only manage their own products", async () => {
        const alice = await createSeller();
        const bob = await createSeller();
        const bobsProduct = await createProduct({ sellerId: bob.seller.id });
        expect((await api().put(`${API}/seller/products/${bobsProduct.id}`).set(alice.auth).send({ price: 1 })).status).toBe(404);
        expect((await api().delete(`${API}/seller/products/${bobsProduct.id}`).set(alice.auth)).status).toBe(404);
        expect((await api().get(`${API}/seller/products`).set(alice.auth)).body.data).toHaveLength(0);
    });
});

describe("orders with several sellers", () => {
    it("are split into one shipment per seller, each handled by that seller only", async () => {
        const buyer = await createUser();
        const alice = await createSeller();
        const bob = await createSeller({ commissionRate: 0.05 });
        const ownProduct = await createProduct({ price: 500 });
        const alicesProduct = await createProduct({ price: 1000, sellerId: alice.seller.id });
        const bobsProduct = await createProduct({ price: 2000, sellerId: bob.seller.id });

        const order = await placeCodOrder(buyer.auth, [
            { productId: ownProduct.id, quantity: 1 },
            { productId: alicesProduct.id, quantity: 2 },
            { productId: bobsProduct.id, quantity: 1 },
        ]);
        expect(order.shipments).toHaveLength(3);
        const byseller = Object.fromEntries(order.shipments.map((s: any) => [s.sellerId ?? "shoyo", s]));
        expect(byseller.shoyo).toMatchObject({ subtotal: 500, commission: 0, sellerName: "Shoyo Retail" });
        expect(byseller[alice.seller.id]).toMatchObject({ subtotal: 2000, commissionRate: 0.1, commission: 200, sellerEarning: 1800 });
        expect(byseller[bob.seller.id]).toMatchObject({ subtotal: 2000, commissionRate: 0.05, commission: 100, sellerEarning: 1900 });

        // Each seller sees only their own shipment, and can't touch anyone else's
        const alicesView = await api().get(`${API}/seller/shipments`).set(alice.auth);
        expect(alicesView.body.data).toHaveLength(1);
        expect(alicesView.body.data[0].items.map((i: any) => i.product.title)).toEqual(["Test Product"]);
        expect(alicesView.body.data[0].nextStatuses).toEqual(["SHIPPED", "CANCELLED"]);
        expect((await api().patch(`${API}/shipments/${byseller[bob.seller.id].id}`).set(alice.auth).send({ status: "SHIPPED" })).status).toBe(403);
        expect((await api().patch(`${API}/shipments/${byseller.shoyo.id}`).set(alice.auth).send({ status: "SHIPPED" })).status).toBe(403);

        // The order is SHIPPED only once every shipment has shipped
        await api().patch(`${API}/shipments/${byseller[alice.seller.id].id}`).set(alice.auth).send({ status: "SHIPPED", trackingNumber: "A1" });
        expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING");

        await waitForJobs();
        expect(testOutbox.filter(e => e.subject === `New order #${order.id} to ship`).map(e => e.to).sort())
            .toEqual([alice.user.email, bob.user.email].sort());
    });

    it("seller earnings: available after delivery, minus payouts; payouts can't exceed the balance", async () => {
        const buyer = await createUser();
        const admin = await createUser("ADMIN");
        const { auth, seller } = await createSeller();
        const product = await createProduct({ price: 1000, sellerId: seller.id });
        const order = await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 1 }]);

        let payouts = await api().get(`${API}/seller/payouts`).set(auth);
        expect(payouts.body.data.earnings).toMatchObject({ pending: 900, earned: 0, available: 0 });

        await deliverOrder(order.id, admin.auth);
        payouts = await api().get(`${API}/seller/payouts`).set(auth);
        expect(payouts.body.data.earnings).toMatchObject({ pending: 0, earned: 900, available: 900 });

        expect((await api().post(`${API}/admin/sellers/${seller.id}/payouts`).set(admin.auth).send({ amount: 1000 })).status).toBe(400);
        const paid = await api().post(`${API}/admin/sellers/${seller.id}/payouts`).set(admin.auth).send({ amount: 600, reference: "UPI-123" });
        expect(paid.status).toBe(201);
        payouts = await api().get(`${API}/seller/payouts`).set(auth);
        expect(payouts.body.data.earnings).toMatchObject({ paidOut: 600, available: 300 });
        expect(payouts.body.data.payouts[0]).toMatchObject({ amount: 600, reference: "UPI-123" });
    });

    it("customers rate the seller after delivery; the average shows on the product page", async () => {
        const buyer = await createUser();
        const admin = await createUser("ADMIN");
        const { seller } = await createSeller();
        const product = await createProduct({ sellerId: seller.id });
        const order = await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 1 }]);
        const shipmentId = order.shipments[0].id;

        expect((await api().post(`${API}/shipments/${shipmentId}/rating`).set(buyer.auth).send({ rating: 5 })).status).toBe(400); // Not delivered yet
        await deliverOrder(order.id, admin.auth);
        expect((await api().post(`${API}/shipments/${shipmentId}/rating`).set(buyer.auth).send({ rating: 4, feedback: "Quick delivery" })).status).toBe(200);

        const page = await api().get(`${API}/products/${product.id}`);
        expect(page.body.data.sellerRating).toEqual({ average: 4, count: 1 });
    });
});

describe("suspending a seller", () => {
    it("hides their products and blocks changes, until reactivated", async () => {
        const admin = await createUser("ADMIN");
        const buyer = await createUser();
        const { auth, seller } = await createSeller();
        const product = await createProduct({ sellerId: seller.id });
        expect((await api().get(`${API}/products`)).body.total).toBe(1);

        await api().patch(`${API}/admin/sellers/${seller.id}`).set(admin.auth).send({ status: "SUSPENDED", reason: "Too many cancellations" });
        expect((await api().get(`${API}/products`)).body.total).toBe(0);
        expect((await api().get(`${API}/sellers/${seller.slug}`)).status).toBe(404);
        const order = await api().post(`${API}/orders`).set(buyer.auth).send({ items: [{ productId: product.id, quantity: 1 }], shippingAddress: { fullName: "A", phone: "9876543210", line1: "x", city: "y", state: "z", postalCode: "560001" } });
        expect(order.status).toBe(400);
        expect((await api().put(`${API}/seller/products/${product.id}`).set(auth).send({ price: 5 })).status).toBe(403);
        expect((await api().get(`${API}/seller/me`).set(auth)).status).toBe(200);

        await api().patch(`${API}/admin/sellers/${seller.id}`).set(admin.auth).send({ status: "APPROVED" });
        expect((await api().get(`${API}/products`)).body.total).toBe(1);
    });

    it("rejects impossible status changes", async () => {
        const admin = await createUser("ADMIN");
        const { seller } = await createSeller({ status: "PENDING" });
        expect((await api().patch(`${API}/admin/sellers/${seller.id}`).set(admin.auth).send({ status: "SUSPENDED" })).status).toBe(409);
    });
});

describe("public store page", () => {
    it("shows the store, its location (city only) and its live products", async () => {
        const { seller } = await createSeller();
        await createProduct({ title: "Live", sellerId: seller.id });
        await createProduct({ title: "Waiting", sellerId: seller.id, status: "PENDING" });

        const page = await api().get(`${API}/sellers/${seller.slug}`);
        expect(page.status).toBe(200);
        expect(page.body.data).toMatchObject({ storeName: seller.storeName, location: "Mumbai, Maharashtra" });
        expect(page.body.data.products.map((p: any) => p.title)).toEqual(["Live"]);
        expect(JSON.stringify(page.body.data)).not.toContain("Market Road"); // Full pickup address stays private
    });
});
