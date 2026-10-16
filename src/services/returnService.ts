import prisma from "../db.js";
import { invalidateProductCache } from "../cache.js";
import { queueEmail } from "../emails/mailer.js";
import { returnRequestedEmail, returnResolvedEmail } from "../emails/templates.js";
import { SUPPORT_EMAIL } from "../config.js";
import { HttpError } from "../utils/httpError.js";
import { round2 } from "../utils/money.js";
import { restockItems } from "./orderService.js";
import { refundOrderPayment } from "./paymentService.js";
import type { Actor } from "./shipmentService.js";
import { getSettings } from "./settingsService.js";

export const RETURN_REASON_LABELS: Record<string, string> = {
    DAMAGED: "Arrived damaged",
    WRONG_ITEM: "Wrong item received",
    NOT_AS_DESCRIBED: "Not as described",
    NO_LONGER_NEEDED: "No longer needed",
    OTHER: "Other",
};

interface ReturnInput {
    reason: string;
    comment?: string | undefined;
    refundUpi?: string | undefined;
}

// A customer asks to return a delivered item within the return window
export const requestReturn = async (userId: number, orderItemId: number, input: ReturnInput) => {
    const item = await prisma.orderItem.findUnique({
        where: { id: orderItemId },
        include: {
            order: true,
            product: true,
            returnRequest: true,
            shipment: { include: { seller: { include: { user: { select: { email: true } } } } } },
        },
    });
    if (!item || item.order.userId !== userId) throw new HttpError(404, "Order item not found.");
    if (item.returnRequest) throw new HttpError(409, "A return was already requested for this item.");
    if (!item.shipment || item.shipment.status !== "DELIVERED" || !item.shipment.deliveredAt) {
        throw new HttpError(400, "Items can be returned once they're delivered.");
    }
    const { returnWindowDays } = await getSettings();
    if (Date.now() - item.shipment.deliveredAt.getTime() > returnWindowDays * 24 * 60 * 60 * 1000) {
        throw new HttpError(400, `The ${returnWindowDays}-day return window for this item has closed.`);
    }
    if (item.order.paymentMethod === "COD" && !input.refundUpi) {
        throw HttpError.field("refundUpi", "is required for cash-on-delivery orders (it's where we send your refund)");
    }

    const refundAmount = round2(item.price * item.quantity - item.discount);
    const request = await prisma.returnRequest.create({
        data: {
            orderItemId,
            userId,
            reason: input.reason,
            comment: input.comment ?? null,
            refundUpi: input.refundUpi ?? null,
            refundAmount,
        },
    });

    queueEmail(returnRequestedEmail(item.shipment.seller?.user.email ?? SUPPORT_EMAIL, {
        orderId: item.orderId,
        productTitle: item.product.title,
        reason: RETURN_REASON_LABELS[input.reason] ?? input.reason,
        comment: input.comment ?? null,
        refundAmount,
    }));
    return request;
};

// The seller (or an admin) approves a return, which refunds the customer and restocks the item, or rejects it
export const resolveReturn = async (
    returnId: number,
    actor: Actor,
    { action, note }: { action: "approve" | "reject"; note?: string | undefined }
) => {
    const request = await prisma.returnRequest.findUnique({
        where: { id: returnId },
        include: {
            user: { select: { name: true, email: true } },
            orderItem: { include: { product: true, shipment: true, order: true } },
        },
    });
    if (!request) throw new HttpError(404, "Return request not found.");

    const sellerId = request.orderItem.shipment?.sellerId ?? null;
    if (actor.role !== "ADMIN" && (sellerId === null || sellerId !== actor.sellerId)) {
        throw new HttpError(403, "Forbidden. This return belongs to another seller.");
    }
    if (request.status !== "REQUESTED") throw new HttpError(409, "This return has already been handled.");

    const approved = action === "approve";
    await prisma.$transaction(async (tx) => {
        const { count } = await tx.returnRequest.updateMany({
            where: { id: returnId, status: "REQUESTED" },
            data: { status: approved ? "REFUNDED" : "REJECTED", resolutionNote: note ?? null, resolvedAt: new Date() },
        });
        if (count === 0) throw new HttpError(409, "This return has already been handled.");
        if (approved) await restockItems(tx, [request.orderItem]); // The returned item goes back on sale
    });

    if (approved) {
        await invalidateProductCache();
        await refundOrderPayment(request.orderItem.orderId, request.refundAmount, `Return of ${request.orderItem.product.title}`);
    }

    queueEmail(returnResolvedEmail(request.user, {
        orderId: request.orderItem.orderId,
        productTitle: request.orderItem.product.title,
        approved,
        refundAmount: request.refundAmount,
        note: note ?? null,
        manualRefund: request.orderItem.order.paymentMethod === "COD",
    }));
    return prisma.returnRequest.findUniqueOrThrow({ where: { id: returnId } });
};

// Return requests for one seller's items (sellerId: a seller, or null for Shoyo's own), or for everything (undefined)
export const listReturns = (sellerId?: number | null) =>
    prisma.returnRequest.findMany({
        where: sellerId === undefined ? {} : { orderItem: { shipment: { sellerId } } },
        include: {
            user: { select: { name: true, email: true } },
            orderItem: {
                include: {
                    product: { select: { id: true, title: true, image: true, category: true } },
                    order: { select: { id: true, paymentMethod: true } },
                    shipment: { select: { sellerId: true } },
                },
            },
        },
        orderBy: { createdAt: "desc" },
    });
