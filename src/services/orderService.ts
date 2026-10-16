import type { OrderItem, OrderStatus, PaymentMethod, Prisma } from "@prisma/client";
import type Stripe from "stripe";
import prisma from "../db.js";
import stripe from "../stripe.js";
import logger from "../logger.js";
import { invalidateProductCache } from "../cache.js";
import { queueEmail } from "../emails/mailer.js";
import { newSellerOrderEmail, orderCancelledEmail, orderConfirmationEmail } from "../emails/templates.js";
import {
    CLIENT_URL, CURRENCY, PUBLIC_BACKEND_URL, RAZORPAY_KEY_ID,
} from "../config.js";
import { razorpay, verifyPaymentSignature } from "../razorpay.js";
import { HttpError } from "../utils/httpError.js";
import { round2, toPaise } from "../utils/money.js";
import { idSchema, type OrderItemInput, type ShippingAddress } from "../validation/schemas.js";
import { evaluateCoupon, redeemCoupon, releaseCoupon } from "./couponService.js";
import { deliveryFeeFor } from "./deliveryService.js";
import { getSettings, paymentOptions } from "./settingsService.js";
import { REFUND_EVERYTHING, refundOrderPayment } from "./paymentService.js";
import { isProductVisible, sellerSummarySelect } from "./productService.js";

// Everything an order response (and an order email) needs
export const orderInclude = {
    items: { include: { product: true, returnRequest: true }, orderBy: { id: "asc" } },
    shipments: { include: { seller: { select: sellerSummarySelect } }, orderBy: { id: "asc" } },
    user: { select: { id: true, name: true, email: true } },
} satisfies Prisma.OrderInclude;

export type OrderWithDetails = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export const findOrder = (id: number) => prisma.order.findUnique({ where: { id }, include: orderInclude });

// Puts items back on sale (an order or shipment was cancelled, or an item was returned)
export const restockItems = async (tx: Prisma.TransactionClient, items: Pick<OrderItem, "productId" | "quantity">[]) => {
    for (const item of items) {
        await tx.product.update({
            where: { id: item.productId },
            data: { stock: { increment: item.quantity }, soldCount: { decrement: item.quantity } },
        });
    }
};

// ---------- Placing orders ----------

interface PlaceOrderOptions {
    items?: OrderItemInput[] | undefined; // Leave out to order everything in the user's cart
    shippingAddress: ShippingAddress;
    couponCode?: string | undefined;
}

// Spreads a coupon discount over the items in proportion to their value, so refunding one item is fair
const splitDiscount = (discount: number, amounts: number[]) => {
    const total = amounts.reduce((sum, amount) => sum + amount, 0);
    if (discount <= 0 || total <= 0) return amounts.map(() => 0);
    const shares = amounts.map(amount => round2((discount * amount) / total));
    // Put any rounding difference on the last item so the shares add up exactly
    const last = shares.length - 1;
    shares[last] = round2(shares[last]! + discount - shares.reduce((sum, share) => sum + share, 0));
    return shares;
};

