import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import prisma from "../src/db.js";
import stripe from "../src/stripe.js";
import { razorpay } from "../src/razorpay.js";
import { cancelStaleOnlineOrders } from "../src/services/orderService.js";
import { testOutbox } from "../src/emails/mailer.js";
import { waitForJobs } from "../src/jobs/queue.js";
import { API, api, createProduct, createSeller, createUser, getStock, setupTestDatabase, shippingAddress } from "./helpers.js";

// Replace the payment gateways' network calls with fakes, but keep their real signature checking
vi.mock("../src/stripe.js", async (importOriginal) => {
    const real = (await importOriginal<typeof import("../src/stripe.js")>()).default;
    return {
        default: {
            webhooks: real.webhooks,
            checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() } },
            refunds: { create: vi.fn() },
        },
    };
});
vi.mock("../src/razorpay.js", async (importOriginal) => {
    const real = await importOriginal<typeof import("../src/razorpay.js")>();
    return { ...real, razorpay: { createOrder: vi.fn(), fetchOrderPayments: vi.fn(), refundPayment: vi.fn() } };
});

const sessions = vi.mocked(stripe.checkout.sessions);
const stripeRefunds = vi.mocked(stripe.refunds.create);
const rzp = vi.mocked(razorpay);

setupTestDatabase();
beforeEach(() => {
    vi.clearAllMocks();
    sessions.create.mockResolvedValue({ id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" } as any);
    rzp.createOrder.mockResolvedValue({ id: "order_rzp_123", amount: 99900, currency: "INR", status: "created" });
    rzp.refundPayment.mockResolvedValue({ id: "rfnd_1" });
});

const orderStatus = async (id: number) => (await prisma.order.findUniqueOrThrow({ where: { id } })).status;

// ---------- Stripe ----------

const stripeCheckout = async (quantity = 2, price = 499.5) => {
    const buyer = await createUser();
    const product = await createProduct({ price, stock: 10 });
    await api().post(`${API}/cart/items`).set(buyer.auth).send({ productId: product.id, quantity });
    const res = await api().post(`${API}/orders/checkout`).set(buyer.auth).send({ shippingAddress });
    return { buyer, product, res };
};

// Sends a webhook signed exactly the way Stripe signs them
const sendStripeWebhook = (type: string, orderId: number, paymentStatus = "paid", secret = "whsec_test_secret") => {
    const payload = JSON.stringify({
        id: `evt_${Date.now()}`, object: "event", type,
        data: { object: { id: "cs_test_123", object: "checkout.session", payment_status: paymentStatus, payment_intent: "pi_123", metadata: { orderId: String(orderId) } } },
    });
    const signature = new Stripe("sk_test_dummy").webhooks.generateTestHeaderString({ payload, secret });
    return api().post(`${API}/webhook/stripe`).set("Content-Type", "application/json").set("stripe-signature", signature).send(payload);
};

describe("Stripe checkout", () => {
    it("creates a pending order, reserves stock and returns Stripe's URL", async () => {
        const { product, res } = await stripeCheckout(2);

        expect(res.status).toBe(200);
        expect(res.body.url).toBe("https://checkout.stripe.com/c/pay/cs_test_123");
        const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } });
        expect(order).toMatchObject({ status: "PENDING", paymentMethod: "STRIPE", stripeSessionId: "cs_test_123", totalAmount: 999 });
        expect(await getStock(product.id)).toBe(8);

        // Prices go to Stripe in paise, in INR, with the order ID attached
        const params = sessions.create.mock.calls[0]![0] as any;
        expect(params.line_items[0].price_data).toMatchObject({ currency: "inr", unit_amount: 49950 });
        expect(params.metadata).toEqual({ orderId: String(order.id) });
        expect(params.shipping_options).toBeUndefined(); // Over the free-delivery amount
    });

    it("adds the delivery fee for small orders", async () => {
        await stripeCheckout(1, 200);
        const params = sessions.create.mock.calls[0]![0] as any;
        expect(params.shipping_options[0].shipping_rate_data.fixed_amount).toEqual({ amount: 4000, currency: "inr" });
    });

    it("releases the stock if Stripe fails", async () => {
        sessions.create.mockRejectedValue(new Error("Invalid API key"));
        const { product, res } = await stripeCheckout(2);
        expect(res.status).toBe(502);
        expect(await getStock(product.id)).toBe(10);
        expect((await prisma.order.findFirstOrThrow()).status).toBe("CANCELLED");
    });

    it("the success page marks the order PAID once, keeping the payment ID for refunds", async () => {
        const { buyer, res } = await stripeCheckout();
        sessions.retrieve.mockResolvedValue({ payment_status: "paid", payment_intent: "pi_123", metadata: { orderId: String(res.body.orderId) } } as any);

        const first = await api().post(`${API}/orders/checkout/confirm`).set(buyer.auth).send({ sessionId: "cs_test_123" });
        await api().post(`${API}/orders/checkout/confirm`).set(buyer.auth).send({ sessionId: "cs_test_123" });
        expect(first.body.data.status).toBe("PAID");
        expect((await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })).stripePaymentIntentId).toBe("pi_123");
        expect((await api().get(`${API}/cart`).set(buyer.auth)).body.data.count).toBe(0);

        await waitForJobs();
        expect(testOutbox.map(e => e.subject)).toEqual([`Payment received: invoice for order #${res.body.orderId}`]);
    });

    it("won't confirm another user's order", async () => {
        const { res } = await stripeCheckout();
        const stranger = await createUser();
        sessions.retrieve.mockResolvedValue({ payment_status: "paid", metadata: { orderId: String(res.body.orderId) } } as any);
        expect((await api().post(`${API}/orders/checkout/confirm`).set(stranger.auth).send({ sessionId: "cs_test_123" })).status).toBe(404);
        expect(await orderStatus(res.body.orderId)).toBe("PENDING");
    });

    it("webhooks: reject bad signatures, pay exactly the right order, cancel expired checkouts once", async () => {
        const { buyer, product, res } = await stripeCheckout(3);
        expect((await sendStripeWebhook("checkout.session.completed", res.body.orderId, "paid", "whsec_wrong")).status).toBe(400);

        const newer = await api().post(`${API}/orders`).set(buyer.auth).send({ items: [{ productId: product.id, quantity: 1 }], shippingAddress });
        await sendStripeWebhook("checkout.session.expired", res.body.orderId, "unpaid");
        await sendStripeWebhook("checkout.session.expired", res.body.orderId, "unpaid");
        expect(await orderStatus(res.body.orderId)).toBe("CANCELLED");
        expect(await orderStatus(newer.body.data.id)).toBe("PENDING");
        expect(await getStock(product.id)).toBe(9); // Only the newer COD order's unit is still reserved
    });

    it("an expiry can't cancel an order that was already paid", async () => {
        const { res } = await stripeCheckout();
        await sendStripeWebhook("checkout.session.completed", res.body.orderId);
        await sendStripeWebhook("checkout.session.expired", res.body.orderId, "unpaid");
        expect(await orderStatus(res.body.orderId)).toBe("PAID");
    });
});

