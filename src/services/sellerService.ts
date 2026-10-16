import type { Prisma, SellerStatus } from "@prisma/client";
import prisma from "../db.js";
import { invalidateProductCache } from "../cache.js";
import { queueEmail } from "../emails/mailer.js";
import {
    newSellerApplicationEmail, payoutEmail, sellerApplicationReceivedEmail, sellerStatusEmail,
} from "../emails/templates.js";
import { SUPPORT_EMAIL } from "../config.js";
import { HttpError } from "../utils/httpError.js";
import { formatRupees, round2 } from "../utils/money.js";
import { sellerRatingFor } from "./productService.js";
import { getSettings } from "./settingsService.js";

// "Urban Trend Co." -> "urban-trend-co"
const slugify = (text: string) =>
    text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "store";

const uniqueSlug = async (storeName: string, excludeSellerId?: number) => {
    const base = slugify(storeName);
    let slug = base;
    for (let n = 2; await prisma.seller.findFirst({ where: { slug, ...(excludeSellerId ? { id: { not: excludeSellerId } } : {}) } }); n++) {
        slug = `${base}-${n}`;
    }
    return slug;
};

const ensureStoreNameFree = async (storeName: string, excludeSellerId?: number) => {
    const taken = await prisma.seller.findFirst({
        where: { storeName: { equals: storeName, mode: "insensitive" }, ...(excludeSellerId ? { id: { not: excludeSellerId } } : {}) },
    });
    if (taken) throw new HttpError(409, "That store name is already taken.");
};

interface SellerProfile {
    storeName: string;
    description?: string | undefined;
    phone: string;
    gstin?: string | undefined;
    pickupAddress: { line1: string; city: string; state: string; postalCode: string };
    payoutUpi: string;
}

// A shopper applies to sell. An admin reviews the application before the store can list products.
export const applyAsSeller = async (userId: number, input: SellerProfile) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.role === "ADMIN") throw new HttpError(400, "Admin accounts can't open a store. Use a separate account.");

    const existing = await prisma.seller.findUnique({ where: { userId } });
    if (existing && existing.status !== "REJECTED") {
        throw new HttpError(409, existing.status === "PENDING" ? "Your application is already being reviewed." : "You already have a store.");
    }
    await ensureStoreNameFree(input.storeName, existing?.id);

    const data = {
        storeName: input.storeName,
        slug: await uniqueSlug(input.storeName, existing?.id),
        description: input.description ?? "",
        phone: input.phone,
        gstin: input.gstin ?? null,
        pickupAddress: input.pickupAddress,
        pickupPincode: input.pickupAddress.postalCode,
        payoutUpi: input.payoutUpi,
        status: "PENDING" as const,
        statusReason: null,
    };
    // A rejected applicant can apply again with the same account
    const seller = existing
        ? await prisma.seller.update({ where: { id: existing.id }, data })
        : await prisma.seller.create({ data: { ...data, userId } });

    queueEmail(sellerApplicationReceivedEmail(user, seller.storeName));
    queueEmail(newSellerApplicationEmail(SUPPORT_EMAIL, { storeName: seller.storeName, user }));
    return seller;
};

// The seller edits their store details (not their status)
export const updateSellerProfile = async (sellerId: number, input: { [K in keyof SellerProfile]?: SellerProfile[K] | undefined }) => {
    const data: Prisma.SellerUpdateInput = {};
    if (input.storeName !== undefined) {
        await ensureStoreNameFree(input.storeName, sellerId);
        data.storeName = input.storeName;
        data.slug = await uniqueSlug(input.storeName, sellerId);
    }
    if (input.description !== undefined) data.description = input.description;
    if (input.phone !== undefined) data.phone = input.phone;
    if (input.gstin !== undefined) data.gstin = input.gstin || null; // "" clears it
    if (input.payoutUpi !== undefined) data.payoutUpi = input.payoutUpi;
    if (input.pickupAddress !== undefined) {
        data.pickupAddress = input.pickupAddress;
        data.pickupPincode = input.pickupAddress.postalCode;
    }
    const seller = await prisma.seller.update({ where: { id: sellerId }, data });
    await invalidateProductCache(); // Store name shows on product pages
    return seller;
};

// Which status changes an admin can make
const ALLOWED: Record<SellerStatus, SellerStatus[]> = {
    PENDING: ["APPROVED", "REJECTED"],
    APPROVED: ["SUSPENDED"],
    SUSPENDED: ["APPROVED"],
    REJECTED: ["APPROVED"],
};

