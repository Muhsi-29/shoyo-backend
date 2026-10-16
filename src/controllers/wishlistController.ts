import type { Response } from "express";
import prisma from "../db.js";
import { currentUserId, type AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { isProductVisible, sellerNameFor, sellerSummarySelect } from "../services/productService.js";
import { HttpError } from "../utils/httpError.js";
import { productIdParamsSchema, wishlistSchema } from "../validation/schemas.js";

const sendWishlist = async (res: Response, userId: number) => {
    const items = await prisma.wishlistItem.findMany({
        where: { userId },
        include: { product: { include: { seller: { select: sellerSummarySelect } } } },
        orderBy: { createdAt: "desc" },
    });
    res.status(200).json({
        status: "success",
        data: items.map(item => ({
            productId: item.productId,
            addedAt: item.createdAt,
            available: isProductVisible(item.product), // Products can be taken off sale after being saved
            product: { ...item.product, sellerName: sellerNameFor(item.product.seller) },
        })),
    });
};

// GET /wishlist
export const getWishlist = async (req: AuthenticatedRequest, res: Response) => {
    await sendWishlist(res, currentUserId(req));
};

// POST /wishlist { productId }
export const addToWishlist = async (req: AuthenticatedRequest, res: Response) => {
    const userId = currentUserId(req);
    const { productId } = wishlistSchema.parse(req.body ?? {});
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) throw new HttpError(404, `Product with ID ${productId} not found.`);
    await prisma.wishlistItem.upsert({
        where: { userId_productId: { userId, productId } },
        create: { userId, productId },
        update: {},
    });
    await sendWishlist(res, userId);
};

// DELETE /wishlist/:productId
export const removeFromWishlist = async (req: AuthenticatedRequest, res: Response) => {
    const userId = currentUserId(req);
    const { productId } = productIdParamsSchema.parse(req.params);
    await prisma.wishlistItem.deleteMany({ where: { userId, productId } });
    await sendWishlist(res, userId);
};
