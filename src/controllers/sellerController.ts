import type { Response } from "express";
import prisma from "../db.js";
import { currentSeller, currentUserId, type AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { sellerRatingFor, visibleProductWhere } from "../services/productService.js";
import { createProductFromRequest, deleteProductById, updateProductFromRequest } from "../services/productListingService.js";
import { listReturns, resolveReturn } from "../services/returnService.js";
import { applyAsSeller, sellerEarnings, sellerOverview, updateSellerProfile } from "../services/sellerService.js";
import { nextShipmentStatuses } from "../services/shipmentService.js";
import { HttpError } from "../utils/httpError.js";
import {
    idParamsSchema, returnResolveSchema, sellerApplySchema, sellerUpdateSchema, slugParamsSchema,
} from "../validation/schemas.js";
import { getSettings } from "../services/settingsService.js";

// ---------- Public ----------

// POST /sellers/apply: a logged-in shopper applies to open a store
export const applyToSell = async (req: AuthenticatedRequest, res: Response) => {
    const input = sellerApplySchema.parse(req.body ?? {});
    const seller = await applyAsSeller(currentUserId(req), input);
    res.status(201).json({ status: "success", message: "Application received. We'll email you once it's reviewed.", data: seller });
};

// GET /sellers/:slug: a store's public page (approved stores only)
export const getStorePage = async (req: AuthenticatedRequest, res: Response) => {
    const { slug } = slugParamsSchema.parse(req.params);
    const seller = await prisma.seller.findUnique({
        where: { slug },
        select: { id: true, storeName: true, slug: true, description: true, status: true, createdAt: true, pickupAddress: true },
    });
    if (!seller || seller.status !== "APPROVED") {
        throw new HttpError(404, "Store not found");
    }
    const [rating, products] = await Promise.all([
        sellerRatingFor(seller.id),
        prisma.product.findMany({
            where: { AND: [visibleProductWhere, { sellerId: seller.id }] },
            orderBy: [{ soldCount: "desc" }, { createdAt: "desc" }],
            take: 60,
        }),
    ]);
    // Only the city and state are shown publicly, never the full pickup address
    const { pickupAddress, ...store } = seller;
    const { city, state } = (pickupAddress ?? {}) as { city?: string; state?: string };
    res.status(200).json({
        status: "success",
        data: {
            ...store,
            location: [city, state].filter(Boolean).join(", "),
            rating,
            products: products.map(p => ({ ...p, sellerName: seller.storeName, seller: { id: seller.id, storeName: seller.storeName, slug: seller.slug, status: seller.status } })),
        },
    });
};

// ---------- Seller dashboard (loadSeller has attached req.seller) ----------

// GET /seller/me: store details, earnings and what needs attention
export const getMyStore = async (req: AuthenticatedRequest, res: Response) => {
    res.status(200).json({ status: "success", data: await sellerOverview(currentSeller(req).id) });
};

// PATCH /seller/me
export const updateMyStore = async (req: AuthenticatedRequest, res: Response) => {
    const input = sellerUpdateSchema.parse(req.body ?? {});
    const seller = await updateSellerProfile(currentSeller(req).id, input);
    res.status(200).json({ status: "success", message: "Store details saved", data: seller });
};

// GET /seller/products: the seller's products, including those waiting for approval or rejected
export const getMyProducts = async (req: AuthenticatedRequest, res: Response) => {
    const products = await prisma.product.findMany({
        where: { sellerId: currentSeller(req).id },
        orderBy: { createdAt: "desc" },
    });
    res.status(200).json({ status: "success", data: products });
};

// POST /seller/products: new products wait for an admin to approve them
export const createMyProduct = async (req: AuthenticatedRequest, res: Response) => {
    const product = await createProductFromRequest(req, { sellerId: currentSeller(req).id, status: "PENDING" });
    res.status(201).json({ status: "success", message: "Product submitted. It goes live once our team approves it.", data: product });
};

// PUT /seller/products/:id
export const updateMyProduct = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const product = await updateProductFromRequest(req, id, { sellerId: currentSeller(req).id });
    res.status(200).json({ status: "success", data: product });
};

// DELETE /seller/products/:id
export const deleteMyProduct = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    await deleteProductById(id, { sellerId: currentSeller(req).id });
    res.status(200).json({ status: "success", message: "Product deleted" });
};

// GET /seller/shipments: the seller's orders to pack and ship. Online orders appear once they're paid.
export const getMyShipments = async (req: AuthenticatedRequest, res: Response) => {
    const shipments = await prisma.shipment.findMany({
        where: {
            sellerId: currentSeller(req).id,
            order: { OR: [{ paymentMethod: "COD" }, { paidAt: { not: null } }] },
        },
        include: {
            items: { include: { product: { select: { id: true, title: true, image: true, category: true } } } },
            order: {
                select: {
                    id: true, createdAt: true, status: true, paymentMethod: true, paidAt: true,
                    shippingAddress: true, user: { select: { name: true } },
                },
            },
        },
        orderBy: { createdAt: "desc" },
        take: 200,
    });
    res.status(200).json({
        status: "success",
        data: shipments.map(s => ({ ...s, nextStatuses: nextShipmentStatuses(s, s.order) })),
    });
};

// GET /seller/returns
export const getMyReturns = async (req: AuthenticatedRequest, res: Response) => {
    res.status(200).json({ status: "success", data: await listReturns(currentSeller(req).id) });
};

// PATCH /seller/returns/:id { action: approve | reject, note }
export const resolveMyReturn = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = returnResolveSchema.parse(req.body ?? {});
    const request = await resolveReturn(id, { role: "SELLER", sellerId: currentSeller(req).id }, input);
    res.status(200).json({
        status: "success",
        message: input.action === "approve" ? "Return approved and the customer refunded." : "Return rejected.",
        data: request,
    });
};

// GET /seller/payouts: earnings summary and payout history
export const getMyPayouts = async (req: AuthenticatedRequest, res: Response) => {
    const seller = currentSeller(req);
    const [earnings, payouts] = await Promise.all([
        sellerEarnings(seller.id),
        prisma.payout.findMany({ where: { sellerId: seller.id }, orderBy: { createdAt: "desc" } }),
    ]);
    res.status(200).json({
        status: "success",
        data: { earnings, payouts, commissionRate: seller.commissionRate ?? (await getSettings()).defaultCommissionRate, payoutUpi: seller.payoutUpi },
    });
};
