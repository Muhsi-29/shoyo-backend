import { describe, expect, it, vi } from "vitest";

// This file's store owner (ADMIN_EMAIL), whose admin account can't be changed or removed
vi.hoisted(() => { process.env.ADMIN_EMAIL = "owner@example.com"; });

import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import prisma from "../src/db.js";
import {
    API, api, createProduct, createSeller, createUser, placeCodOrder, pngBuffer, setupTestDatabase,
} from "./helpers.js";

setupTestDatabase();

const activity = async () => (await prisma.adminActivity.findMany({ orderBy: { id: "asc" } })).map(a => a.summary);

describe("store settings", () => {
    it("start from .env, can be changed, and change what shoppers pay", async () => {
        const admin = await createUser("ADMIN");
        const shopper = await createUser();
        const product = await createProduct({ price: 300 });

        const initial = await api().get(`${API}/admin/settings`).set(admin.auth);
        expect(initial.body.data.settings).toMatchObject({ deliveryFee: 40, freeDeliveryThreshold: 499, returnWindowDays: 7, defaultCommissionRate: 0.1 });
        expect(initial.body.data.paymentKeys).toEqual({ stripe: true, razorpay: true });

        const saved = await api().patch(`${API}/admin/settings`).set(admin.auth).send({ deliveryFee: 60, freeDeliveryThreshold: 999, returnWindowDays: 10 });
        expect(saved.status).toBe(200);

        const config = await api().get(`${API}/config`);
        expect(config.body.data).toMatchObject({ delivery: { fee: 60, freeThreshold: 999 }, returnWindowDays: 10 });

        const order = await placeCodOrder(shopper.auth, [{ productId: product.id, quantity: 1 }]);
        expect(order).toMatchObject({ subtotal: 300, deliveryFee: 60, totalAmount: 360 });

        expect(await activity()).toEqual([
            "Changed store settings: delivery fee ₹40 → ₹60; free delivery from ₹499 → ₹999; return window 7 days → 10 days",
        ]);
    });

    it("switching off cash on delivery stops COD orders, but at least one way to pay must stay on", async () => {
        const admin = await createUser("ADMIN");
        const shopper = await createUser();
        const product = await createProduct();

        await api().patch(`${API}/admin/settings`).set(admin.auth).send({ codEnabled: false });
        const cod = await api().post(`${API}/orders`).set(shopper.auth).send({
            items: [{ productId: product.id, quantity: 1 }],
            shippingAddress: { fullName: "A", phone: "9876543210", line1: "x", city: "y", state: "z", postalCode: "560001" },
        });
        expect(cod.status).toBe(400);
        expect((await api().get(`${API}/config`)).body.data.payments).toEqual({ stripe: true, razorpay: true, cod: false });

        const none = await api().patch(`${API}/admin/settings`).set(admin.auth).send({ stripeEnabled: false, razorpayEnabled: false });
        expect(none.status).toBe(400);

        const invalid = await api().patch(`${API}/admin/settings`).set(admin.auth).send({ returnWindowDays: 0, defaultCommissionRate: 0.9 });
        expect(invalid.body.errors.map((e: any) => e.field)).toEqual(["returnWindowDays", "defaultCommissionRate"]);
    });

    it("fills in the offers bar and adds active coupon codes", async () => {
        const admin = await createUser("ADMIN");
        await prisma.coupon.create({ data: { code: "HELLO5", description: "₹5 off", type: "FLAT", value: 5, minOrderAmount: 0 } });
        await api().patch(`${API}/admin/settings`).set(admin.auth).send({
            announcements: ["Free delivery over {freeDeliveryThreshold}", "Returns within {returnWindowDays} days"],
        });
        const lines = (await api().get(`${API}/config`)).body.data.announcements;
        expect(lines).toEqual(["Free delivery over ₹499", "Use code HELLO5: ₹5 off", "Returns within 7 days"]);

        await api().patch(`${API}/admin/settings`).set(admin.auth).send({ announceCoupons: false });
        expect((await api().get(`${API}/config`)).body.data.announcements).toHaveLength(2);
    });
});