export const updateSellerByAdmin = async (
    sellerId: number,
    { status, reason, commissionRate }: { status?: SellerStatus | undefined; reason?: string | undefined; commissionRate?: number | null | undefined }
) => {
    const seller = await prisma.seller.findUnique({ where: { id: sellerId }, include: { user: true } });
    if (!seller) throw new HttpError(404, "Seller not found.");

    const statusChanges = status !== undefined && status !== seller.status;
    if (statusChanges && !ALLOWED[seller.status].includes(status)) {
        throw new HttpError(409, `A ${seller.status.toLowerCase()} store can't be ${status.toLowerCase()}.`);
    }

    const data: Prisma.SellerUpdateInput = {};
    if (commissionRate !== undefined) data.commissionRate = commissionRate;
    if (statusChanges) {
        data.status = status;
        data.statusReason = reason ?? null;
    }

    const updated = await prisma.$transaction(async (tx) => {
        const saved = await tx.seller.update({ where: { id: sellerId }, data });
        // Approved sellers get the SELLER role; a rejected applicant stays a buyer
        if (statusChanges && status === "APPROVED") {
            await tx.user.update({ where: { id: seller.userId }, data: { role: "SELLER" } });
        }
        if (statusChanges && status === "REJECTED" && seller.user.role === "SELLER") {
            await tx.user.update({ where: { id: seller.userId }, data: { role: "BUYER" } });
        }
        return saved;
    });

    if (statusChanges) {
        queueEmail(sellerStatusEmail(seller.user, seller.storeName, status, reason));
        await invalidateProductCache(); // Approving or suspending changes which products shoppers see
    }
    return updated;
};

// Money a seller has earned so far:
//   earned    = their share of delivered shipments (sale minus commission)
//   pending   = their share of shipments still on the way (paid or cash-on-delivery orders)
//   returns   = their share of items that were returned and refunded
//   available = earned - returns - already paid out
export const sellerEarnings = async (sellerId: number) => {
    const [delivered, pending, payouts, refundedReturns] = await Promise.all([
        prisma.shipment.aggregate({ where: { sellerId, status: "DELIVERED" }, _sum: { sellerEarning: true } }),
        prisma.shipment.aggregate({
            where: {
                sellerId,
                status: { in: ["PENDING", "SHIPPED"] },
                order: { OR: [{ paymentMethod: "COD", status: { not: "CANCELLED" } }, { paidAt: { not: null } }] },
            },
            _sum: { sellerEarning: true },
        }),
        prisma.payout.aggregate({ where: { sellerId }, _sum: { amount: true } }),
        prisma.returnRequest.findMany({
            where: { status: "REFUNDED", orderItem: { shipment: { sellerId } } },
            include: { orderItem: { include: { shipment: { select: { commissionRate: true } } } } },
        }),
    ]);

    const returns = round2(refundedReturns.reduce((sum, r) =>
        sum + r.orderItem.price * r.orderItem.quantity * (1 - (r.orderItem.shipment?.commissionRate ?? 0)), 0));
    const earned = round2(delivered._sum.sellerEarning ?? 0);
    const paidOut = round2(payouts._sum.amount ?? 0);

    return {
        earned,
        pending: round2(pending._sum.sellerEarning ?? 0),
        returns,
        paidOut,
        available: round2(earned - returns - paidOut),
    };
};

// An admin records money sent to a seller (e.g. by UPI). Can't be more than the seller's available balance.
export const recordPayout = async (sellerId: number, { amount, reference }: { amount: number; reference?: string | undefined }) => {
    const seller = await prisma.seller.findUnique({ where: { id: sellerId }, include: { user: { select: { name: true, email: true } } } });
    if (!seller) throw new HttpError(404, "Seller not found.");

    const { available } = await sellerEarnings(sellerId);
    if (round2(amount) > available) {
        throw new HttpError(400, `Only ${formatRupees(available)} is available to pay out to this seller.`);
    }
    const payout = await prisma.payout.create({ data: { sellerId, amount: round2(amount), reference: reference ?? null } });
    queueEmail(payoutEmail(seller, payout.amount, payout.reference));
    return payout;
};

// Everything a seller's dashboard overview shows
export const sellerOverview = async (sellerId: number) => {
    const [seller, earnings, rating, productGroups, toShip, openReturns] = await Promise.all([
        prisma.seller.findUniqueOrThrow({ where: { id: sellerId } }),
        sellerEarnings(sellerId),
        sellerRatingFor(sellerId),
        prisma.product.groupBy({ by: ["status"], where: { sellerId }, _count: { _all: true } }),
        prisma.shipment.count({
            where: {
                sellerId,
                status: "PENDING",
                order: { status: { not: "CANCELLED" }, OR: [{ paymentMethod: "COD" }, { paidAt: { not: null } }] },
            },
        }),
        prisma.returnRequest.count({ where: { status: "REQUESTED", orderItem: { shipment: { sellerId } } } }),
    ]);
    return {
        seller,
        commissionRate: seller.commissionRate ?? (await getSettings()).defaultCommissionRate,
        earnings,
        rating,
        products: Object.fromEntries(productGroups.map(g => [g.status, g._count._all])),
        shipmentsToShip: toShip,
        openReturns,
    };
};
