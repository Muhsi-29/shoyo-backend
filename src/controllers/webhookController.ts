import type { Request, Response } from "express";
import type Stripe from "stripe";
import prisma from "../db.js";
import stripe from "../stripe.js";
import logger from "../logger.js";
import { RAZORPAY_WEBHOOK_SECRET, STRIPE_WEBHOOK_SECRET } from "../config.js";
import { verifyWebhookSignature } from "../razorpay.js";
import { cancelOrder, markOrderPaid } from "../services/orderService.js";
import { idSchema } from "../validation/schemas.js";

if (!STRIPE_WEBHOOK_SECRET) {
    logger.warn("STRIPE_WEBHOOK_SECRET is not set: Stripe webhooks will be rejected (the checkout success page still confirms payments).");
}

const orderIdFrom = (session: Stripe.Checkout.Session) => {
    const result = idSchema.safeParse(session.metadata?.orderId);
    return result.success ? result.data : null;
};

const paymentIntentIdOf = (session: Stripe.Checkout.Session) =>
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;

export const handleStripeWebhook = async (req: Request, res: Response) => {
    if (!STRIPE_WEBHOOK_SECRET) {
        return res.status(500).send("Webhook Error: STRIPE_WEBHOOK_SECRET is not configured");
    }

    const sig = req.headers['stripe-signature'];

    let event: Stripe.Event;

    try {
        // We must use req.body as a RAW buffer here, not regular JSON!
        event = stripe.webhooks.constructEvent(req.body, sig as string, STRIPE_WEBHOOK_SECRET);
    } catch (err: any) {
        logger.warn({ err: err.message }, "Webhook signature verification failed");
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
        // Payment went through: mark the exact order we created at checkout as PAID
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded': {
            const session = event.data.object;
            const orderId = orderIdFrom(session);
            if (orderId && session.payment_status === 'paid') {
                await markOrderPaid(orderId, { stripePaymentIntentId: paymentIntentIdOf(session) });
            }
            break;
        }

        // Shopper abandoned checkout or payment failed: cancel the order and release its stock
        case 'checkout.session.expired':
        case 'checkout.session.async_payment_failed': {
            const orderId = orderIdFrom(event.data.object);
            if (orderId && await cancelOrder(orderId, ["PENDING"], { reason: "The payment wasn't completed." })) {
                logger.info({ orderId }, "Order cancelled and stock restored");
            }
            break;
        }
    }

    // Acknowledge receipt of the event back to Stripe
    res.json({ received: true });
};

interface RazorpayWebhookEvent {
    event: string;
    payload?: {
        payment?: { entity?: { id?: string; order_id?: string; status?: string } };
    };
}

// Razorpay calls this when a payment is captured, so orders get marked PAID even if the shopper closes the
// browser before the website could confirm the payment
export const handleRazorpayWebhook = async (req: Request, res: Response) => {
    if (!RAZORPAY_WEBHOOK_SECRET) {
        return res.status(500).send("Webhook Error: RAZORPAY_WEBHOOK_SECRET is not configured");
    }
    const signature = req.headers["x-razorpay-signature"];
    if (typeof signature !== "string" || !Buffer.isBuffer(req.body) || !verifyWebhookSignature(req.body, signature, RAZORPAY_WEBHOOK_SECRET)) {
        logger.warn("Razorpay webhook signature verification failed");
        return res.status(400).send("Webhook Error: invalid signature");
    }

    const event = JSON.parse(req.body.toString("utf8")) as RazorpayWebhookEvent;
    const payment = event.payload?.payment?.entity;
    if ((event.event === "payment.captured" || event.event === "order.paid") && payment?.order_id && payment.id) {
        const order = await prisma.order.findUnique({ where: { razorpayOrderId: payment.order_id } });
        if (order) await markOrderPaid(order.id, { razorpayPaymentId: payment.id });
    }
    res.json({ received: true });
};
