import type { Response } from "express";
import prisma from "../db.js";
import { currentUserId, type AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { availableCoupons, evaluateCoupon } from "../services/couponService.js";
import { deliveryFeeFor } from "../services/deliveryService.js";
import { getSettings } from "../services/settingsService.js";
import { HttpError } from "../utils/httpError.js";
import { round2 } from "../utils/money.js";
import { couponValidateSchema } from "../validation/schemas.js";

// GET /coupons: offers a shopper can use now (logged-in shoppers don't see coupons they've already used)
export const getAvailableCoupons = async (req: AuthenticatedRequest, res: Response) => {
    res.status(200).json({ status: "success", data: await availableCoupons(req.user?.id) });
};

// POST /coupons/validate { code }: what the coupon would take off the shopper's current cart
export const validateCoupon = async (req: AuthenticatedRequest, res: Response) => {
    const userId = currentUserId(req);
    const { code } = couponValidateSchema.parse(req.body ?? {});
    const items = await prisma.cartItem.findMany({ where: { userId, savedForLater: false }, include: { product: true } });
    if (items.length === 0) throw new HttpError(400, "Your cart is empty.");

    const subtotal = round2(items.reduce((sum, item) => sum + item.product.price * item.quantity, 0));
    const { coupon, discount } = await evaluateCoupon(code, userId, subtotal);
    const deliveryFee = deliveryFeeFor(subtotal, await getSettings());
    res.status(200).json({
        status: "success",
        data: {
            code: coupon.code,
            description: coupon.description,
            discount,
            subtotal,
            deliveryFee,
            total: round2(subtotal - discount + deliveryFee),
        },
    });
};