// Creates a PENDING order, reserves its stock, applies the coupon and delivery fee, and splits it into one
// shipment per seller, all in a single transaction. Throws HttpError for an empty cart, unavailable
// products, low stock or an unusable coupon.
const placeOrder = async (userId: number, { items, shippingAddress, couponCode }: PlaceOrderOptions, paymentMethod: PaymentMethod) => {
    const lines = items ?? await prisma.cartItem.findMany({
        where: { userId, savedForLater: false },
        select: { productId: true, quantity: true },
    });
    if (lines.length === 0) {
        throw new HttpError(400, "Your cart is empty.");
    }

    // Merge repeated lines for the same product, so stock is checked against the combined quantity
    const quantities = new Map<number, number>();
    for (const { productId, quantity } of lines) {
        quantities.set(productId, (quantities.get(productId) ?? 0) + quantity);
    }

    const rules = await getSettings();
    const order = await prisma.$transaction(async (tx) => {
        const products = await tx.product.findMany({
            where: { id: { in: [...quantities.keys()] } },
            include: { seller: true },
        });
        const productMap = new Map(products.map(p => [p.id, p]));

        const lineItems: { productId: number; quantity: number; price: number; sellerId: number | null; commissionRate: number }[] = [];
        for (const [productId, quantity] of quantities) {
            const product = productMap.get(productId);
            if (!product) {
                throw new HttpError(404, `Product with ID ${productId} not found.`);
            }
            if (!isProductVisible(product)) {
                throw new HttpError(400, `"${product.title}" is no longer available.`);
            }

            // Check and decrement in one statement: it only matches while enough stock is left,
            // so two people ordering the last unit at the same moment can't both get it.
            const { count } = await tx.product.updateMany({
                where: { id: productId, stock: { gte: quantity } },
                data: { stock: { decrement: quantity }, soldCount: { increment: quantity } },
            });
            if (count === 0) {
                throw new HttpError(400, `Insufficient stock for product "${product.title}". Only ${product.stock} items left.`);
            }

            lineItems.push({
                productId,
                quantity,
                price: product.price,
                sellerId: product.sellerId,
                // Shoyo's own products pay no commission
                commissionRate: product.seller ? (product.seller.commissionRate ?? rules.defaultCommissionRate) : 0,
            });
        }

        const subtotal = round2(lineItems.reduce((sum, line) => sum + line.price * line.quantity, 0));
        const coupon = couponCode ? await evaluateCoupon(couponCode, userId, subtotal, tx) : null;
        const discount = coupon?.discount ?? 0;
        const deliveryFee = deliveryFeeFor(subtotal, rules);
        const itemDiscounts = splitDiscount(discount, lineItems.map(line => line.price * line.quantity));

        const created = await tx.order.create({
            data: {
                userId,
                subtotal,
                discount,
                deliveryFee,
                totalAmount: round2(subtotal - discount + deliveryFee),
                couponCode: coupon?.coupon.code ?? null,
                status: "PENDING",
                paymentMethod,
                shippingAddress: shippingAddress as Prisma.InputJsonObject,
                items: {
                    create: lineItems.map((line, i) => ({
                        productId: line.productId,
                        quantity: line.quantity,
                        price: line.price,
                        discount: itemDiscounts[i] ?? 0,
                    })),
                },
            },
        });

        // One shipment per seller: each seller packs and ships their own items
        const bySeller = new Map<number | null, typeof lineItems>();
        for (const line of lineItems) {
            bySeller.set(line.sellerId, [...(bySeller.get(line.sellerId) ?? []), line]);
        }
        for (const [sellerId, sellerLines] of bySeller) {
            const shipmentSubtotal = round2(sellerLines.reduce((sum, line) => sum + line.price * line.quantity, 0));
            const commissionRate = sellerLines[0]!.commissionRate;
            const commission = round2(shipmentSubtotal * commissionRate);
            const shipment = await tx.shipment.create({
                data: {
                    orderId: created.id,
                    sellerId,
                    subtotal: shipmentSubtotal,
                    commissionRate,
                    commission,
                    sellerEarning: round2(shipmentSubtotal - commission),
                },
            });
            await tx.orderItem.updateMany({
                where: { orderId: created.id, productId: { in: sellerLines.map(line => line.productId) } },
                data: { shipmentId: shipment.id },
            });
        }

        if (coupon) {
            await redeemCoupon(tx, coupon.coupon.id, userId, created.id);
        }

        return tx.order.findUniqueOrThrow({ where: { id: created.id }, include: orderInclude });
    }, { timeout: 15_000 });

    await invalidateProductCache(); // Stock changed
    return order;
};

// Remove what was just bought from the user's cart (anything they added afterwards stays)
const removePurchasedFromCart = (order: OrderWithDetails) =>
    prisma.cartItem.deleteMany({
        where: { userId: order.userId, savedForLater: false, productId: { in: order.items.map(item => item.productId) } },
    });

// Tell each marketplace seller in the order that they have items to ship
const notifySellers = async (order: OrderWithDetails) => {
    const sellerIds = order.shipments.map(s => s.sellerId).filter((id): id is number => id !== null);
    if (sellerIds.length === 0) return;
    const sellers = await prisma.seller.findMany({
        where: { id: { in: sellerIds } },
        include: { user: { select: { name: true, email: true } } },
    });
    for (const seller of sellers) {
        const shipment = order.shipments.find(s => s.sellerId === seller.id)!;
        queueEmail(newSellerOrderEmail(seller, order.id, order.items.filter(item => item.shipmentId === shipment.id)));
    }
};

// Cash on delivery: the order is confirmed straight away
export const placeCodOrder = async (userId: number, input: PlaceOrderOptions) => {
    if (!paymentOptions(await getSettings()).cod) {
        throw new HttpError(400, "Cash on delivery isn't available right now. Please pay online.");
    }
    const order = await placeOrder(userId, input, "COD");
    await removePurchasedFromCart(order);
    queueEmail(orderConfirmationEmail(order));
    await notifySellers(order);
    return order;
};

