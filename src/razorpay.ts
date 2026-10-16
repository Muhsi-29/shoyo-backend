import crypto from "crypto";
import { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } from "./config.js";

// A small client for the three Razorpay API calls the store needs (https://razorpay.com/docs/api/).
// Amounts are in paise.

const API = "https://api.razorpay.com/v1";

const request = async <T>(method: "GET" | "POST", path: string, body?: object): Promise<T> => {
    const response = await fetch(`${API}${path}`, {
        method,
        headers: {
            Authorization: `Basic ${Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64")}`,
            "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`Razorpay ${method} ${path} failed: ${data?.error?.description ?? response.status}`);
    }
    return data as T;
};

export interface RazorpayOrder {
    id: string;
    amount: number;
    currency: string;
    status: string;
}

export interface RazorpayPayment {
    id: string;
    status: string; // "captured" once the money is ours
}

export const razorpay = {
    createOrder: (params: { amount: number; currency: string; receipt: string; notes: Record<string, string> }) =>
        request<RazorpayOrder>("POST", "/orders", params),
    fetchOrderPayments: (razorpayOrderId: string) =>
        request<{ items: RazorpayPayment[] }>("GET", `/orders/${razorpayOrderId}/payments`),
    refundPayment: (paymentId: string, amount: number, notes: Record<string, string>) =>
        request<{ id: string }>("POST", `/payments/${paymentId}/refund`, { amount, notes }),
};

const hmac = (data: string | Buffer, secret: string) => crypto.createHmac("sha256", secret).update(data).digest("hex");

// Constant-time comparison, so the signature can't be guessed byte by byte from response times
const safeEqual = (expected: string, actual: string) =>
    expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));

// Razorpay's checkout returns this signature after a successful payment: proof the payment wasn't faked
export const verifyPaymentSignature = (razorpayOrderId: string, razorpayPaymentId: string, signature: string) =>
    safeEqual(hmac(`${razorpayOrderId}|${razorpayPaymentId}`, RAZORPAY_KEY_SECRET), signature);

// Webhooks are signed with the webhook secret over the raw request body
export const verifyWebhookSignature = (rawBody: Buffer, signature: string, secret: string) =>
    safeEqual(hmac(rawBody, secret), signature);
