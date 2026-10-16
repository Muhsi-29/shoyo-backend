import prisma from "../db.js";
import logger from "../logger.js";
import type { AuthenticatedRequest } from "../middlewares/authMiddleware.js";

export interface ActivityEntry {
    action: string;        // What happened, e.g. "seller.approved"
    summary: string;       // A sentence for the log, e.g. "Approved store Urban Trend Co."
    targetType?: string;   // "order", "product", "seller", "customer", "coupon", "banner", "admin", "settings"...
    targetId?: number;
}

// Records an admin's action in the activity log. Only admins' actions are recorded (a seller shipping
// their own order isn't), and a failure here never undoes or fails the action itself.
export const logActivity = async (req: AuthenticatedRequest, entry: ActivityEntry) => {
    const actor = req.user;
    if (!actor || actor.role !== "ADMIN") return;
    try {
        await prisma.adminActivity.create({
            data: {
                adminId: actor.id,
                adminName: actor.name ?? `Admin #${actor.id}`,
                action: entry.action,
                summary: entry.summary,
                targetType: entry.targetType ?? null,
                targetId: entry.targetId ?? null,
            },
        });
    } catch (error) {
        logger.warn({ err: error, action: entry.action }, "Couldn't record admin activity");
    }
};
