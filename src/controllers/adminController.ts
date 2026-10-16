import type { Request, Response } from "express";
import type { OrderStatus, PaymentMethod, Prisma } from "@prisma/client";
import prisma from "../db.js";
import { invalidateProductCache } from "../cache.js";
import { queueEmail } from "../emails/mailer.js";
import { listingStatusEmail } from "../emails/templates.js";
import { orderInclude } from "../services/orderService.js";
import { sellerRatingFor, sellerSummarySelect } from "../services/productService.js";
import { forAdmin } from "./orderController.js";
import { listReturns, resolveReturn } from "../services/returnService.js";
import { recordPayout, sellerEarnings, updateSellerByAdmin } from "../services/sellerService.js";
import { HttpError } from "../utils/httpError.js";
import {
    adminListQuerySchema, adminOrderExportSchema, adminOrderQuerySchema, adminProductQuerySchema, adminSellerUpdateSchema, couponCreateSchema,
    couponUpdateSchema, idParamsSchema, payoutSchema, productModerationSchema, returnResolveSchema, sellerListQuerySchema,
} from "../validation/schemas.js";
import { getSettings } from "../services/settingsService.js";
import type { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { logActivity } from "../services/activityService.js";
import { toCsv } from "../utils/csv.js";
import { PLATFORM_SELLER_NAME } from "../config.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;

// The last `days` days as "YYYY-MM-DD" (UTC), oldest first, so charts have a point for every day
const lastDays = (days: number) =>
    Array.from({ length: days }, (_, i) => new Date(Date.now() - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10));

// GET /admin/stats: the numbers shown on the admin dashboard
export const getStats = async (req: Request, res: Response) => {
    const [
        productCount, customerCount, orderCount, revenue, refunded, ordersByStatus, lowStock,
        sellerCount, pendingSellers, pendingListings, openReturns,
    ] = await Promise.all([
        prisma.product.count(),
        prisma.user.count({ where: { role: { in: ["BUYER", "SELLER"] } } }), // Same people as the customers list
        prisma.order.count(),
        // Money actually received: paid online, or cash collected on delivery
        prisma.order.aggregate({ _sum: { totalAmount: true }, where: { paidAt: { not: null } } }),
        prisma.order.aggregate({ _sum: { refundedAmount: true }, where: { paidAt: { not: null } } }),
        prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
        prisma.product.findMany({
            where: { stock: { lte: 5 }, status: "ACTIVE" },
            orderBy: { stock: "asc" },
            take: 10,
            select: { id: true, title: true, stock: true },
        }),
        prisma.seller.count({ where: { status: "APPROVED" } }),
        prisma.seller.count({ where: { status: "PENDING" } }),
        prisma.product.count({ where: { status: "PENDING" } }),
        prisma.returnRequest.count({ where: { status: "REQUESTED" } }),
    ]);

    // Daily sales for the last 30 days: money received (by payment date) and orders placed (by order date)
    const since = new Date(Date.now() - 30 * DAY_MS);
    const [revenueRows, orderRows, topProducts, recentOrders] = await Promise.all([
        prisma.$queryRaw<{ day: string; revenue: number }[]>`
            SELECT to_char(date_trunc('day', "paidAt"), 'YYYY-MM-DD') AS day, SUM("totalAmount" - "refundedAmount")::float AS revenue
            FROM "Order" WHERE "paidAt" >= ${since}
            GROUP BY 1`,
        prisma.$queryRaw<{ day: string; orders: number }[]>`
            SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day, COUNT(*)::int AS orders
            FROM "Order" WHERE "createdAt" >= ${since}
            GROUP BY 1`,
        prisma.product.findMany({
            where: { soldCount: { gt: 0 } },
            orderBy: { soldCount: "desc" },
            take: 5,
            select: { id: true, title: true, image: true, price: true, soldCount: true, category: true },
        }),
        prisma.order.findMany({
            orderBy: { createdAt: "desc" },
            take: 6,
            select: { id: true, totalAmount: true, status: true, paymentMethod: true, createdAt: true, user: { select: { name: true } } },
        }),
    ]);
    const revenueByDay = new Map(revenueRows.map(r => [r.day, r.revenue]));
    const ordersByDay = new Map(orderRows.map(r => [r.day, r.orders]));
    const salesByDay = lastDays(30).map(day => ({ day, revenue: round2(revenueByDay.get(day) ?? 0), orders: ordersByDay.get(day) ?? 0 }));

    res.status(200).json({
        status: "success",
        data: {
            productCount,
            customerCount,
            orderCount,
            revenue: Math.round(((revenue._sum.totalAmount ?? 0) - (refunded._sum.refundedAmount ?? 0)) * 100) / 100,
            ordersByStatus: Object.fromEntries(ordersByStatus.map(group => [group.status, group._count._all])),
            lowStock,
            sellerCount,
            pendingSellers,
            pendingListings,
            openReturns,
            salesByDay,
            topProducts,
            recentOrders,
        },
    });
};

// ---------- Orders ----------

type OrderFilters = {
    status?: OrderStatus | undefined;
    q?: string | undefined;
    paymentMethod?: PaymentMethod | undefined;
    seller?: "shoyo" | number | undefined;
    from?: string | undefined;
    to?: string | undefined;
};

// The admin order filters as a database query. "to" includes that whole day.
const orderWhere = ({ status, q, paymentMethod, seller, from, to }: OrderFilters): Prisma.OrderWhereInput => {
    const orderNumber = q && /^#?\d{1,9}$/.test(q) ? Number(q.replace("#", "")) : null;
    const createdAt: Prisma.DateTimeFilter = {};
    if (from) createdAt.gte = new Date(`${from}T00:00:00`);
    if (to) createdAt.lt = new Date(new Date(`${to}T00:00:00`).getTime() + 24 * 60 * 60 * 1000);
    return {
        ...(status ? { status } : {}),
        ...(paymentMethod ? { paymentMethod } : {}),
        ...(seller ? { shipments: { some: { sellerId: seller === "shoyo" ? null : seller } } } : {}),
        ...(from || to ? { createdAt } : {}),
        ...(q ? {
            OR: [
                ...(orderNumber ? [{ id: orderNumber }] : []),
                { user: { name: { contains: q, mode: "insensitive" } } },
                { user: { email: { contains: q, mode: "insensitive" } } },
            ],
        } : {}),
    };
};

// GET /admin/orders?status=&q=&paymentMethod=&seller=&from=&to=&page=
export const getOrdersAdmin = async (req: Request, res: Response) => {
    const { page, limit, ...filters } = adminOrderQuerySchema.parse(req.query);
    const where = orderWhere(filters);
    const [total, orders] = await prisma.$transaction([
        prisma.order.count({ where }),
        prisma.order.findMany({ where, include: orderInclude, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    ]);
    const { returnWindowDays } = await getSettings();
    res.status(200).json({ status: "success", total, page, totalPages: Math.max(1, Math.ceil(total / limit)), data: orders.map(order => forAdmin(order, returnWindowDays)) });
};

// GET /admin/orders/sellers: stores to filter orders by (open to anyone who handles orders, unlike the Sellers page)
export const getOrderSellerOptions = async (req: Request, res: Response) => {
    const sellers = await prisma.seller.findMany({
        where: { status: { in: ["APPROVED", "SUSPENDED"] } },
        select: { id: true, storeName: true },
        orderBy: { storeName: "asc" },
    });
    res.status(200).json({ status: "success", data: sellers });
};

const EXPORT_LIMIT = 10_000;
const PAYMENT_LABELS: Record<PaymentMethod, string> = { STRIPE: "Card (Stripe)", RAZORPAY: "UPI / online (Razorpay)", COD: "Cash on delivery" };

// GET /admin/orders/export?(same filters): the matching orders as a CSV file for Excel or Google Sheets
export const exportOrdersCsv = async (req: Request, res: Response) => {
    const filters = adminOrderExportSchema.parse(req.query);
    const orders = await prisma.order.findMany({
        where: orderWhere(filters),
        include: {
            user: { select: { name: true, email: true } },
            items: { select: { quantity: true } },
            shipments: { select: { seller: { select: { storeName: true } } } },
        },
        orderBy: { createdAt: "desc" },
        take: EXPORT_LIMIT,
    });
    const rows: (string | number | null | undefined)[][] = [[
        "Order", "Placed on", "Customer", "Email", "Phone", "City", "State", "PIN code", "Sellers", "Items",
        "Subtotal", "Coupon", "Discount", "Delivery fee", "Total", "Refunded", "Payment", "Paid on", "Status",
    ]];
    for (const order of orders) {
        const address = (order.shippingAddress ?? {}) as { phone?: string; city?: string; state?: string; postalCode?: string };
        const sellers = [...new Set(order.shipments.map(s => s.seller?.storeName ?? PLATFORM_SELLER_NAME))].join(" + ");
        rows.push([
            order.id, order.createdAt.toISOString().slice(0, 16).replace("T", " "),
            order.user.name, order.user.email, address.phone ?? "", address.city ?? "", address.state ?? "", address.postalCode ?? "",
            sellers, order.items.reduce((sum, item) => sum + item.quantity, 0),
            order.subtotal, order.couponCode ?? "", order.discount, order.deliveryFee, order.totalAmount, order.refundedAmount,
            PAYMENT_LABELS[order.paymentMethod], order.paidAt ? order.paidAt.toISOString().slice(0, 10) : "", order.status,
        ]);
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="shoyo-orders-${stamp}.csv"`);
    res.setHeader("X-Total-Rows", String(orders.length)); // Tells the panel how many orders the file has
    res.status(200).send(toCsv(rows));
};

// ---------- Customers ----------

// GET /admin/customers?q=&page=: shoppers with how many orders they placed and how much they spent
export const getCustomers = async (req: Request, res: Response) => {
    const { q, page, limit } = adminListQuerySchema.parse(req.query);
    const where: Prisma.UserWhereInput = {
        role: { in: ["BUYER", "SELLER"] },
        ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] } : {}),
    };
    const [total, users] = await prisma.$transaction([
        prisma.user.count({ where }),
        prisma.user.findMany({
            where,
            select: {
                id: true, name: true, email: true, role: true, createdAt: true, blockedAt: true,
                seller: { select: { storeName: true, status: true } },
                _count: { select: { orders: true } },
            },
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * limit,
            take: limit,
        }),
    ]);
    const spending = await prisma.order.groupBy({
        by: ["userId"],
        where: { userId: { in: users.map(u => u.id) }, paidAt: { not: null } },
        _sum: { totalAmount: true, refundedAmount: true },
    });
    const spentBy = new Map(spending.map(s => [s.userId, round2((s._sum.totalAmount ?? 0) - (s._sum.refundedAmount ?? 0))]));
    res.status(200).json({
        status: "success",
        total,
        page,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        data: users.map(({ _count, ...user }) => ({ ...user, orderCount: _count.orders, totalSpent: spentBy.get(user.id) ?? 0 })),
    });
};

// ---------- Reviews ----------

// GET /admin/reviews?rating=&page=: newest reviews first, for moderation (delete with DELETE /reviews/:id)
export const getReviewsAdmin = async (req: Request, res: Response) => {
    const { rating, page, limit } = adminListQuerySchema.parse(req.query);
    const where: Prisma.ReviewWhereInput = rating ? { rating } : {};
    const [total, reviews] = await prisma.$transaction([
        prisma.review.count({ where }),
        prisma.review.findMany({
            where,
            include: {
                user: { select: { name: true, email: true } },
                product: { select: { id: true, title: true, image: true, category: true } },
            },
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * limit,
            take: limit,
        }),
    ]);
    res.status(200).json({ status: "success", total, page, totalPages: Math.max(1, Math.ceil(total / limit)), data: reviews });
};

// ---------- Messages and newsletter ----------

// GET /admin/messages?page=: contact-form messages
export const getMessages = async (req: Request, res: Response) => {
    const { page, limit } = adminListQuerySchema.parse(req.query);
    const [total, messages] = await prisma.$transaction([
        prisma.contactMessage.count(),
        prisma.contactMessage.findMany({ orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    ]);
    res.status(200).json({ status: "success", total, page, totalPages: Math.max(1, Math.ceil(total / limit)), data: messages });
};

// GET /admin/subscribers: newsletter subscribers
export const getSubscribers = async (req: Request, res: Response) => {
    const subscribers = await prisma.newsletterSubscriber.findMany({ orderBy: { createdAt: "desc" } });
    res.status(200).json({ status: "success", total: subscribers.length, data: subscribers });
};

// ---------- Products (moderation) ----------

// GET /admin/products?status=PENDING&q=&page=: every product, including sellers' listings waiting for approval
export const getAllProductsAdmin = async (req: Request, res: Response) => {
    const { status, q, page, limit } = adminProductQuerySchema.parse(req.query);
    const where: Prisma.ProductWhereInput = {
        ...(status ? { status } : {}),
        ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { brand: { contains: q, mode: "insensitive" } }] } : {}),
    };
    const [total, products] = await prisma.$transaction([
        prisma.product.count({ where }),
        prisma.product.findMany({
            where,
            include: { seller: { select: sellerSummarySelect } },
            orderBy: [{ status: "asc" }, { createdAt: "desc" }],
            skip: (page - 1) * limit,
            take: limit,
        }),
    ]);
    res.status(200).json({ status: "success", total, page, totalPages: Math.max(1, Math.ceil(total / limit)), data: products });
};

// PATCH /admin/products/:id/status { status: ACTIVE | REJECTED, reason }: approve or reject a listing
export const moderateProduct = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const { status, reason } = productModerationSchema.parse(req.body ?? {});
    const product = await prisma.product.findUnique({ where: { id }, include: { seller: { include: { user: true } } } });
    if (!product) throw new HttpError(404, "Product not found");

    const updated = await prisma.product.update({
        where: { id },
        data: { status, rejectionReason: status === "REJECTED" ? reason ?? null : null },
    });
    await invalidateProductCache();
    if (product.seller && product.status !== status) {
        queueEmail(listingStatusEmail(product.seller.user, product.title, status === "ACTIVE", reason));
    }
    if (product.status !== status) {
        const store = product.seller ? ` from ${product.seller.storeName}` : "";
        await logActivity(req, {
            action: status === "ACTIVE" ? "product.approved" : "product.rejected",
            summary: status === "ACTIVE"
                ? `Approved product "${product.title}"${store}`
                : `${product.status === "ACTIVE" ? "Took down" : "Rejected"} product "${product.title}"${store}${reason ? `: ${reason}` : ""}`,
            targetType: "product",
            targetId: id,
        });
    }
    res.status(200).json({ status: "success", message: status === "ACTIVE" ? "Product approved" : "Product rejected", data: updated });
};

// ---------- Sellers ----------

// GET /admin/sellers?status=PENDING
export const getSellers = async (req: Request, res: Response) => {
    const { status } = sellerListQuerySchema.parse(req.query);
    const sellers = await prisma.seller.findMany({
        where: status ? { status } : {},
        include: {
            user: { select: { id: true, name: true, email: true } },
            payouts: { orderBy: { createdAt: "desc" }, take: 5 },
            _count: { select: { products: true } },
        },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });
    const { defaultCommissionRate } = await getSettings();
    const withMoney = await Promise.all(sellers.map(async seller => ({
        ...seller,
        effectiveCommissionRate: seller.commissionRate ?? defaultCommissionRate,
        earnings: await sellerEarnings(seller.id),
        rating: await sellerRatingFor(seller.id),
    })));
    res.status(200).json({ status: "success", data: withMoney });
};

// PATCH /admin/sellers/:id { status, reason, commissionRate }: approve, reject, suspend or reactivate a store
export const updateSeller = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = adminSellerUpdateSchema.parse(req.body ?? {});
    const before = await prisma.seller.findUnique({ where: { id }, select: { status: true, commissionRate: true } });
    const seller = await updateSellerByAdmin(id, input);
    const messages = { APPROVED: "Store approved: it's live now", REJECTED: "Application rejected", SUSPENDED: "Store suspended" };
    if (input.status && input.status !== before?.status) {
        const verbs = { APPROVED: before?.status === "SUSPENDED" ? "Reactivated" : "Approved", REJECTED: "Rejected", SUSPENDED: "Suspended" };
        await logActivity(req, {
            action: `seller.${input.status.toLowerCase()}`,
            summary: `${verbs[input.status]} store ${seller.storeName}${input.reason ? `: ${input.reason}` : ""}`,
            targetType: "seller",
            targetId: id,
        });
    }
    if (input.commissionRate !== undefined && input.commissionRate !== before?.commissionRate) {
        await logActivity(req, {
            action: "seller.commission_changed",
            summary: `Set ${seller.storeName}'s commission to ${input.commissionRate === null ? "the store default" : `${Math.round(input.commissionRate * 1000) / 10}%`}`,
            targetType: "seller",
            targetId: id,
        });
    }
    res.status(200).json({ status: "success", message: input.status ? messages[input.status] : "Commission updated", data: seller });
};

// POST /admin/sellers/:id/payouts { amount, reference }: record money sent to a seller
export const createPayout = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = payoutSchema.parse(req.body ?? {});
    const payout = await recordPayout(id, input);
    const seller = await prisma.seller.findUnique({ where: { id }, select: { storeName: true } });
    await logActivity(req, {
        action: "payout.recorded",
        summary: `Recorded a payout of ₹${input.amount.toLocaleString("en-IN")} to ${seller?.storeName ?? `seller #${id}`}${input.reference ? ` (ref ${input.reference})` : ""}`,
        targetType: "seller",
        targetId: id,
    });
    res.status(201).json({ status: "success", message: "Payout recorded and the seller emailed", data: payout });
};