// ---------- Paying online ----------

// Marks a PENDING online order as PAID, empties those items from the cart, emails the invoice and tells the
// sellers to ship. Safe to call more than once (gateways can report the same payment twice).
export const markOrderPaid = async (orderId: number, payment: { stripePaymentIntentId?: string | null; razorpayPaymentId?: string | null } = {}) => {
    const paymentIds = {
        ...(payment.stripePaymentIntentId ? { stripePaymentIntentId: payment.stripePaymentIntentId } : {}),
        ...(payment.razorpayPaymentId ? { razorpayPaymentId: payment.razorpayPaymentId } : {}),
    };
    const { count } = await prisma.order.updateMany({
        where: { id: orderId, status: "PENDING", paymentMethod: { not: "COD" } },
        data: { status: "PAID", paidAt: new Date(), ...paymentIds },
    });

    if (count === 0) {
        // Paid after the order was already cancelled (e.g. the shopper finished paying very late): refund it
        const current = await prisma.order.findUnique({ where: { id: orderId } });
        if (current?.status === "CANCELLED" && !current.paidAt && current.paymentMethod !== "COD") {
            await prisma.order.update({ where: { id: orderId }, data: { paidAt: new Date(), ...paymentIds } });
            await refundOrderPayment(orderId, REFUND_EVERYTHING, "Paid after the order was cancelled");
            logger.warn({ orderId }, "Payment arrived for a cancelled order; refunded");
        }
        return false;
    }

    const order = (await findOrder(orderId))!;
    await removePurchasedFromCart(order);
    queueEmail(orderConfirmationEmail(order));
    await notifySellers(order);
    logger.info({ orderId }, "Order marked as PAID");
    return true;
};

// Stripe needs absolute image URLs, but uploaded images are stored as "/uploads/...".
// Prefix those with the backend's public URL, or leave the image out if none is configured.
const toStripeImageUrl = (image: string) => {
    if (/^https?:\/\//.test(image)) return image;
    return PUBLIC_BACKEND_URL ? `${PUBLIC_BACKEND_URL}${image}` : null;
};

// What Stripe shows on its payment page. With a coupon, one line with the discounted total keeps the amount exact.
const stripeLineItems = (order: OrderWithDetails): Stripe.Checkout.SessionCreateParams.LineItem[] => {
    if (order.discount > 0) {
        return [{
            price_data: {
                currency: CURRENCY,
                product_data: {
                    name: `Shoyo order #${order.id}`,
                    description: `${order.items.length} item(s), coupon ${order.couponCode} applied`,
                },
                unit_amount: toPaise(order.subtotal - order.discount),
            },
            quantity: 1,
        }];
    }
    return order.items.map(item => {
        const image = toStripeImageUrl(item.product.image);
        return {
            price_data: {
                currency: CURRENCY,
                product_data: { name: item.product.title, ...(image ? { images: [image] } : {}) },
                unit_amount: toPaise(item.price), // Stripe wants the smallest unit (paise/cents)
            },
            quantity: item.quantity,
        };
    });
};

const CHECKOUT_EXPIRES_MINUTES = 30; // Stripe's minimum; stock stays reserved until then

const paymentFailed = () =>
    new HttpError(502, "Could not start the online payment. Please try again or choose cash on delivery.");

// Creates the PENDING order (reserving stock) and a Stripe Checkout session for it.
// The order ID travels with the session, so we always know exactly which order was paid.
export const startStripeCheckout = async (userId: number, input: PlaceOrderOptions) => {
    if (!paymentOptions(await getSettings()).stripe) {
        throw new HttpError(400, "Card payments with Stripe aren't available on this store.");
    }
    const order = await placeOrder(userId, input, "STRIPE");

    let session;
    try {
        session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            mode: "payment",
            customer_email: order.user.email,
            line_items: stripeLineItems(order),
            ...(order.deliveryFee > 0 ? {
                shipping_options: [{
                    shipping_rate_data: {
                        type: "fixed_amount",
                        display_name: "Standard delivery",
                        fixed_amount: { amount: toPaise(order.deliveryFee), currency: CURRENCY },
                    },
                }],
            } : {}),
            success_url: `${CLIENT_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${CLIENT_URL}/checkout?cancelled=${order.id}`,
            client_reference_id: String(order.id),
            metadata: { orderId: String(order.id) },
            expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_EXPIRES_MINUTES * 60,
        });
    } catch (error) {
        // Stripe failed, so the shopper can't pay: release the stock we just reserved
        logger.error({ err: error, orderId: order.id }, "Could not create Stripe checkout session");
        await cancelOrder(order.id, ["PENDING"], { notify: false });
        throw paymentFailed();
    }

    await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: session.id } });
    return { orderId: order.id, url: session.url };
};