describe("refunds", () => {
    it("cancelling a paid order refunds the full amount through Stripe", async () => {
        const { buyer, product, res } = await stripeCheckout(2); // 999
        await sendStripeWebhook("checkout.session.completed", res.body.orderId);

        const cancel = await api().patch(`${API}/orders/${res.body.orderId}/cancel`).set(buyer.auth);
        expect(cancel.status).toBe(200);
        expect(cancel.body.data).toMatchObject({ status: "CANCELLED", refundedAmount: 999 });
        expect(await getStock(product.id)).toBe(10);

        await waitForJobs();
        expect(stripeRefunds).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: "pi_123", amount: 99900 }));
        expect(testOutbox.map(e => e.subject)).toContain(`Order #${res.body.orderId} was cancelled`);
    });

    it("cancelling an unpaid online order expires its Stripe session first", async () => {
        const { buyer, res } = await stripeCheckout();
        sessions.expire.mockResolvedValue({} as any);
        expect((await api().patch(`${API}/orders/${res.body.orderId}/cancel`).set(buyer.auth)).status).toBe(200);
        expect(sessions.expire).toHaveBeenCalledWith("cs_test_123");
        expect(stripeRefunds).not.toHaveBeenCalled(); // Nothing was paid
    });

    it("if the shopper paid just before cancelling, the order is cancelled and refunded", async () => {
        const { buyer, res } = await stripeCheckout();
        sessions.expire.mockRejectedValue(new Error("Session is not open"));
        sessions.retrieve.mockResolvedValue({ status: "complete", payment_status: "paid", payment_intent: "pi_late" } as any);

        const cancel = await api().patch(`${API}/orders/${res.body.orderId}/cancel`).set(buyer.auth);
        expect(cancel.body.data.status).toBe("CANCELLED");
        await waitForJobs();
        expect(stripeRefunds).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: "pi_late" }));
    });

    it("when a seller cancels their part of a paid order, only those items are refunded", async () => {
        const buyer = await createUser();
        const { auth: sellerAuth, seller } = await createSeller();
        const own = await createProduct({ price: 1000 });
        const sellers = await createProduct({ price: 300, sellerId: seller.id });
        const res = await api().post(`${API}/orders/checkout`).set(buyer.auth)
            .send({ items: [{ productId: own.id, quantity: 1 }, { productId: sellers.id, quantity: 1 }], shippingAddress });
        await sendStripeWebhook("checkout.session.completed", res.body.orderId);

        const sellerShipment = await prisma.shipment.findFirstOrThrow({ where: { orderId: res.body.orderId, sellerId: seller.id } });
        const cancel = await api().patch(`${API}/shipments/${sellerShipment.id}`).set(sellerAuth).send({ status: "CANCELLED", reason: "Out of stock" });
        expect(cancel.status).toBe(200);
        expect(cancel.body.data).toMatchObject({ status: "PAID", refundedAmount: 300 });

        await waitForJobs();
        expect(stripeRefunds).toHaveBeenCalledWith(expect.objectContaining({ amount: 30000 }));
    });
});

