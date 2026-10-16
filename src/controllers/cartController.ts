import type { Response } from "express";
import type { Product } from "@prisma/client";
import prisma from "../db.js";
import { currentUserId, type AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { deliveryFeeFor } from "../services/deliveryService.js";
import { getSettings } from "../services/settingsService.js";
import { isProductVisible, sellerNameFor, sellerSummarySelect } from "../services/productService.js";
import { HttpError } from "../utils/httpError.js";
import { round2 } from "../utils/money.js";
import {
    cartItemSchema, cartMergeSchema, cartQuantitySchema, productIdParamsSchema, saveForLaterSchema,
} from "../validation/schemas.js";

// The logged-in user's cart. Every endpoint responds with the full, updated cart.
// Errors thrown here (validation, HttpError) are turned into JSON responses by the error handler in app.ts

const MAX_PER_PRODUCT = 100;

const loadCart = async (userId: number) => {
    const rows = await prisma.cartItem.findMany({
        where: { userId },
        include: { product: { include: { seller: { select: sellerSummarySelect } } } },
        orderBy: { createdAt: "asc" },
    });
    const toItem = (row: (typeof rows)[number]) => ({
        productId: row.productId,
        quantity: row.quantity,
        savedForLater: row.savedForLater,
        // Products can be taken off sale or sell out after being added
        available: isProductVisible(row.product) && row.product.stock > 0,
        product: { ...row.product, sellerName: sellerNameFor(row.product.seller) },
    });

    const items = rows.filter(row => !row.savedForLater).map(toItem);
    const subtotal = round2(items.reduce((sum, item) => sum + item.product.price * item.quantity, 0));
    const rules = await getSettings();
    const deliveryFee = deliveryFeeFor(subtotal, rules);
    return {
        items,
        savedItems: rows.filter(row => row.savedForLater).map(toItem),
        count: items.reduce((sum, item) => sum + item.quantity, 0),
        subtotal,
        deliveryFee,
        total: round2(subtotal + deliveryFee),
        freeDeliveryThreshold: rules.freeDeliveryThreshold,
    };
};

const sendCart = async (res: Response, userId: number) => {
    res.status(200).json({ status: "success", data: await loadCart(userId) });
};

const findProduct = async (productId: number) => {
    const product = await prisma.product.findUnique({ where: { id: productId }, include: { seller: true } });
    if (!product) {
        throw new HttpError(404, `Product with ID ${productId} not found.`);
    }
    if (!isProductVisible(product)) {
        throw new HttpError(400, `"${product.title}" is no longer available.`);
    }
    return product;
};

// Stock is reserved only when an order is placed, but don't let the cart hold more than is available
const ensureAvailable = (product: Product, quantity: number) => {
    if (product.stock === 0) {
        throw new HttpError(400, `"${product.title}" is out of stock.`);
    }
    if (quantity > product.stock) {
        throw new HttpError(400, `Only ${product.stock} of "${product.title}" left in stock.`);
    }
    if (quantity > MAX_PER_PRODUCT) {
        throw new HttpError(400, `You can add at most ${MAX_PER_PRODUCT} of one product.`);
    }
};

// GET /cart
export const getCart = async (req: AuthenticatedRequest, res: Response) => {
    await sendCart(res, currentUserId(req));
};

// POST /cart/items { productId, quantity }: adds to the cart, or increases the quantity if it's already
// there (an item that was saved for later moves back into the cart)
export const addCartItem = async (req: AuthenticatedRequest, res: Response) => {
    const userId = currentUserId(req);
    const { productId, quantity } = cartItemSchema.parse(req.body ?? {});
    const product = await findProduct(productId);

    const existing = await prisma.cartItem.findUnique({ where: { userId_productId: { userId, productId } } });
    const newQuantity = (existing?.quantity ?? 0) + quantity;
    ensureAvailable(product, newQuantity);

    await prisma.cartItem.upsert({
        where: { userId_productId: { userId, productId } },
        create: { userId, productId, quantity: newQuantity },
        update: { quantity: newQuantity, savedForLater: false },
    });
    await sendCart(res, userId);
};

// PUT /cart/items/:productId { quantity }: sets the quantity
export const setCartItemQuantity = async (req: AuthenticatedRequest, res: Response) => {
    const userId = currentUserId(req);
    const { productId } = productIdParamsSchema.parse(req.params);
    const { quantity } = cartQuantitySchema.parse(req.body ?? {});
    const product = await findProduct(productId);
    ensureAvailable(product, quantity);

    await prisma.cartItem.upsert({
        where: { userId_productId: { userId, productId } },
        create: { userId, productId, quantity },
        update: { quantity },
    });
    await sendCart(res, userId);
};

// PATCH /cart/items/:productId/save-for-later { saved }: moves an item out of (or back into) the order
export const saveForLater = async (req: AuthenticatedRequest, res: Response) => {
    const userId = currentUserId(req);
    const { productId } = productIdParamsSchema.parse(req.params);
    const { saved } = saveForLaterSchema.parse(req.body ?? {});
    const { count } = await prisma.cartItem.updateMany({ where: { userId, productId }, data: { savedForLater: saved } });
    if (count === 0) {
        throw new HttpError(404, "That item isn't in your cart.");
    }
    await sendCart(res, userId);
};

// DELETE /cart/items/:productId
export const removeCartItem = async (req: AuthenticatedRequest, res: Response) => {
    const userId = currentUserId(req);
    const { productId } = productIdParamsSchema.parse(req.params);
    await prisma.cartItem.deleteMany({ where: { userId, productId } });
    await sendCart(res, userId);
};

// DELETE /cart (items saved for later stay)
export const clearCart = async (req: AuthenticatedRequest, res: Response) => {
    const userId = currentUserId(req);
    await prisma.cartItem.deleteMany({ where: { userId, savedForLater: false } });
    await sendCart(res, userId);
};

// POST /cart/merge { items }: moves a guest's browser cart into their account after they log in.
// The guest cart may be out of date, so unavailable products are skipped and quantities are capped at the stock.
export const mergeCart = async (req: AuthenticatedRequest, res: Response) => {
    const userId = currentUserId(req);
    const { items } = cartMergeSchema.parse(req.body ?? {});

    const products = await prisma.product.findMany({
        where: { id: { in: items.map(item => item.productId) } },
        include: { seller: true },
    });
    const productMap = new Map(products.map(p => [p.id, p]));
    const existing = await prisma.cartItem.findMany({ where: { userId } });
    const existingMap = new Map(existing.map(item => [item.productId, item.quantity]));

    for (const { productId, quantity } of items) {
        const product = productMap.get(productId);
        if (!product || !isProductVisible(product) || product.stock === 0) continue;

        const merged = Math.min((existingMap.get(productId) ?? 0) + quantity, product.stock, MAX_PER_PRODUCT);
        existingMap.set(productId, merged);
        await prisma.cartItem.upsert({
            where: { userId_productId: { userId, productId } },
            create: { userId, productId, quantity: merged },
            update: { quantity: merged, savedForLater: false },
        });
    }
    await sendCart(res, userId);
};
