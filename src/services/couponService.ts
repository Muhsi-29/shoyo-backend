import { Prisma, type Coupon } from "@prisma/client";
import prisma from "../db.js";
import { HttpError } from "../utils/httpError.js";
import { formatRupees, round2 } from "../utils/money.js";

type Db = Prisma.TransactionClient | typeof prisma;

export const discountFor = (coupon: Pick<Coupon, "type" | "value" | "maxDiscount">, subtotal: number) => {
    let discount = coupon.type === "PERCENT" ? (subtotal * coupon.value) / 100 : coupon.value;
    if (coupon.maxDiscount !== null) discount = Math.min(discount, coupon.maxDiscount);
    return round2(Math.min(discount, subtotal));
};

// Works out what a coupon takes off an items total, or throws an HttpError saying why it can't be used
export const evaluateCoupon = async (code: string, userId: number, subtotal: number, db: Db = prisma) => {
    const coupon = await db.coupon.findUnique({ where: { code } });
    if (!coupon || !coupon.active) throw new HttpError(400, `Coupon ${code} doesn't exist or has ended.`);
    if (coupon.expiresAt && coupon.expiresAt < new Date()) throw new HttpError(400, `Coupon ${code} has expired.`);
    if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
        throw new HttpError(400, `Coupon ${code} has been fully used.`);
    }
    if (subtotal < coupon.minOrderAmount) {
        throw new HttpError(400, `Add items worth ${formatRupees(coupon.minOrderAmount - subtotal)} more to use ${code}.`);
    }
    const alreadyUsed = await db.couponRedemption.findUnique({ where: { couponId_userId: { couponId: coupon.id, userId } } });
    if (alreadyUsed) throw new HttpError(400, `You've already used coupon ${code}.`);

    return { coupon, discount: discountFor(coupon, subtotal) };
};

// Inside the order transaction: count the use (never past the usage limit, even with simultaneous
// checkouts) and remember who used it
export const redeemCoupon = async (tx: Prisma.TransactionClient, couponId: number, userId: number, orderId: number) => {
    const updated = await tx.$executeRaw`
        UPDATE "Coupon" SET "usedCount" = "usedCount" + 1
        WHERE "id" = ${couponId} AND ("usageLimit" IS NULL OR "usedCount" < "usageLimit")`;
    if (updated === 0) throw new HttpError(400, "This coupon has just been fully used.");
    try {
        await tx.couponRedemption.create({ data: { couponId, userId, orderId } });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            throw new HttpError(400, "You've already used this coupon.");
        }
        throw error;
    }
};

// When a whole order is cancelled, the customer gets the coupon back
export const releaseCoupon = async (tx: Prisma.TransactionClient, orderId: number) => {
    const redemption = await tx.couponRedemption.findUnique({ where: { orderId } });
    if (!redemption) return;
    await tx.couponRedemption.delete({ where: { id: redemption.id } });
    await tx.coupon.update({ where: { id: redemption.couponId }, data: { usedCount: { decrement: 1 } } });
};

// Coupons a shopper can use right now (shown on the cart page)
export const availableCoupons = async (userId?: number) => {
    const now = new Date();
    const coupons = await prisma.coupon.findMany({
        where: { active: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        // The shopper's own uses (none for guests), to hide coupons they've already used
        include: { redemptions: { where: { userId: userId ?? -1 }, select: { id: true } } },
        orderBy: { minOrderAmount: "asc" },
    });
    return coupons
        .filter(c => (c.usageLimit === null || c.usedCount < c.usageLimit) && c.redemptions.length === 0)
        .map(({ id, code, description, type, value, minOrderAmount, maxDiscount, expiresAt }) =>
            ({ id, code, description, type, value, minOrderAmount, maxDiscount, expiresAt }));
};