// ---------- Returns ----------

// GET /admin/returns: every return request
export const getReturns = async (req: Request, res: Response) => {
    res.status(200).json({ status: "success", data: await listReturns() });
};

// PATCH /admin/returns/:id { action, note }: admins can resolve any return (e.g. for Shoyo's own products)
export const resolveReturnAdmin = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = returnResolveSchema.parse(req.body ?? {});
    const request = await resolveReturn(id, { role: "ADMIN", sellerId: null }, input);
    const details = await prisma.returnRequest.findUnique({
        where: { id },
        select: { orderItem: { select: { product: { select: { title: true } }, order: { select: { id: true } } } } },
    });
    await logActivity(req, {
        action: input.action === "approve" ? "return.refunded" : "return.rejected",
        summary: `${input.action === "approve" ? `Refunded ₹${request.refundAmount.toLocaleString("en-IN")} for` : "Rejected"} the return of "${details?.orderItem.product.title}" (order #${details?.orderItem.order.id})`,
        targetType: "return",
        targetId: id,
    });
    res.status(200).json({
        status: "success",
        message: input.action === "approve" ? "Return approved and the customer refunded." : "Return rejected.",
        data: request,
    });
};

// ---------- Coupons ----------

// GET /admin/coupons
export const getCoupons = async (req: Request, res: Response) => {
    const coupons = await prisma.coupon.findMany({ orderBy: { createdAt: "desc" } });
    res.status(200).json({ status: "success", data: coupons });
};

