import type { Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { ADMIN_EMAIL } from "../config.js";
import { currentUserId, type AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { permissionsFor, STAFF_ROLE_LABELS } from "../permissions.js";
import { logActivity } from "../services/activityService.js";
import { invalidateProductCache } from "../cache.js";
import { HttpError } from "../utils/httpError.js";
import { round2 } from "../utils/money.js";
import { activityQuerySchema, adminUpdateSchema, customerUpdateSchema, idParamsSchema } from "../validation/schemas.js";

// The store owner's account (ADMIN_EMAIL in .env) always keeps full access and can't be removed or blocked
const isOwner = (email: string) => Boolean(ADMIN_EMAIL) && email.toLowerCase() === ADMIN_EMAIL.toLowerCase();

// ---------- Customers ----------

// GET /admin/customers/:id: one shopper's profile, money, addresses, orders, reviews and returns
export const getCustomerDetail = async (req: Request, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const user = await prisma.user.findUnique({
        where: { id },
        select: {
            id: true, name: true, email: true, role: true, createdAt: true, blockedAt: true, blockedReason: true,
            seller: { select: { id: true, storeName: true, slug: true, status: true } },
            addresses: { orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] },
        },
    });
    if (!user || user.role === "ADMIN") throw new HttpError(404, "Customer not found");

    const [orders, orderCount, spending, reviews, returns, reviewCount, returnCount] = await Promise.all([
        prisma.order.findMany({
            where: { userId: id },
            select: {
                id: true, createdAt: true, status: true, totalAmount: true, refundedAmount: true, paymentMethod: true, paidAt: true,
                _count: { select: { items: true } },
            },
            orderBy: { createdAt: "desc" },
            take: 20,
        }),
        prisma.order.count({ where: { userId: id } }),
        prisma.order.aggregate({ where: { userId: id, paidAt: { not: null } }, _sum: { totalAmount: true, refundedAmount: true } }),
        prisma.review.findMany({
            where: { userId: id },
            select: { id: true, rating: true, title: true, comment: true, createdAt: true, product: { select: { id: true, title: true } } },
            orderBy: { createdAt: "desc" },
            take: 10,
        }),
        prisma.returnRequest.findMany({
            where: { userId: id },
            select: {
                id: true, status: true, reason: true, refundAmount: true, createdAt: true,
                orderItem: { select: { quantity: true, product: { select: { id: true, title: true } }, order: { select: { id: true } } } },
            },
            orderBy: { createdAt: "desc" },
            take: 10,
        }),
        prisma.review.count({ where: { userId: id } }),
        prisma.returnRequest.count({ where: { userId: id } }),
    ]);

    res.status(200).json({
        status: "success",
        data: {
            ...user,
            stats: {
                orderCount,
                totalSpent: round2((spending._sum.totalAmount ?? 0) - (spending._sum.refundedAmount ?? 0)),
                reviewCount,
                returnCount,
                lastOrderAt: orders[0]?.createdAt ?? null,
            },
            orders: orders.map(({ _count, ...order }) => ({ ...order, itemCount: _count.items })),
            reviews,
            returns,
        },
    });
};

// PATCH /admin/customers/:id { blocked, reason }: a blocked account can't log in or use the API.
// Blocking a seller also suspends their store, so shoppers stop seeing products nobody will ship.
export const updateCustomer = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const { blocked, reason } = customerUpdateSchema.parse(req.body ?? {});
    const user = await prisma.user.findUnique({ where: { id }, include: { seller: true } });
    if (!user || user.role === "ADMIN") throw new HttpError(404, "Customer not found");

    if (blocked === Boolean(user.blockedAt)) {
        res.status(200).json({ status: "success", message: blocked ? "Already blocked" : "Already active", data: user });
        return;
    }

    const updates: Prisma.PrismaPromise<unknown>[] = [
        prisma.user.update({
            where: { id },
            data: blocked ? { blockedAt: new Date(), blockedReason: reason ?? null } : { blockedAt: null, blockedReason: null },
        }),
    ];
    const suspendStore = blocked && user.seller?.status === "APPROVED";
    if (suspendStore) {
        updates.push(prisma.seller.update({
            where: { id: user.seller!.id },
            data: { status: "SUSPENDED", statusReason: "The owner's account was blocked" },
        }));
    }
    await prisma.$transaction(updates);
    if (suspendStore) await invalidateProductCache();

    await logActivity(req, {
        action: blocked ? "customer.blocked" : "customer.unblocked",
        summary: blocked
            ? `Blocked ${user.name} (${user.email})${reason ? `: ${reason}` : ""}${suspendStore ? " and suspended their store" : ""}`
            : `Unblocked ${user.name} (${user.email})`,
        targetType: "customer",
        targetId: id,
    });

    const message = blocked
        ? `${user.name} is blocked${suspendStore ? " and their store is suspended" : ""}.`
        : `${user.name} can log in again.${user.seller?.status === "SUSPENDED" ? " Their store is still suspended: reactivate it on the Sellers page." : ""}`;
    const fresh = await prisma.user.findUniqueOrThrow({
        where: { id },
        select: { id: true, name: true, email: true, blockedAt: true, blockedReason: true, seller: { select: { status: true } } },
    });
    res.status(200).json({ status: "success", message, data: fresh });
};