const paymentIntentIdOf = (session: Stripe.Checkout.Session) =>
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;

// Called by the checkout success page. Lets the shopper see "paid" right away, and makes orders get
// marked PAID even when webhooks aren't set up (e.g. local development without the Stripe CLI).
export const confirmStripeCheckout = async (userId: number, sessionId: string) => {
    let session;
    try {
        session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch {
        throw new HttpError(400, "Invalid checkout session.");
    }

    const orderId = idSchema.safeParse(session.metadata?.orderId);
    const order = orderId.success ? await findOrder(orderId.data) : null;
    if (!order || order.userId !== userId) {
        throw new HttpError(404, "Order not found.");
    }

    if (session.payment_status === "paid") {
        await markOrderPaid(order.id, { stripePaymentIntentId: paymentIntentIdOf(session) });
    }
    return (await findOrder(order.id))!;
};

// Makes sure a Stripe checkout session can no longer be paid, so its order can safely be cancelled.
// Reports whether the shopper had already paid.
const closeStripeSession = async (sessionId: string): Promise<{ paid: boolean; paymentIntentId: string | null }> => {
    try {
        await stripe.checkout.sessions.expire(sessionId);
        return { paid: false, paymentIntentId: null };
    } catch (error) {
        // Expiring fails when the session isn't open any more: find out how it ended
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.status === "expired") return { paid: false, paymentIntentId: null };
        if (session.payment_status === "paid") return { paid: true, paymentIntentId: paymentIntentIdOf(session) };
        if (session.status === "complete") {
            throw new HttpError(409, "The payment for this order is still being processed.");
        }
        throw error;
    }
};

// Creates the PENDING order and a Razorpay order for it. The browser then opens Razorpay's checkout
// (UPI, cards, net banking) with these details.
export const startRazorpayCheckout = async (userId: number, input: PlaceOrderOptions) => {
    if (!paymentOptions(await getSettings()).razorpay) {
        throw new HttpError(400, "UPI and net banking payments with Razorpay aren't available on this store.");
    }
    const order = await placeOrder(userId, input, "RAZORPAY");

    let razorpayOrder;
    try {
        razorpayOrder = await razorpay.createOrder({
            amount: toPaise(order.totalAmount),
            currency: CURRENCY.toUpperCase(),
            receipt: `order_${order.id}`,
            notes: { orderId: String(order.id) },
        });
    } catch (error) {
        logger.error({ err: error, orderId: order.id }, "Could not create Razorpay order");
        await cancelOrder(order.id, ["PENDING"], { notify: false });
        throw paymentFailed();
    }

    await prisma.order.update({ where: { id: order.id }, data: { razorpayOrderId: razorpayOrder.id } });
    return {
        orderId: order.id,
        razorpayOrderId: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        keyId: RAZORPAY_KEY_ID,
        customer: { name: order.user.name, email: order.user.email, contact: input.shippingAddress.phone },
    };
};

// Called by the browser after Razorpay's checkout succeeds. The signature proves the payment is real.
export const verifyRazorpayPayment = async (
    userId: number,
    { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature }: { orderId: number; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }
) => {
    const order = await findOrder(orderId);
    if (!order || order.userId !== userId) {
        throw new HttpError(404, "Order not found.");
    }
    if (order.paymentMethod !== "RAZORPAY" || order.razorpayOrderId !== razorpayOrderId) {
        throw new HttpError(400, "This payment doesn't belong to this order.");
    }
    if (!verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
        throw new HttpError(400, "Payment verification failed.");
    }
    await markOrderPaid(order.id, { razorpayPaymentId });
    return (await findOrder(order.id))!;
};

// Has the shopper actually paid this Razorpay order? Returns the captured payment's ID, if any.
export const capturedRazorpayPayment = async (razorpayOrderId: string) => {
    const { items } = await razorpay.fetchOrderPayments(razorpayOrderId);
    return items.find(payment => payment.status === "captured")?.id ?? null;
};

// ---------- Cancelling ----------

