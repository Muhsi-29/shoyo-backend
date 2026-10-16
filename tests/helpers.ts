import { afterAll, beforeEach } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import type { Prisma, SellerStatus, StaffRole } from "@prisma/client";
import app from "../src/app.js";
import prisma from "../src/db.js";
import { invalidateProductCache } from "../src/cache.js";
import { testOutbox } from "../src/emails/mailer.js";
import { waitForJobs } from "../src/jobs/queue.js";
import { clearSettingsCache } from "../src/services/settingsService.js";

export const API = "/api/v1";
export const api = () => request(app);

// Call at the top of each test file: every test starts with empty tables and an empty cache
export const setupTestDatabase = () => {
    beforeEach(async () => {
        await waitForJobs(); // Let emails from the previous test finish first
        await prisma.$executeRawUnsafe(`TRUNCATE "ReviewVote", "Review", "ReturnRequest", "CouponRedemption", "Coupon", "Payout",
            "OrderItem", "Shipment", "Order", "CartItem", "WishlistItem", "Address", "PasswordResetToken", "Product", "Seller",
            "User", "NewsletterSubscriber", "ContactMessage", "StoreSettings", "Banner", "AdminActivity" RESTART IDENTITY CASCADE`);
        clearSettingsCache(); // Settings are re-created from the test environment's values
        await invalidateProductCache();
        testOutbox.length = 0;
    });
    afterAll(async () => {
        await waitForJobs();
        await prisma.$disconnect();
    });
};

let userCounter = 0;

// Creates a user directly in the database and returns a valid login token for them
// Admins get full access unless a narrower staff role is given
export const createUser = async (role: "BUYER" | "SELLER" | "ADMIN" = "BUYER", staffRole: StaffRole = "FULL") => {
    userCounter++;
    const password = "password123";
    const user = await prisma.user.create({
        data: {
            name: `Test User ${userCounter}`,
            email: `user${userCounter}@example.com`,
            password: await bcrypt.hash(password, 4), // Low cost: fast tests
            role,
            staffRole: role === "ADMIN" ? staffRole : null,
        },
    });
    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET!, { expiresIn: "1h" });
    return { user, password, token, auth: { Authorization: `Bearer ${token}` } };
};

let sellerCounter = 0;

// A user with a store (approved unless told otherwise) and a login token
export const createSeller = async ({ status = "APPROVED", commissionRate = null }: { status?: SellerStatus; commissionRate?: number | null } = {}) => {
    sellerCounter++;
    const account = await createUser(status === "APPROVED" || status === "SUSPENDED" ? "SELLER" : "BUYER");
    const seller = await prisma.seller.create({
        data: {
            userId: account.user.id,
            storeName: `Test Store ${sellerCounter}`,
            slug: `test-store-${sellerCounter}`,
            phone: "9876543210",
            pickupAddress: { line1: "1 Market Road", city: "Mumbai", state: "Maharashtra", postalCode: "400001" },
            pickupPincode: "400001",
            payoutUpi: "store@okaxis",
            status,
            commissionRate,
        },
    });
    return { ...account, seller };
};

export const createProduct = (overrides: Partial<Prisma.ProductUncheckedCreateInput> = {}) =>
    prisma.product.create({
        data: {
            title: "Test Product",
            price: 100,
            description: "A product used in tests",
            category: "Testing",
            image: "https://example.com/product.jpg",
            stock: 10,
            ...overrides,
        },
    });

export const getStock = async (productId: number) =>
    (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock;

export const shippingAddress = {
    fullName: "Asha Rao",
    phone: "+91 98765 43210",
    line1: "12 MG Road",
    city: "Kochi",
    state: "Kerala",
    postalCode: "682001",
};

// Places a cash-on-delivery order for exactly these items
export const placeCodOrder = async (auth: Record<string, string>, items: { productId: number; quantity: number }[], extra: object = {}) => {
    const res = await api().post(`${API}/orders`).set(auth).send({ items, shippingAddress, ...extra });
    if (res.status !== 201) throw new Error(`Order failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
};

// Ships and delivers every shipment of an order, the way an admin would
export const deliverOrder = async (orderId: number, adminAuth: Record<string, string>) => {
    const shipments = await prisma.shipment.findMany({ where: { orderId }, orderBy: { id: "asc" } });
    for (const shipment of shipments) {
        await api().patch(`${API}/shipments/${shipment.id}`).set(adminAuth).send({ status: "SHIPPED", courier: "Delhivery", trackingNumber: "DL123" });
        await api().patch(`${API}/shipments/${shipment.id}`).set(adminAuth).send({ status: "DELIVERED" });
    }
};

// A tiny valid PNG header: enough for upload tests (the server checks the declared type, not the pixels)
export const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