// POST /admin/coupons
export const createCoupon = async (req: AuthenticatedRequest, res: Response) => {
    const input = couponCreateSchema.parse(req.body ?? {});
    const existing = await prisma.coupon.findUnique({ where: { code: input.code } });
    if (existing) throw new HttpError(409, `A coupon with the code ${input.code} already exists.`);
    const coupon = await prisma.coupon.create({
        data: {
            ...input,
            maxDiscount: input.maxDiscount ?? null,
            usageLimit: input.usageLimit ?? null,
            expiresAt: input.expiresAt ?? null,
        },
    });
    await logActivity(req, { action: "coupon.created", summary: `Created coupon ${coupon.code}: ${coupon.description}`, targetType: "coupon", targetId: coupon.id });
    res.status(201).json({ status: "success", message: `Coupon ${coupon.code} created`, data: coupon });
};

// PATCH /admin/coupons/:id { active, description, expiresAt, usageLimit }
export const updateCoupon = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = couponUpdateSchema.parse(req.body ?? {});
    const data: Prisma.CouponUpdateInput = {};
    if (input.active !== undefined) data.active = input.active;
    if (input.description !== undefined) data.description = input.description;
    if (input.expiresAt !== undefined) data.expiresAt = input.expiresAt;
    if (input.usageLimit !== undefined) data.usageLimit = input.usageLimit;
    const coupon = await prisma.coupon.update({ where: { id }, data });
    const message = input.active === undefined ? "Coupon updated" : `Coupon ${coupon.code} switched ${coupon.active ? "on" : "off"}`;
    await logActivity(req, {
        action: input.active === undefined ? "coupon.updated" : coupon.active ? "coupon.activated" : "coupon.deactivated",
        summary: input.active === undefined ? `Edited coupon ${coupon.code}` : `Switched coupon ${coupon.code} ${coupon.active ? "on" : "off"}`,
        targetType: "coupon",
        targetId: id,
    });
    res.status(200).json({ status: "success", message, data: coupon });
};

// DELETE /admin/coupons/:id: a coupon that was already used is switched off instead, to keep order history
export const deleteCoupon = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const coupon = await prisma.coupon.findUnique({ where: { id } });
    if (!coupon) throw new HttpError(404, "Coupon not found");
    if (coupon.usedCount > 0) {
        await prisma.coupon.update({ where: { id }, data: { active: false } });
        await logActivity(req, { action: "coupon.deactivated", summary: `Switched off used coupon ${coupon.code}`, targetType: "coupon", targetId: id });
        res.status(200).json({ status: "success", message: "This coupon has been used, so it was switched off instead of deleted." });
        return;
    }
    await prisma.coupon.delete({ where: { id } });
    await logActivity(req, { action: "coupon.deleted", summary: `Deleted coupon ${coupon.code}`, targetType: "coupon", targetId: id });
    res.status(200).json({ status: "success", message: "Coupon deleted" });
};
