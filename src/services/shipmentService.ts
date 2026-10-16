import type { OrderStatus, PaymentMethod, Prisma, ShipmentStatus } from "@prisma/client";
import prisma from "../db.js";
import { invalidateProductCache } from "../cache.js";
import { queueEmail } from "../emails/mailer.js";
import { shipmentCancelledEmail, shipmentDeliveredEmail, shipmentShippedEmail } from "../emails/templates.js";
import { HttpError } from "../utils/httpError.js";
import { round2 } from "../utils/money.js";
import { releaseCoupon } from "./couponService.js";
import { findOrder, restockItems } from "./orderService.js";
import { REFUND_EVERYTHING, refundOrderPayment } from "./paymentService.js";
import { sellerSummarySelect } from "./productService.js";
import { getSettings } from "./settingsService.js";

// Who is changing a shipment: an admin can change any; a seller only their own
export interface Actor {
    role: "BUYER" | "SELLER" | "ADMIN";
    sellerId: number | null;
}

// Which status a shipment can move to next
export const nextShipmentStatuses = (
    shipment: { status: ShipmentStatus },
    order: { status: OrderStatus; paymentMethod: PaymentMethod; paidAt: Date | null }
): ShipmentStatus[] => {
    if (order.status === "CANCELLED") return [];
    switch (shipment.status) {
        case "PENDING":
            // Online orders ship only once they're paid
            return order.paymentMethod !== "COD" && !order.paidAt ? [] : ["SHIPPED", "CANCELLED"];
        case "SHIPPED":
            return ["DELIVERED"];
        default:
            return [];
    }
};

// The order's status follows its shipments: SHIPPED once every remaining shipment has shipped, DELIVERED
// once all are delivered, CANCELLED if all were cancelled. Cash on delivery counts as paid on delivery.
export const recomputeOrderStatus = async (tx: Prisma.TransactionClient, orderId: number) => {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { shipments: true } });
    const active = order.shipments.filter(s => s.status !== "CANCELLED");

    let status: OrderStatus;
    if (active.length === 0) status = "CANCELLED";
    else if (active.every(s => s.status === "DELIVERED")) status = "DELIVERED";
    else if (active.every(s => s.status === "SHIPPED" || s.status === "DELIVERED")) status = "SHIPPED";
    else status = order.paidAt ? "PAID" : "PENDING";

    const paidAt = order.paidAt ?? (status === "DELIVERED" && order.paymentMethod === "COD" ? new Date() : null);
    if (status !== order.status || paidAt !== order.paidAt) {
        await tx.order.update({ where: { id: orderId }, data: { status, paidAt } });
    }
    if (status === "CANCELLED" && order.status !== "CANCELLED") {
        await releaseCoupon(tx, orderId);
    }
    return status;
};

interface ShipmentUpdate {
    status: "SHIPPED" | "DELIVERED" | "CANCELLED";
    courier?: string | undefined;
    trackingNumber?: string | undefined;
    reason?: string | undefined;
}

export const updateShipmentStatus = async (shipmentId: number, actor: Actor, input: ShipmentUpdate) => {
    const shipment = await prisma.shipment.findUnique({
        where: { id: shipmentId },
        include: { order: true, items: { include: { product: true } }, seller: { select: sellerSummarySelect } },
    });
    if (!shipment) throw new HttpError(404, "Shipment not found.");

    const isOwner = shipment.sellerId !== null && shipment.sellerId === actor.sellerId;
    if (actor.role !== "ADMIN" && !isOwner) {
        throw new HttpError(403, "Forbidden. This shipment belongs to another seller.");
    }

    const allowed = nextShipmentStatuses(shipment, shipment.order);
    if (!allowed.includes(input.status)) {
        const waitingForPayment = shipment.status === "PENDING" && allowed.length === 0 && shipment.order.status !== "CANCELLED";
        throw new HttpError(409, waitingForPayment
            ? "This order hasn't been paid yet, so it can't be shipped."
            : `A ${shipment.status.toLowerCase()} shipment can't be marked ${input.status.toLowerCase()}.`);
    }

    const now = new Date();
    const data: Prisma.ShipmentUpdateManyMutationInput =
        input.status === "SHIPPED" ? { status: "SHIPPED", shippedAt: now, courier: input.courier ?? null, trackingNumber: input.trackingNumber ?? null }
        : input.status === "DELIVERED" ? { status: "DELIVERED", deliveredAt: now }
        : { status: "CANCELLED", cancelledAt: now, cancelReason: input.reason ?? null };

    const orderStatus = await prisma.$transaction(async (tx) => {
        // Only update if nobody changed the shipment since we read it
        const { count } = await tx.shipment.updateMany({ where: { id: shipmentId, status: shipment.status }, data });
        if (count === 0) throw new HttpError(409, "This shipment was updated in the meantime. Please refresh.");
        if (input.status === "CANCELLED") await restockItems(tx, shipment.items);
        return recomputeOrderStatus(tx, shipment.orderId);
    });

    let refunded = 0;
    if (input.status === "CANCELLED") {
        await invalidateProductCache(); // Stock changed
        // Refund the cancelled items if they were paid online; if nothing is left in the order, refund the rest too
        const itemsValue = round2(shipment.items.reduce((sum, item) => sum + item.price * item.quantity - item.discount, 0));
        refunded = await refundOrderPayment(
            shipment.orderId,
            orderStatus === "CANCELLED" ? REFUND_EVERYTHING : itemsValue,
            input.reason ?? "Items cancelled by the seller"
        );
    }

    const order = (await findOrder(shipment.orderId))!;
    const emailShipment = { ...shipment, courier: input.courier ?? null, trackingNumber: input.trackingNumber ?? null };
    if (input.status === "SHIPPED") queueEmail(shipmentShippedEmail(order, emailShipment));
    if (input.status === "DELIVERED") queueEmail(shipmentDeliveredEmail(order, emailShipment, (await getSettings()).returnWindowDays));
    if (input.status === "CANCELLED") queueEmail(shipmentCancelledEmail(order, emailShipment, input.reason, refunded));
    return order;
};

// The customer rates the seller after their items arrive
export const rateShipmentSeller = async (
    shipmentId: number,
    userId: number,
    { rating, feedback }: { rating: number; feedback?: string | undefined }
) => {
    const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId }, include: { order: { select: { userId: true } } } });
    if (!shipment || shipment.order.userId !== userId) throw new HttpError(404, "Shipment not found.");
    if (shipment.sellerId === null) {
        throw new HttpError(400, "Items sold by Shoyo Retail can be reviewed on their product pages.");
    }
    if (shipment.status !== "DELIVERED") {
        throw new HttpError(400, "You can rate the seller once your items are delivered.");
    }
    return prisma.shipment.update({
        where: { id: shipmentId },
        data: { sellerRating: rating, sellerFeedback: feedback ?? null },
    });
};
