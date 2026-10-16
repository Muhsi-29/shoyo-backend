import prisma from "../db.js";
import stripe from "../stripe.js";
import logger from "../logger.js";
import { razorpay } from "../razorpay.js";
import { enqueueJob } from "../jobs/queue.js";
import { round2, toPaise } from "../utils/money.js";

// Pass as the amount to refund everything that was paid and not refunded yet
export const REFUND_EVERYTHING = Number.POSITIVE_INFINITY;

// Refunds (part of) an order's payment. Returns the amount refunded (0 if nothing was paid).
// The amount is reserved in the database first, with the order row locked, so the same money can never be
// refunded twice; the gateway call then runs as a background job with retries. Cash-on-delivery refunds
// have no gateway: the team sends them by hand (to the UPI ID the customer gave).
export const refundOrderPayment = async (orderId: number, requestedAmount: number, reason: string) => {
    const reserved = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
        const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
        if (!order.paidAt) return null;

        const remaining = round2(order.totalAmount - order.refundedAmount);
        const amount = Math.min(Number.isFinite(requestedAmount) ? round2(requestedAmount) : remaining, remaining);
        if (amount <= 0) return null;

        await tx.order.update({ where: { id: orderId }, data: { refundedAmount: { increment: amount } } });
        return { order, amount };
    });
    if (!reserved) return 0;

    const { order, amount } = reserved;
    const notes = { orderId: String(orderId), reason: reason.slice(0, 200) };

    if (order.paymentMethod === "STRIPE" && order.stripePaymentIntentId) {
        const paymentIntent = order.stripePaymentIntentId;
        enqueueJob(`Stripe refund for order #${orderId}`, async () => {
            await stripe.refunds.create({ payment_intent: paymentIntent, amount: toPaise(amount), metadata: notes });
        });
    } else if (order.paymentMethod === "RAZORPAY" && order.razorpayPaymentId) {
        const paymentId = order.razorpayPaymentId;
        enqueueJob(`Razorpay refund for order #${orderId}`, async () => {
            await razorpay.refundPayment(paymentId, toPaise(amount), notes);
        });
    } else {
        logger.info({ orderId, amount }, "Refund to be sent manually (cash on delivery)");
    }
    return amount;
};