// Cancels a whole order if it's still in one of `fromStatuses`: puts its stock back, gives back the coupon,
// refunds whatever was paid and (optionally) emails the customer. Returns the cancelled order, or null if it
// had already moved on (so stock is never restored twice).
export const cancelOrder = async (
    orderId: number,
    fromStatuses: OrderStatus[],
    { reason, notify = true }: { reason?: string; notify?: boolean } = {}
) => {
    const cancelled = await prisma.$transaction(async (tx) => {
        const { count } = await tx.order.updateMany({
            where: { id: orderId, status: { in: fromStatuses } },
            data: { status: "CANCELLED" },
        });
        if (count === 0) return false;

        // Shipments cancelled earlier were already restocked
        const openShipments = await tx.shipment.findMany({
            where: { orderId, status: { not: "CANCELLED" } },
            include: { items: true },
        });
        for (const shipment of openShipments) {
            await restockItems(tx, shipment.items);
        }
        await tx.shipment.updateMany({
            where: { orderId, status: { not: "CANCELLED" } },
            data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason ?? null },
        });
        await releaseCoupon(tx, orderId);
        return true;
    });
    if (!cancelled) return null;

    await invalidateProductCache(); // Stock changed
    const refunded = await refundOrderPayment(orderId, REFUND_EVERYTHING, reason ?? "Order cancelled");
    const order = (await findOrder(orderId))!;
    if (notify) queueEmail(orderCancelledEmail(order, reason, refunded));
    return order;
};

// A shopper cancelling their own order: allowed until something has shipped. Paid orders are refunded.
export const cancelOrderByCustomer = async (orderId: number, userId: number) => {
    const order = await findOrder(orderId);
    if (!order) throw new HttpError(404, "Order not found.");
    if (order.userId !== userId) throw new HttpError(403, "Forbidden. You cannot access this order.");
    if (order.status !== "PENDING" && order.status !== "PAID") {
        throw new HttpError(409, `This order is ${order.status.toLowerCase()} and can no longer be cancelled.`);
    }
    if (order.shipments.some(s => s.status === "SHIPPED" || s.status === "DELIVERED")) {
        throw new HttpError(409, "Part of this order has already shipped, so it can't be cancelled. You can return items once they're delivered.");
    }

    // An online payment may have gone through without us hearing about it yet. Check, so it gets refunded.
    if (order.status === "PENDING" && order.paymentMethod === "STRIPE" && order.stripeSessionId) {
        const result = await closeStripeSession(order.stripeSessionId);
        if (result.paid) await markOrderPaid(order.id, { stripePaymentIntentId: result.paymentIntentId });
    }
    if (order.status === "PENDING" && order.paymentMethod === "RAZORPAY" && order.razorpayOrderId) {
        const paymentId = await capturedRazorpayPayment(order.razorpayOrderId);
        if (paymentId) await markOrderPaid(order.id, { razorpayPaymentId: paymentId });
    }

    const cancelled = await cancelOrder(order.id, ["PENDING", "PAID"], { reason: "You cancelled it." });
    if (!cancelled) throw new HttpError(409, "This order was updated in the meantime. Please refresh.");
    return cancelled;
};

// ---------- Background clean-up ----------

const STALE_AFTER_MINUTES = 60;

// Safety net, run every few minutes: online orders that were never paid get cancelled so their reserved
// stock goes back on sale. Orders whose payment went through without us hearing about it are marked PAID.
export const cancelStaleOnlineOrders = async () => {
    const stale = await prisma.order.findMany({
        where: {
            paymentMethod: { in: ["STRIPE", "RAZORPAY"] },
            status: "PENDING",
            createdAt: { lt: new Date(Date.now() - STALE_AFTER_MINUTES * 60 * 1000) },
        },
        select: { id: true, paymentMethod: true, stripeSessionId: true, razorpayOrderId: true },
    });

    for (const order of stale) {
        try {
            if (order.paymentMethod === "STRIPE" && order.stripeSessionId) {
                const result = await closeStripeSession(order.stripeSessionId);
                if (result.paid) {
                    await markOrderPaid(order.id, { stripePaymentIntentId: result.paymentIntentId });
                    continue;
                }
            }
            if (order.paymentMethod === "RAZORPAY" && order.razorpayOrderId) {
                const paymentId = await capturedRazorpayPayment(order.razorpayOrderId);
                if (paymentId) {
                    await markOrderPaid(order.id, { razorpayPaymentId: paymentId });
                    continue;
                }
            }
            await cancelOrder(order.id, ["PENDING"], { reason: "The payment wasn't completed in time." });
            logger.info({ orderId: order.id }, "Cancelled unpaid online order");
        } catch (error) {
            logger.error({ err: error, orderId: order.id }, "Could not clean up unpaid online order");
        }
    }
    return stale.length;
};