// ---------- Razorpay ----------

const razorpaySignature = (data: string, secret = "razorpay_test_secret") => crypto.createHmac("sha256", secret).update(data).digest("hex");

const razorpayCheckout = async () => {
    const buyer = await createUser();
    const product = await createProduct({ price: 999, stock: 5 });
    const res = await api().post(`${API}/orders/razorpay`).set(buyer.auth).send({ items: [{ productId: product.id, quantity: 1 }], shippingAddress });
    return { buyer, product, res };
};

describe("Razorpay (UPI, cards, net banking)", () => {
    it("creates a Razorpay order for the exact total, in paise", async () => {
        const { res } = await razorpayCheckout();
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ razorpayOrderId: "order_rzp_123", amount: 99900, keyId: "rzp_test_FakeKeyForTests" });
        expect(rzp.createOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 99900, currency: "INR", notes: { orderId: String(res.body.data.orderId) } }));
        expect(await orderStatus(res.body.data.orderId)).toBe("PENDING");
    });

    it("marks the order PAID only with a valid payment signature", async () => {
        const { buyer, res } = await razorpayCheckout();
        const { orderId } = res.body.data;
        const verify = (signature: string) => api().post(`${API}/orders/razorpay/verify`).set(buyer.auth)
            .send({ orderId, razorpayOrderId: "order_rzp_123", razorpayPaymentId: "pay_123", razorpaySignature: signature });

        expect((await verify("forged-signature")).status).toBe(400);
        expect(await orderStatus(orderId)).toBe("PENDING");

        const ok = await verify(razorpaySignature("order_rzp_123|pay_123"));
        expect(ok.status).toBe(200);
        expect(ok.body.data.status).toBe("PAID");
        expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).razorpayPaymentId).toBe("pay_123");
    });

    it("accepts signed webhooks and rejects unsigned ones", async () => {
        const { res } = await razorpayCheckout();
        const payload = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_hook", order_id: "order_rzp_123", status: "captured" } } } });

        const forged = await api().post(`${API}/webhook/razorpay`).set("Content-Type", "application/json").set("x-razorpay-signature", "nope").send(payload);
        expect(forged.status).toBe(400);

        const signed = await api().post(`${API}/webhook/razorpay`).set("Content-Type", "application/json")
            .set("x-razorpay-signature", razorpaySignature(payload, "razorpay_webhook_secret")).send(payload);
        expect(signed.status).toBe(200);
        expect(await orderStatus(res.body.data.orderId)).toBe("PAID");
    });

    it("refunds a payment that arrives after the order was cancelled", async () => {
        const { buyer, res } = await razorpayCheckout();
        const { orderId } = res.body.data;
        rzp.fetchOrderPayments.mockResolvedValue({ items: [] });
        await api().patch(`${API}/orders/${orderId}/cancel`).set(buyer.auth);

        await api().post(`${API}/orders/razorpay/verify`).set(buyer.auth)
            .send({ orderId, razorpayOrderId: "order_rzp_123", razorpayPaymentId: "pay_late", razorpaySignature: razorpaySignature("order_rzp_123|pay_late") });
        await waitForJobs();
        expect(await orderStatus(orderId)).toBe("CANCELLED");
        expect(rzp.refundPayment).toHaveBeenCalledWith("pay_late", 99900, expect.anything());
    });
});

// ---------- Background clean-up ----------

describe("background clean-up job", () => {
    const makeStale = (orderId: number) =>
        prisma.order.update({ where: { id: orderId }, data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });

    it("cancels online orders left unpaid for over an hour and leaves recent ones alone", async () => {
        const { product, res } = await stripeCheckout(2);
        sessions.create.mockResolvedValueOnce({ id: "cs_test_456", url: "https://checkout.stripe.com/c/pay/cs_test_456" } as any);
        const recent = await stripeCheckout(1);
        await makeStale(res.body.orderId);
        sessions.expire.mockResolvedValue({} as any);

        expect(await cancelStaleOnlineOrders()).toBe(1);
        expect(await orderStatus(res.body.orderId)).toBe("CANCELLED");
        expect(await orderStatus(recent.res.body.orderId)).toBe("PENDING");
        expect(await getStock(product.id)).toBe(10);
    });

    it("marks a stale Razorpay order PAID if the payment actually went through", async () => {
        const { res } = await razorpayCheckout();
        await makeStale(res.body.data.orderId);
        rzp.fetchOrderPayments.mockResolvedValue({ items: [{ id: "pay_found", status: "captured" }] });

        await cancelStaleOnlineOrders();
        expect(await orderStatus(res.body.data.orderId)).toBe("PAID");
    });
});