// ---------- Admins ----------

// GET /admin/admins: everyone with admin access, with their role
export const getAdmins = async (req: Request, res: Response) => {
    const admins = await prisma.user.findMany({
        where: { role: "ADMIN" },
        select: { id: true, name: true, email: true, staffRole: true, createdAt: true },
        orderBy: { createdAt: "asc" },
    });
    res.status(200).json({
        status: "success",
        data: admins.map(admin => ({ ...admin, isOwner: isOwner(admin.email), permissions: permissionsFor(admin.staffRole) })),
    });
};

// Shared checks before changing or removing another admin
const findOtherAdmin = async (req: AuthenticatedRequest, id: number, action: string) => {
    const admin = await prisma.user.findUnique({ where: { id } });
    if (!admin || admin.role !== "ADMIN") throw new HttpError(404, "Admin not found");
    if (admin.id === currentUserId(req)) throw new HttpError(400, `You can't ${action} your own account. Ask another admin with full access.`);
    if (isOwner(admin.email)) throw new HttpError(400, `The store owner's account (set in the server's .env) can't be ${action === "remove" ? "removed" : "changed"}.`);
    return admin;
};

// PATCH /admin/admins/:id { staffRole }
export const updateAdmin = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const { staffRole } = adminUpdateSchema.parse(req.body ?? {});
    const admin = await findOtherAdmin(req, id, "change the role of");
    const updated = await prisma.user.update({
        where: { id },
        data: { staffRole },
        select: { id: true, name: true, email: true, staffRole: true, createdAt: true },
    });
    if (admin.staffRole !== staffRole) {
        await logActivity(req, {
            action: "admin.role_changed",
            summary: `Changed ${admin.name}'s role from ${STAFF_ROLE_LABELS[admin.staffRole ?? "FULL"]} to ${STAFF_ROLE_LABELS[staffRole]}`,
            targetType: "admin",
            targetId: id,
        });
    }
    res.status(200).json({
        status: "success",
        message: `${admin.name} now has ${STAFF_ROLE_LABELS[staffRole]}.`,
        data: { ...updated, isOwner: false, permissions: permissionsFor(staffRole) },
    });
};

// DELETE /admin/admins/:id: takes away admin access. The account stays (as a shopper), so their
// name stays on past activity and they can still shop.
export const removeAdmin = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const admin = await findOtherAdmin(req, id, "remove");
    await prisma.user.update({ where: { id }, data: { role: "BUYER", staffRole: null } });
    await logActivity(req, { action: "admin.removed", summary: `Removed admin access from ${admin.name} (${admin.email})`, targetType: "admin", targetId: id });
    res.status(200).json({ status: "success", message: `${admin.name} can no longer use the admin panel.` });
};

// ---------- Activity log ----------

// GET /admin/activity?adminId=&area=&q=&page=: newest first
export const getActivity = async (req: Request, res: Response) => {
    const { adminId, area, q, page, limit } = activityQuerySchema.parse(req.query);
    const where: Prisma.AdminActivityWhereInput = {
        ...(adminId ? { adminId } : {}),
        // Payouts are logged against the seller they were paid to
        ...(area ? { targetType: area } : {}),
        ...(q ? { summary: { contains: q, mode: "insensitive" } } : {}),
    };
    const [total, entries, admins] = await Promise.all([
        prisma.adminActivity.count({ where }),
        prisma.adminActivity.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
        // Everyone who appears in the log, for the "who" filter
        prisma.adminActivity.findMany({ distinct: ["adminId"], select: { adminId: true, adminName: true }, orderBy: { adminId: "asc" } }),
    ]);
    res.status(200).json({
        status: "success",
        total,
        page,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        data: entries,
        admins: admins.filter(a => a.adminId !== null),
    });
};