describe("homepage banners", () => {
    it("are created with a picture or with products from the linked page, reordered, scheduled and hidden", async () => {
        const admin = await createUser("ADMIN");
        await createProduct({ title: "Leather Watch", category: "Fashion", mrp: 200, price: 100, discountPercent: 50 });
        await createProduct({ title: "Phone", category: "Electronics" });

        const photo = await api().post(`${API}/admin/banners`).set(admin.auth)
            .field({ title: "Up to {maxDiscount}% off", ctaLabel: "Shop", ctaLink: "/products?sort=discount", theme: "NAVY", layout: "COVER" })
            .attach("image", pngBuffer, { filename: "banner.png", contentType: "image/png" });
        expect(photo.status).toBe(201);
        expect(photo.body.data.image).toMatch(/^\/uploads\//);

        const fashion = await api().post(`${API}/admin/banners`).set(admin.auth)
            .send({ title: "Fashion week", ctaLabel: "Shop fashion", ctaLink: "/products?category=Fashion" });
        const later = await api().post(`${API}/admin/banners`).set(admin.auth)
            .send({ title: "Coming soon", ctaLabel: "See", ctaLink: "/products", startsAt: new Date(Date.now() + 86_400_000).toISOString() });
        expect(later.body.data.status).toBe("SCHEDULED");

        let live = (await api().get(`${API}/banners`)).body.data;
        expect(live.map((b: any) => b.title)).toEqual(["Up to 50% off", "Fashion week"]);
        expect(live[1].products.map((p: any) => p.title)).toEqual(["Leather Watch"]);

        await api().patch(`${API}/admin/banners/reorder`).set(admin.auth).send({ ids: [fashion.body.data.id, photo.body.data.id, later.body.data.id] });
        await api().put(`${API}/admin/banners/${photo.body.data.id}`).set(admin.auth).field({ active: "false" });
        live = (await api().get(`${API}/banners`)).body.data;
        expect(live.map((b: any) => b.title)).toEqual(["Fashion week"]);

        const all = (await api().get(`${API}/admin/banners`).set(admin.auth)).body.data;
        expect(all.map((b: any) => [b.title, b.status])).toEqual([
            ["Fashion week", "LIVE"], ["Up to {maxDiscount}% off", "HIDDEN"], ["Coming soon", "SCHEDULED"],
        ]);

        expect(await activity()).toEqual([
            'Added homepage banner "Up to {maxDiscount}% off"',
            'Added homepage banner "Fashion week"',
            'Added homepage banner "Coming soon"',
            "Changed the order of the homepage banners",
            'Hid homepage banner "Up to {maxDiscount}% off"',
        ]);
    });

    it("validate links, dates and full-picture banners", async () => {
        const admin = await createUser("ADMIN");
        const bad = await api().post(`${API}/admin/banners`).set(admin.auth).send({
            title: "X", ctaLabel: "Go", ctaLink: "javascript:alert(1)",
            startsAt: "2026-12-10", endsAt: "2026-12-01",
        });
        expect(bad.body.errors.map((e: any) => e.field)).toEqual(["ctaLink", "endsAt"]);

        const cover = await api().post(`${API}/admin/banners`).set(admin.auth).send({ title: "X", ctaLabel: "Go", ctaLink: "/", layout: "COVER" });
        expect(cover.body.errors).toEqual([{ field: "image", message: "is needed for a full-picture banner" }]);

        const external = await api().post(`${API}/admin/banners`).set(admin.auth).send({ title: "X", ctaLabel: "Go", ctaLink: "https://example.com/sale" });
        expect(external.status).toBe(201);
        const removed = await api().delete(`${API}/admin/banners/${external.body.data.id}`).set(admin.auth);
        expect(removed.status).toBe(200);
        expect(await prisma.banner.count()).toBe(0);
    });
});

describe("customers", () => {
    it("shows a customer's details, and blocking stops them logging in and suspends their store", async () => {
        const admin = await createUser("ADMIN");
        const { user, auth, password, seller } = await createSeller();
        const product = await createProduct();
        await placeCodOrder(auth, [{ productId: product.id, quantity: 2 }]);

        const detail = await api().get(`${API}/admin/customers/${user.id}`).set(admin.auth);
        expect(detail.body.data).toMatchObject({ email: user.email, stats: { orderCount: 1, totalSpent: 0 }, seller: { status: "APPROVED" } });
        expect(detail.body.data.orders[0]).toMatchObject({ itemCount: 1, status: "PENDING" });

        const blocked = await api().patch(`${API}/admin/customers/${user.id}`).set(admin.auth).send({ blocked: true, reason: "Fraud" });
        expect(blocked.status).toBe(200);
        expect((await prisma.seller.findUniqueOrThrow({ where: { id: seller.id } })).status).toBe("SUSPENDED");
        expect((await api().get(`${API}/auth/me`).set(auth)).status).toBe(401);
        const login = await api().post(`${API}/auth/login`).send({ email: user.email, password });
        expect(login.status).toBe(403);

        await api().patch(`${API}/admin/customers/${user.id}`).set(admin.auth).send({ blocked: false });
        expect((await api().get(`${API}/auth/me`).set(auth)).status).toBe(200);
        expect(await activity()).toEqual([
            `Blocked ${user.name} (${user.email}): Fraud and suspended their store`,
            `Unblocked ${user.name} (${user.email})`,
        ]);
    });

    it("admins aren't customers", async () => {
        const admin = await createUser("ADMIN");
        const other = await createUser("ADMIN");
        expect((await api().get(`${API}/admin/customers/${other.user.id}`).set(admin.auth)).status).toBe(404);
        expect((await api().patch(`${API}/admin/customers/${other.user.id}`).set(admin.auth).send({ blocked: true })).status).toBe(404);
    });
});

describe("admins and roles", () => {
    it("each role only reaches its own areas, and the panel is told what it can show", async () => {
        const support = await createUser("ADMIN", "SUPPORT");
        const catalog = await createUser("ADMIN", "CATALOG");

        expect((await api().get(`${API}/admin/orders`).set(support.auth)).status).toBe(200);
        expect((await api().get(`${API}/admin/settings`).set(support.auth)).status).toBe(403);
        expect((await api().get(`${API}/admin/products`).set(support.auth)).status).toBe(403);
        expect((await api().get(`${API}/admin/products`).set(catalog.auth)).status).toBe(200);
        expect((await api().get(`${API}/admin/orders`).set(catalog.auth)).status).toBe(403);
        expect((await api().get(`${API}/admin/activity`).set(catalog.auth)).status).toBe(403);

        const me = await api().get(`${API}/auth/me`).set(support.auth);
        expect(me.body.data.permissions).toEqual(["dashboard", "orders", "returns", "customers", "messages", "reviews"]);
        expect(me.body.data.password).toBeUndefined();
    });

    it("full-access admins add, change and remove admins; the owner and yourself are protected", async () => {
        const admin = await createUser("ADMIN");
        const owner = await prisma.user.create({
            data: { name: "Owner", email: "owner@example.com", password: await bcrypt.hash("password123", 4), role: "ADMIN", staffRole: "FULL" },
        });

        const added = await api().post(`${API}/auth/admin/register`).set(admin.auth)
            .send({ name: "Sam Support", email: "sam@example.com", password: "password123", staffRole: "SUPPORT" });
        expect(added.body.data).toMatchObject({ staffRole: "SUPPORT", permissions: expect.arrayContaining(["orders"]) });
        const samId = added.body.data.id;
        const samToken = jwt.sign({ id: samId, role: "ADMIN" }, process.env.JWT_SECRET!);

        await api().patch(`${API}/admin/admins/${samId}`).set(admin.auth).send({ staffRole: "CATALOG" });
        expect((await api().get(`${API}/admin/products`).set({ Authorization: `Bearer ${samToken}` })).status).toBe(200); // Immediately

        expect((await api().patch(`${API}/admin/admins/${admin.user.id}`).set(admin.auth).send({ staffRole: "SUPPORT" })).status).toBe(400);
        expect((await api().delete(`${API}/admin/admins/${owner.id}`).set(admin.auth)).status).toBe(400);

        const list = (await api().get(`${API}/admin/admins`).set(admin.auth)).body.data;
        expect(list.find((a: any) => a.id === owner.id).isOwner).toBe(true);

        expect((await api().delete(`${API}/admin/admins/${samId}`).set(admin.auth)).status).toBe(200);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: samId } })).role).toBe("BUYER");
        expect((await api().get(`${API}/admin/products`).set({ Authorization: `Bearer ${samToken}` })).status).toBe(403);

        expect(await activity()).toEqual([
            "Added admin Sam Support (sam@example.com) with Support",
            "Changed Sam Support's role from Support to Catalog & marketing",
            "Removed admin access from Sam Support (sam@example.com)",
        ]);
    });

    it("support admins can't add admins", async () => {
        const support = await createUser("ADMIN", "SUPPORT");
        const res = await api().post(`${API}/auth/admin/register`).set(support.auth).send({ name: "X", email: "x@example.com", password: "password123" });
        expect(res.status).toBe(403);
    });
});

