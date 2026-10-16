import "dotenv/config"; // 1. Load environment variables first
import type { Prisma } from "@prisma/client";
import prisma from "../src/db.js"; // 2. Import the configured prisma instance
import { products } from "../src/data/products.js";
import { ensureAdminAccount, ensureDemoBuyerAccount, ensureDemoSellerAccount } from "../src/services/accounts.js";
import { discountPercentFor } from "../src/services/productService.js";

// The demo seller's store (its owner logs in with DEMO_SELLER_EMAIL / DEMO_SELLER_PASSWORD)
const DEMO_STORE = {
    storeName: "Urban Trend Co.",
    slug: "urban-trend-co",
    description: "Everyday fashion: bags, shirts, watches and jewellery, shipped from Mumbai.",
    phone: "+91 98200 12345",
    pickupAddress: { line1: "4 Linking Road, Bandra West", city: "Mumbai", state: "Maharashtra", postalCode: "400050" },
    pickupPincode: "400050",
    payoutUpi: "urbantrend@okicici",
};

const COUPONS: Prisma.CouponCreateInput[] = [
    { code: "WELCOME10", description: "10% off your order, up to ₹500 (orders over ₹999)", type: "PERCENT", value: 10, maxDiscount: 500, minOrderAmount: 999 },
    { code: "FLAT200", description: "₹200 off orders over ₹1,999", type: "FLAT", value: 200, minOrderAmount: 1999 },
    { code: "SAVE50", description: "₹50 off orders over ₹499", type: "FLAT", value: 50, minOrderAmount: 499 },
];

async function main() {
    // Logins from .env. Passwords are set to the values in .env, so editing .env and re-running the seed changes them.
    // Public sign-up only creates buyers, so the first admin account comes from .env.
    const adminEmail = await ensureAdminAccount({ syncPassword: true });
    console.log(adminEmail ? `Admin account ready: ${adminEmail}` : "Skipping admin: set ADMIN_EMAIL and ADMIN_PASSWORD in .env to create one.");

    const buyerEmail = await ensureDemoBuyerAccount({ syncPassword: true });
    console.log(buyerEmail ? `Demo shopper account ready: ${buyerEmail}` : "Skipping demo shopper: set DEMO_BUYER_EMAIL and DEMO_BUYER_PASSWORD in .env to create one.");

    // The demo seller gets an approved store, so the seller dashboard has something to show
    let demoSellerId: number | null = null;
    const sellerEmail = await ensureDemoSellerAccount({ syncPassword: true });
    if (sellerEmail) {
        const user = await prisma.user.findUniqueOrThrow({ where: { email: sellerEmail } });
        const store = await prisma.seller.upsert({
            where: { userId: user.id },
            create: { ...DEMO_STORE, userId: user.id, status: "APPROVED" },
            update: {},
        });
        if (user.role !== "SELLER") await prisma.user.update({ where: { id: user.id }, data: { role: "SELLER" } });
        demoSellerId = store.id;
        console.log(`Demo seller account ready: ${sellerEmail} (store: ${store.storeName})`);
    } else {
        console.log("Skipping demo seller: set DEMO_SELLER_EMAIL and DEMO_SELLER_PASSWORD in .env to create one.");
    }

    // Add every sample product that isn't in the database yet (matched by title), so running the seed
    // again never creates duplicates. Existing products only get details they're missing (brand, MRP,
    // gallery, specs): anything already set, e.g. edited in the admin dashboard, is left alone.
    let added = 0;
    let updated = 0;
    for (const product of products) {
        // Omit the manual 'id' so Postgres can assign autoincremented IDs
        const { id, seller, specs, images, mrp, brand, ...fields } = product;
        const existing = await prisma.product.findFirst({ where: { title: product.title } });

        if (!existing) {
            const created = await prisma.product.create({
                data: {
                    ...fields,
                    brand: brand ?? null,
                    mrp: mrp ?? null,
                    discountPercent: discountPercentFor(fields.price, mrp),
                    images: images ?? [],
                    ...(specs ? { specs } : {}),
                    sellerId: seller === "demo" ? demoSellerId : null,
                },
            });
            console.log(`Added product: ${created.title} (ID: ${created.id})`);
            added++;
            continue;
        }

        const missing: Prisma.ProductUpdateInput = {};
        // The first version of the sample data pointed at placeholder images that don't exist
        if (existing.image.startsWith("https://example.com/")) missing.image = fields.image;
        if (existing.brand === null && brand) missing.brand = brand;
        if (existing.mrp === null && mrp && mrp >= existing.price) {
            missing.mrp = mrp;
            missing.discountPercent = discountPercentFor(existing.price, mrp);
        }
        if (existing.images.length === 0 && images?.length) missing.images = images;
        if (existing.specs === null && specs) missing.specs = specs;
        if (Object.keys(missing).length > 0) {
            await prisma.product.update({ where: { id: existing.id }, data: missing });
            updated++;
        }
    }
    console.log(`Products: ${added} added, ${updated} filled in with new details, ${products.length - added} already there.`);

    // Starter coupons (existing codes are left as they are)
    for (const coupon of COUPONS) {
        await prisma.coupon.upsert({ where: { code: coupon.code }, create: coupon, update: {} });
    }
    console.log(`Coupons ready: ${COUPONS.map(c => c.code).join(", ")}`);

    console.log("Seeding complete!");
}

main()
    .then(async () => {
        await prisma.$disconnect();
    })
    .catch(async (e) => {
        console.error(e);
        await prisma.$disconnect();
        process.exit(1);
    });
