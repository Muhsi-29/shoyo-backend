import type { Response } from "express";
import prisma from "../db.js";
import { currentUserId, isAdminWith, type AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { logActivity } from "../services/activityService.js";
import { rateShipmentSeller, updateShipmentStatus, type Actor } from "../services/shipmentService.js";
import { HttpError } from "../utils/httpError.js";
import { idParamsSchema, sellerRatingSchema, shipmentUpdateSchema } from "../validation/schemas.js";
import { forAdmin } from "./orderController.js";
import { getSettings } from "../services/settingsService.js";

// Admins who handle orders can update any shipment; approved sellers only their own
const actorFor = async (req: AuthenticatedRequest): Promise<Actor> => {
    if (isAdminWith(req, "orders")) return { role: "ADMIN", sellerId: null };
    const seller = await prisma.seller.findUnique({ where: { userId: currentUserId(req) } });
    if (!seller || seller.status !== "APPROVED") {
        throw new HttpError(403, "Forbidden. Only the seller or an admin can update this shipment.");
    }
    return { role: "SELLER", sellerId: seller.id };
};

// PATCH /shipments/:id { status: SHIPPED | DELIVERED | CANCELLED, courier, trackingNumber, reason }
export const updateShipment = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = shipmentUpdateSchema.parse(req.body ?? {});
    const actor = await actorFor(req);
    const order = await updateShipmentStatus(id, actor, input);
    if (actor.role === "ADMIN") {
        const shipment = order.shipments.find(s => s.id === id);
        const verbs = { SHIPPED: "shipped", DELIVERED: "delivered", CANCELLED: "cancelled" } as const;
        await logActivity(req, {
            action: `order.${verbs[input.status]}`,
            summary: `Marked ${shipment?.seller?.storeName ?? "Shoyo Retail"}'s part of order #${order.id} as ${verbs[input.status]}${input.status === "CANCELLED" && input.reason ? `: ${input.reason}` : ""}`,
            targetType: "order",
            targetId: order.id,
        });
    }
    res.status(200).json({ status: "success", message: `Shipment marked as ${input.status.toLowerCase()}. The customer has been emailed.`, data: forAdmin(order, (await getSettings()).returnWindowDays) });
};

// POST /shipments/:id/rating { rating, feedback }: the customer rates the seller after delivery
export const rateSeller = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = sellerRatingSchema.parse(req.body ?? {});
    const shipment = await rateShipmentSeller(id, currentUserId(req), input);
    res.status(200).json({ status: "success", message: "Thanks for rating the seller!", data: shipment });
};