describe("orders: filters and export", () => {
    it("filters by payment, seller and date, and exports the same orders as a safe CSV", async () => {
        const admin = await createUser("ADMIN");
        const shopper = await createUser();
        await prisma.user.update({ where: { id: shopper.user.id }, data: { name: "=HYPERLINK(\"http://evil\")" } });
        const { seller } = await createSeller();
        const own = await createProduct({ title: "Own" });
        const theirs = await createProduct({ title: "Theirs", sellerId: seller.id });
        const first = await placeCodOrder(shopper.auth, [{ productId: own.id, quantity: 1 }]);
        const second = await placeCodOrder(shopper.auth, [{ productId: theirs.id, quantity: 1 }]);
        await prisma.order.update({ where: { id: first.id }, data: { createdAt: new Date("2026-01-15T10:00:00") } });

        const ids = async (query: string) => (await api().get(`${API}/admin/orders?${query}`).set(admin.auth)).body.data.map((o: any) => o.id);
        expect(await ids("paymentMethod=COD")).toEqual([second.id, first.id]);
        expect(await ids("paymentMethod=STRIPE")).toEqual([]);
        expect(await ids(`seller=${seller.id}`)).toEqual([second.id]);
        expect(await ids("seller=shoyo")).toEqual([first.id]);
        expect(await ids("from=2026-01-15&to=2026-01-15")).toEqual([first.id]);
        expect((await api().get(`${API}/admin/orders?from=2026-02-01&to=2026-01-01`).set(admin.auth)).status).toBe(400);

        const csv = await api().get(`${API}/admin/orders/export?seller=shoyo`).set(admin.auth);
        expect(csv.headers["content-type"]).toMatch(/text\/csv/);
        expect(csv.headers["content-disposition"]).toMatch(/attachment; filename="shoyo-orders-/);
        const lines = csv.text.replace(/^﻿/, "").trim().split("\r\n");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(/^Order,Placed on,Customer,Email/);
        expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"")"`); // Can't run as a formula
    });
});

