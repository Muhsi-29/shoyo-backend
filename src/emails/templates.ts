import { ADMIN_URL, CLIENT_URL, PLATFORM_SELLER_NAME } from "../config.js";
import { formatRupees as money } from "../utils/money.js";

// Email content. Each function returns the subject plus an HTML and a plain-text version
// (some mail apps only show plain text). Anything a user typed is escaped before going into the HTML.

export interface Email {
    to: string;
    subject: string;
    html: string;
    text: string;
}

interface EmailUser {
    name: string;
    email: string;
}

interface EmailItem {
    quantity: number;
    price: number;
    product: { title: string };
}

interface EmailOrder {
    id: number;
    createdAt: Date | string;
    subtotal: number;
    discount: number;
    deliveryFee: number;
    totalAmount: number;
    couponCode: string | null;
    paymentMethod: string;
    shippingAddress: unknown;
    user: EmailUser;
    items: EmailItem[];
}

export const escapeHtml = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const formatDate = (date: Date | string) =>
    new Date(date).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

const firstName = (name: string) => name.split(" ")[0] ?? name;

// Shared layout: brand header, content, footer
const layout = (title: string, body: string) => `<!doctype html>
<html><body style="margin:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0"><tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">
      <tr><td style="background:#0f172a;padding:20px 24px;color:#ffffff;font-size:22px;font-weight:bold">
        <span style="color:#10b981">&#9679;</span> Shoyo
      </td></tr>
      <tr><td style="padding:24px">
        <h1 style="font-size:20px;margin:0 0 16px">${title}</h1>
        ${body}
      </td></tr>
      <tr><td style="padding:16px 24px;background:#f1f5f9;color:#64748b;font-size:12px">
        You're receiving this email because of activity on your Shoyo account.
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

const button = (label: string, url: string) =>
    `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="background:#10b981;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold">${escapeHtml(label)}</a></p>`;

interface Notice {
    to: string;
    subject: string;
    title: string;
    greeting?: string;
    paragraphs: string[];
    details?: [string, string][];
    action?: { label: string; url: string };
}

// A simple message: greeting, a few paragraphs, an optional table of details and a button
const notice = ({ to, subject, title, greeting, paragraphs, details, action }: Notice): Email => ({
    to,
    subject,
    html: layout(escapeHtml(title), [
        greeting ? `<p>${escapeHtml(greeting)}</p>` : "",
        ...paragraphs.map(p => `<p style="line-height:1.6">${escapeHtml(p)}</p>`),
        details?.length
            ? `<table cellpadding="0" cellspacing="0" style="font-size:14px;margin:16px 0">${details.map(([label, value]) =>
                `<tr><td style="padding:4px 16px 4px 0;color:#64748b">${escapeHtml(label)}</td><td style="padding:4px 0;font-weight:bold">${escapeHtml(value)}</td></tr>`).join("")}</table>`
            : "",
        action ? button(action.label, action.url) : "",
    ].join("")),
    text: [
        greeting,
        ...paragraphs,
        ...(details?.map(([label, value]) => `${label}: ${value}`) ?? []),
        action ? `${action.label}: ${action.url}` : undefined,
    ].filter(Boolean).join("\n\n"),
});

const addressLines = (address: unknown): string[] => {
    if (!address || typeof address !== "object") return [];
    const a = address as Record<string, string | undefined>;
    return [a.fullName, a.line1, a.line2, [a.city, a.state, a.postalCode].filter(Boolean).join(", "), a.phone ? `Phone: ${a.phone}` : ""]
        .filter((line): line is string => Boolean(line));
};

const PAYMENT_LABELS: Record<string, string> = {
    STRIPE: "Paid online (card)",
    RAZORPAY: "Paid online (UPI / card / net banking)",
    COD: "Cash on delivery",
};

// ---------- Account ----------

export const welcomeEmail = (user: EmailUser): Email => notice({
    to: user.email,
    subject: "Welcome to Shoyo!",
    title: `Welcome, ${user.name}!`,
    paragraphs: ["Thanks for creating a Shoyo account. You can now save items to your cart and wishlist, check out and track your orders."],
    action: { label: "Start shopping", url: `${CLIENT_URL}/products` },
});

export const passwordResetEmail = (user: EmailUser, resetUrl: string): Email => notice({
    to: user.email,
    subject: "Reset your Shoyo password",
    title: "Reset your password",
    greeting: `Hi ${firstName(user.name)},`,
    paragraphs: [
        "We received a request to reset your password. The link below works once, for the next 30 minutes.",
        "If you didn't ask for this, you can ignore this email: your password stays the same.",
    ],
    action: { label: "Choose a new password", url: resetUrl },
});

export const newsletterWelcomeEmail = (email: string): Email => notice({
    to: email,
    subject: "You're on the Shoyo list",
    title: "Thanks for subscribing!",
    paragraphs: ["You'll be the first to hear about new arrivals, special offers and sales."],
    action: { label: "See what's new", url: `${CLIENT_URL}/products?sort=newest` },
});

export const contactMessageEmail = (to: string, message: { name: string; email: string; subject: string; message: string }): Email => notice({
    to,
    subject: `Contact form: ${message.subject}`,
    title: "New message from the contact form",
    paragraphs: [message.message],
    details: [["From", `${message.name} <${message.email}>`], ["Subject", message.subject]],
});

// ---------- Orders ----------

// Itemised invoice table used by the confirmation email
const invoiceTable = (order: EmailOrder) => {
    const rows = order.items.map(item => `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0">${escapeHtml(item.product.title)}</td>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center">${item.quantity}</td>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right">${money(item.price)}</td>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right">${money(item.price * item.quantity)}</td>
        </tr>`).join("");
    const totalRow = (label: string, value: string, bold = false) =>
        `<tr><td colspan="3" style="padding:6px 8px;text-align:right;${bold ? "font-weight:bold" : "color:#64748b"}">${label}</td>
             <td style="padding:6px 8px;text-align:right;${bold ? "font-weight:bold" : ""}">${value}</td></tr>`;
    return `
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">
        <tr style="background:#f1f5f9">
          <th style="padding:8px;text-align:left">Item</th><th style="padding:8px">Qty</th>
          <th style="padding:8px;text-align:right">Price</th><th style="padding:8px;text-align:right">Total</th>
        </tr>
        ${rows}
        ${totalRow("Items", money(order.subtotal))}
        ${order.discount > 0 ? totalRow(`Coupon ${escapeHtml(order.couponCode ?? "")}`, `-${money(order.discount)}`) : ""}
        ${totalRow("Delivery", order.deliveryFee > 0 ? money(order.deliveryFee) : "Free")}
        ${totalRow("Order total", money(order.totalAmount), true)}
      </table>`;
};

// Sent when a cash-on-delivery order is placed, or when an online payment succeeds. Doubles as the invoice.
export const orderConfirmationEmail = (order: EmailOrder): Email => {
    const paidOnline = order.paymentMethod !== "COD";
    const subject = paidOnline ? `Payment received: invoice for order #${order.id}` : `Order #${order.id} confirmed`;
    const address = addressLines(order.shippingAddress);
    const paymentLabel = PAYMENT_LABELS[order.paymentMethod] ?? order.paymentMethod;
    return {
        to: order.user.email,
        subject,
        html: layout(paidOnline ? "Thanks for your payment!" : "Thanks for your order!", `
            <p>Hi ${escapeHtml(firstName(order.user.name))}, here is your invoice.</p>
            <p style="color:#64748b;font-size:14px">
              Invoice for order <strong>#${order.id}</strong> &middot; ${formatDate(order.createdAt)}<br>
              Payment: ${paymentLabel}
            </p>
            ${invoiceTable(order)}
            ${address.length ? `<h2 style="font-size:16px;margin:24px 0 8px">Shipping to</h2>
              <p style="font-size:14px;line-height:1.6">${address.map(escapeHtml).join("<br>")}</p>` : ""}
            ${button("View your order", `${CLIENT_URL}/orders`)}`),
        text: [
            `Hi ${firstName(order.user.name)}, here is your invoice for order #${order.id} (${formatDate(order.createdAt)}).`,
            `Payment: ${paymentLabel}`,
            "",
            ...order.items.map(i => `${i.quantity} x ${i.product.title} - ${money(i.price * i.quantity)}`),
            `Items: ${money(order.subtotal)}`,
            ...(order.discount > 0 ? [`Coupon ${order.couponCode}: -${money(order.discount)}`] : []),
            `Delivery: ${order.deliveryFee > 0 ? money(order.deliveryFee) : "Free"}`,
            `Order total: ${money(order.totalAmount)}`,
            ...(address.length ? ["", "Shipping to:", ...address] : []),
            "",
            `View your order: ${CLIENT_URL}/orders`,
        ].join("\n"),
    };
};

