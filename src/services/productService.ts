import type { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { PLATFORM_SELLER_NAME } from "../config.js";

// The seller details shown with a product or shipment
export const sellerSummarySelect = { id: true, storeName: true, slug: true, status: true } satisfies Prisma.SellerSelect;

// What shoppers may see and buy: approved listings, from Shoyo itself or from sellers in good standing
export const visibleProductWhere: Prisma.ProductWhereInput = {
    status: "ACTIVE",
    OR: [{ sellerId: null }, { seller: { status: "APPROVED" } }],
};

export const isProductVisible = (product: { status: string; sellerId: number | null; seller?: { status: string } | null }) =>
    product.status === "ACTIVE" && (product.sellerId === null || product.seller?.status === "APPROVED");

// "Rs 1,000 MRP, Rs 750 price" -> 25 (% off). Stored on the product so it can be filtered and sorted on.
export const discountPercentFor = (price: number, mrp: number | null | undefined) =>
    mrp && mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0;

export const sellerNameFor = (seller: { storeName: string } | null | undefined) => seller?.storeName ?? PLATFORM_SELLER_NAME;

// Recalculates a product's average rating and review count after a review is added, changed or removed
export const refreshProductRating = async (productId: number, db: Prisma.TransactionClient | typeof prisma = prisma) => {
    const stats = await db.review.aggregate({ where: { productId }, _avg: { rating: true }, _count: { _all: true } });
    await db.product.update({
        where: { id: productId },
        data: {
            ratingAvg: Math.round((stats._avg.rating ?? 0) * 10) / 10,
            ratingCount: stats._count._all,
        },
    });
};

// Average of the ratings customers gave a seller after delivery
export const sellerRatingFor = async (sellerId: number) => {
    const stats = await prisma.shipment.aggregate({
        where: { sellerId, sellerRating: { not: null } },
        _avg: { sellerRating: true },
        _count: { sellerRating: true },
    });
    return {
        average: Math.round((stats._avg.sellerRating ?? 0) * 10) / 10,
        count: stats._count.sellerRating,
    };
};