describe("activity log", () => {
    it("records admin actions, not sellers', and can be filtered", async () => {
        const admin = await createUser("ADMIN");
        const { auth: sellerAuth, seller } = await createSeller();
        const shopper = await createUser();
        const product = await createProduct({ sellerId: seller.id, status: "PENDING", title: "Desk Lamp" });

        await api().patch(`${API}/admin/products/${product.id}/status`).set(admin.auth).send({ status: "ACTIVE" });
        const order = await placeCodOrder(shopper.auth, [{ productId: product.id, quantity: 1 }]);
        const shipmentId = order.shipments[0].id;
        await api().patch(`${API}/shipments/${shipmentId}`).set(sellerAuth).send({ status: "SHIPPED" }); // The seller: not logged
        await api().patch(`${API}/shipments/${shipmentId}`).set(admin.auth).send({ status: "DELIVERED" });
        await api().post(`${API}/admin/coupons`).set(admin.auth).send({ code: "LAMP10", description: "10% off lamps", type: "PERCENT", value: 10 });

        const log = await api().get(`${API}/admin/activity`).set(admin.auth);
        expect(log.body.data.map((e: any) => e.summary)).toEqual([
            "Created coupon LAMP10: 10% off lamps",
            `Marked ${seller.storeName}'s part of order #${order.id} as delivered`,
            `Approved product "Desk Lamp" from ${seller.storeName}`,
        ]);
        expect(log.body.data[0]).toMatchObject({ adminId: admin.user.id, adminName: admin.user.name, targetType: "coupon" });
        expect(log.body.admins).toEqual([{ adminId: admin.user.id, adminName: admin.user.name }]);

        const products = await api().get(`${API}/admin/activity?area=product`).set(admin.auth);
        expect(products.body.total).toBe(1);
        const search = await api().get(`${API}/admin/activity?q=lamp10`).set(admin.auth);
        expect(search.body.total).toBe(1);
    });
});