export const orderCancelledEmail = (order: { id: number; user: EmailUser }, reason: string | undefined, refundAmount: number): Email => notice({
    to: order.user.email,
    subject: `Order #${order.id} was cancelled`,
    title: "Your order was cancelled",
    greeting: `Hi ${firstName(order.user.name)},`,
    paragraphs: [
        `Order #${order.id} has been cancelled.${reason ? ` ${reason}` : ""}`,
        ...(refundAmount > 0 ? [`A refund of ${money(refundAmount)} has been started. It usually reaches your account in 5-7 working days.`] : []),
    ],
    action: { label: "View your orders", url: `${CLIENT_URL}/orders` },
});

interface EmailShipment {
    id: number;
    courier: string | null;
    trackingNumber: string | null;
    seller: { storeName: string } | null;
    items: EmailItem[];
}

const itemList = (items: EmailItem[]) => items.map(i => `${i.quantity} x ${i.product.title}`).join(", ");

export const shipmentShippedEmail = (order: { id: number; user: EmailUser }, shipment: EmailShipment): Email => notice({
    to: order.user.email,
    subject: `Your order #${order.id} has shipped`,
    title: "Your order is on its way!",
    greeting: `Hi ${firstName(order.user.name)},`,
    paragraphs: [`Good news: these items from order #${order.id} have been shipped: ${itemList(shipment.items)}.`],
    details: [
        ["Sold by", shipment.seller?.storeName ?? PLATFORM_SELLER_NAME],
        ...(shipment.courier ? [["Courier", shipment.courier] as [string, string]] : []),
        ...(shipment.trackingNumber ? [["Tracking number", shipment.trackingNumber] as [string, string]] : []),
    ],
    action: { label: "Track your order", url: `${CLIENT_URL}/orders` },
});

