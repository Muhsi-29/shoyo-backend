import type { Response } from "express";
import prisma from "../db.js";
import { currentUserId, isAdminWith, type AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import {
    cancelOrderByCustomer, confirmStripeCheckout, findOrder, orderInclude, placeCodOrder,
    startRazorpayCheckout, startStripeCheckout, verifyRazorpayPayment, type OrderWithDetails,
} from "../services/orderService.js";
import { sellerNameFor } from "../services/productService.js";
import { requestReturn } from "../services/returnService.js";
import { nextShipmentStatuses } from "../services/shipmentService.js";
import { HttpError } from "../utils/httpError.js";
import {
    confirmCheckoutSchema, idParamsSchema, orderListQuerySchema, placeOrderSchema, razorpayVerifySchema, returnRequestSchema,
} from "../validation/schemas.js";
import { getSettings } from "../services/settingsService.js";

// Errors thrown here (validation, HttpError) are turned into JSON responses by the error handler in app.ts

const DAY_MS = 24 * 60 * 60 * 1000;

// An order as the customer sees it: what they can still do (cancel, return each item, and until when)
export const forCustomer = (order: OrderWithDetails, returnWindowDays: number) => {
    const now = Date.now();
    return {
        ...order,
        canCancel: (order.status === "PENDING" || order.status === "PAID")
            && order.shipments.every(s => s.status === "PENDING" || s.status === "CANCELLED"),
        shipments: order.shipments.map(s => ({ ...s, sellerName: sellerNameFor(s.seller) })),
        items: order.items.map(item => {
            const shipment = order.shipments.find(s => s.id === item.shipmentId);
            const returnUntil = shipment?.status === "DELIVERED" && shipment.deliveredAt
                ? new Date(shipment.deliveredAt.getTime() + returnWindowDays * DAY_MS)
                : null;
            return { ...item, returnUntil, canReturn: !item.returnRequest && returnUntil !== null && returnUntil.getTime() > now };
        }),
    };
};

// An order as an admin sees it: each shipment lists the statuses it can move to next
export const forAdmin = (order: OrderWithDetails, returnWindowDays: number) => ({
    ...forCustomer(order, returnWindowDays),
    shipments: order.shipments.map(s => ({ ...s, sellerName: sellerNameFor(s.seller), nextStatuses: nextShipmentStatuses(s, order) })),
});

// 1. Place a cash-on-delivery order, from the cart (or from `items` if given)
export const createOrder = async (req: AuthenticatedRequest, res: Response) => {
    const input = placeOrderSchema.parse(req.body ?? {});
    const order = await placeCodOrder(currentUserId(req), input);
    const { returnWindowDays } = await getSettings();
    res.status(201).json({ status: "success", message: "Order placed successfully", data: forCustomer(order, returnWindowDays) });
};

// 2. Get past orders for logged-in user
export const getUserOrders = async (req: AuthenticatedRequest, res: Response) => {
    const orders = await prisma.order.findMany({
        where: { userId: currentUserId(req) },
        include: orderInclude,
        orderBy: { createdAt: "desc" },
    });
    const { returnWindowDays } = await getSettings();
    res.status(200).json({ status: "success", data: orders.map(order => forCustomer(order, returnWindowDays)) });
};

// 3. Get single order by ID (the customer's own, or any for an admin)
export const getOrderById = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const order = await findOrder(id);
    if (!order) {
        throw new HttpError(404, "Order not found.");
    }
    const isAdmin = isAdminWith(req, "orders");
    if (order.userId !== currentUserId(req) && !isAdmin) {
        throw new HttpError(403, "Forbidden. You cannot access this order.");
    }
    const { returnWindowDays } = await getSettings();
    res.status(200).json({ status: "success", data: isAdmin ? forAdmin(order, returnWindowDays) : forCustomer(order, returnWindowDays) });
};

// 4. Admin - Get all orders (optionally ?status=PENDING)
export const getAllOrders = async (req: AuthenticatedRequest, res: Response) => {
    const { status } = orderListQuerySchema.parse(req.query);
    const orders = await prisma.order.findMany({
        where: status ? { status } : {},
        include: orderInclude,
        orderBy: { createdAt: "desc" },
        take: 200,
    });
    const { returnWindowDays } = await getSettings();
    res.status(200).json({ status: "success", data: orders.map(order => forAdmin(order, returnWindowDays)) });
};

// 5. Start a Stripe Checkout card payment. Responds with the URL to send the shopper to.
export const createCheckoutSession = async (req: AuthenticatedRequest, res: Response) => {
    const input = placeOrderSchema.parse(req.body ?? {});
    const { orderId, url } = await startStripeCheckout(currentUserId(req), input);
    res.status(200).json({ status: "success", orderId, url });
};

// 6. Called by the checkout success page with Stripe's session ID: marks the order PAID if it was paid
export const confirmCheckout = async (req: AuthenticatedRequest, res: Response) => {
    const { sessionId } = confirmCheckoutSchema.parse(req.body ?? {});
    const order = await confirmStripeCheckout(currentUserId(req), sessionId);
    const { returnWindowDays } = await getSettings();
    res.status(200).json({ status: "success", data: forCustomer(order, returnWindowDays) });
};

// 7. Start a Razorpay payment (UPI, cards, net banking). Responds with what the Razorpay checkout needs.
export const createRazorpayOrder = async (req: AuthenticatedRequest, res: Response) => {
    const input = placeOrderSchema.parse(req.body ?? {});
    res.status(200).json({ status: "success", data: await startRazorpayCheckout(currentUserId(req), input) });
};

// 8. Called after Razorpay's checkout succeeds, with the signed payment details
export const verifyRazorpayCheckout = async (req: AuthenticatedRequest, res: Response) => {
    const input = razorpayVerifySchema.parse(req.body ?? {});
    const order = await verifyRazorpayPayment(currentUserId(req), input);
    const { returnWindowDays } = await getSettings();
    res.status(200).json({ status: "success", message: "Payment received", data: forCustomer(order, returnWindowDays) });
};

// 9. A shopper cancels their own order before anything ships. Online payments are refunded.
export const cancelOrder = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const order = await cancelOrderByCustomer(id, currentUserId(req));
    const { returnWindowDays } = await getSettings();
    res.status(200).json({ status: "success", message: "Order cancelled", data: forCustomer(order, returnWindowDays) });
};

// 10. A shopper asks to return a delivered item: POST /orders/items/:id/return { reason, comment, refundUpi }
export const createReturnRequest = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = returnRequestSchema.parse(req.body ?? {});
    const request = await requestReturn(currentUserId(req), id, input);
    res.status(201).json({ status: "success", message: "Return requested. We'll let you know when it's approved.", data: request });
};