export const shipmentDeliveredEmail = (order: { id: number; user: EmailUser }, shipment: EmailShipment, returnWindowDays: number): Email => notice({
    to: order.user.email,
    subject: `Your order #${order.id} was delivered`,
    title: "Delivered!",
    greeting: `Hi ${firstName(order.user.name)},`,
    paragraphs: [
        `These items from order #${order.id} have been delivered: ${itemList(shipment.items)}.`,
        `We hope you love them. You can rate the seller, review the products, or return an item within ${returnWindowDays} days.`,
    ],
    action: { label: "Review your purchase", url: `${CLIENT_URL}/orders` },
});

export const shipmentCancelledEmail = (order: { id: number; user: EmailUser }, shipment: EmailShipment, reason: string | undefined, refundAmount: number): Email => notice({
    to: order.user.email,
    subject: `Part of your order #${order.id} was cancelled`,
    title: "Some items were cancelled",
    greeting: `Hi ${firstName(order.user.name)},`,
    paragraphs: [
        `Sorry, these items from order #${order.id} were cancelled by ${shipment.seller?.storeName ?? PLATFORM_SELLER_NAME}: ${itemList(shipment.items)}.${reason ? ` Reason: ${reason}` : ""}`,
        ...(refundAmount > 0 ? [`A refund of ${money(refundAmount)} has been started. It usually reaches your account in 5-7 working days.`] : []),
    ],
    action: { label: "View your orders", url: `${CLIENT_URL}/orders` },
});

// ---------- Returns ----------

export const returnRequestedEmail = (to: string, details: { orderId: number; productTitle: string; reason: string; comment: string | null; refundAmount: number }): Email => notice({
    to,
    subject: `Return requested for order #${details.orderId}`,
    title: "A customer wants to return an item",
    paragraphs: ["Review the request in your dashboard and approve it to refund the customer."],
    details: [
        ["Order", `#${details.orderId}`],
        ["Item", details.productTitle],
        ["Reason", details.reason],
        ...(details.comment ? [["Comment", details.comment] as [string, string]] : []),
        ["Refund", money(details.refundAmount)],
    ],
});

export const returnResolvedEmail = (user: EmailUser, details: { orderId: number; productTitle: string; approved: boolean; refundAmount: number; note: string | null; manualRefund: boolean }): Email => notice({
    to: user.email,
    subject: details.approved ? `Refund started for order #${details.orderId}` : `Return request for order #${details.orderId}`,
    title: details.approved ? "Your return was approved" : "Your return request was declined",
    greeting: `Hi ${firstName(user.name)},`,
    paragraphs: details.approved
        ? [
            `We've accepted your return of ${details.productTitle}.`,
            details.manualRefund
                ? `We'll send ${money(details.refundAmount)} to the UPI ID you gave us within 5-7 working days.`
                : `A refund of ${money(details.refundAmount)} has been started. It usually reaches your account in 5-7 working days.`,
            ...(details.note ? [details.note] : []),
        ]
        : [`We couldn't accept your return of ${details.productTitle}.${details.note ? ` ${details.note}` : ""}`, "If you think this is a mistake, reply to this email or use our contact page."],
    action: { label: "View your orders", url: `${CLIENT_URL}/orders` },
});

// ---------- Sellers ----------

export const sellerApplicationReceivedEmail = (user: EmailUser, storeName: string): Email => notice({
    to: user.email,
    subject: "We received your seller application",
    title: "Thanks for applying to sell on Shoyo",
    greeting: `Hi ${firstName(user.name)},`,
    paragraphs: [`We're reviewing your application for "${storeName}". You'll get an email as soon as it's approved, usually within 1-2 working days.`],
});

export const newSellerApplicationEmail = (to: string, seller: { storeName: string; user: EmailUser }): Email => notice({
    to,
    subject: `New seller application: ${seller.storeName}`,
    title: "A new seller wants to join",
    paragraphs: ["Review the application in the admin panel (Sellers page)."],
    details: [["Store", seller.storeName], ["Applicant", `${seller.user.name} <${seller.user.email}>`]],
    action: { label: "Open the admin panel", url: `${ADMIN_URL}/sellers` },
});

const SELLER_STATUS_COPY: Record<string, { subject: string; title: string; text: string }> = {
    APPROVED: { subject: "Your Shoyo store is approved!", title: "You're ready to sell", text: "Your store has been approved. Add your products from the seller dashboard: they'll go live once our team checks them." },
    REJECTED: { subject: "About your Shoyo seller application", title: "Your application wasn't approved", text: "We couldn't approve your seller application this time." },
    SUSPENDED: { subject: "Your Shoyo store has been suspended", title: "Your store is suspended", text: "Your store has been suspended and your products are hidden from shoppers." },
};

export const sellerStatusEmail = (user: EmailUser, storeName: string, status: string, reason: string | undefined): Email | null => {
    const copy = SELLER_STATUS_COPY[status];
    if (!copy) return null;
    return notice({
        to: user.email,
        subject: copy.subject,
        title: copy.title,
        greeting: `Hi ${firstName(user.name)},`,
        paragraphs: [`${copy.text}${reason ? ` Reason: ${reason}` : ""}`, `Store: ${storeName}`],
        action: { label: "Open your seller dashboard", url: `${CLIENT_URL}/seller` },
    });
};

export const listingStatusEmail = (user: EmailUser, productTitle: string, approved: boolean, reason: string | undefined): Email => notice({
    to: user.email,
    subject: approved ? `"${productTitle}" is now live` : `"${productTitle}" wasn't approved`,
    title: approved ? "Your product is live" : "Your product needs changes",
    greeting: `Hi ${firstName(user.name)},`,
    paragraphs: approved
        ? [`"${productTitle}" has been approved and shoppers can now buy it.`]
        : [`"${productTitle}" wasn't approved.${reason ? ` Reason: ${reason}` : ""} Edit the product to send it for review again.`],
    action: { label: "Open your seller dashboard", url: `${CLIENT_URL}/seller?tab=products` },
});

export const newSellerOrderEmail = (seller: { storeName: string; user: EmailUser }, orderId: number, items: EmailItem[]): Email => notice({
    to: seller.user.email,
    subject: `New order #${orderId} to ship`,
    title: "You have a new order",
    greeting: `Hi ${firstName(seller.user.name)},`,
    paragraphs: [`Please pack and ship these items: ${itemList(items)}.`],
    action: { label: "Open your orders", url: `${CLIENT_URL}/seller?tab=orders` },
});

export const payoutEmail = (seller: { storeName: string; user: EmailUser; payoutUpi: string }, amount: number, reference: string | null): Email => notice({
    to: seller.user.email,
    subject: `Payout of ${money(amount)} sent`,
    title: "We've sent your earnings",
    greeting: `Hi ${firstName(seller.user.name)},`,
    paragraphs: [`We've sent ${money(amount)} to ${seller.payoutUpi}.`],
    details: [["Store", seller.storeName], ...(reference ? [["Reference", reference] as [string, string]] : [])],
    action: { label: "See your payouts", url: `${CLIENT_URL}/seller?tab=payouts` },
});
