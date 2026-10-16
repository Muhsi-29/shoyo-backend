import type { Request, Response, NextFunction } from "express";
import type { Seller, StaffRole } from "@prisma/client";
import jwt from "jsonwebtoken";
import prisma from "../db.js";
import { JWT_SECRET } from "../config.js";
import { can, type Permission } from "../permissions.js";
import { HttpError } from "../utils/httpError.js";

type Role = "BUYER" | "SELLER" | "ADMIN";

// What the login token carries
interface JwtPayload {
    id: number;
    role: Role;
}

// The logged-in user as routes see it. Read from the database on each request (not just the token), so
// blocking an account, removing an admin or changing their role takes effect immediately.
export interface RequestUser {
    id: number;
    role: Role;
    name?: string;
    staffRole?: StaffRole | null;
}

// Extend Express Request to include the user field (and, on seller routes, their store)
export interface AuthenticatedRequest extends Request {
    user?: RequestUser;
    seller?: Seller;
}

const BLOCKED_MESSAGE = "This account has been blocked. Contact support for help.";

const bearerToken = (req: Request) =>
    req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.split(" ")[1] : undefined;

// The user a token belongs to, or null when the token is invalid, expired, or the account is gone
const userFromToken = async (token: string) => {
    let payload: JwtPayload;
    try {
        payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    } catch {
        return null;
    }
    return prisma.user.findUnique({
        where: { id: payload.id },
        select: { id: true, role: true, name: true, staffRole: true, blockedAt: true },
    });
};

// Auth User

export const authenticateUser = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
) => {
    const token = bearerToken(req);
    if (!token) {
        return res.status(401).json({
            status: "error",
            message: "Access denied. No token provided."
        });
    }

    const user = await userFromToken(token);
    // 401 (not 403): the client should drop the session and log in again
    if (!user) {
        return res.status(401).json({ status: "error", message: "Invalid or expired token." });
    }
    if (user.blockedAt) {
        return res.status(401).json({ status: "error", message: BLOCKED_MESSAGE });
    }

    req.user = { id: user.id, role: user.role, name: user.name, staffRole: user.staffRole };
    next();
};

// Auth Roles
export const authorizeRoles = (...allowedRoles: Role[]) => {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        if (!req.user) {
            return res.status(401).json({
                status: "error",
                message: "Unauthorized. Please log in first."
            });
        }

        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                status: "error",
                message: "Forbidden. You do not have permission to perform this action."
            });
        }

        next();
    };
};

// The logged-in user's ID inside a route protected by authenticateUser
export const currentUserId = (req: AuthenticatedRequest): number => {
    if (!req.user) {
        throw new HttpError(401, "Unauthorized. Please log in first.");
    }
    return req.user.id;
};

// For public routes that show a little more to logged-in users (e.g. "your review"):
// attaches the user when a valid token is sent, and carries on as a guest otherwise
export const optionalAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const token = bearerToken(req);
    const user = token ? await userFromToken(token) : null;
    if (user && !user.blockedAt) {
        req.user = { id: user.id, role: user.role, name: user.name, staffRole: user.staffRole };
    }
    next();
};

// Admin routes: the user must be an admin whose role includes this permission
export const requirePermission = (permission: Permission) =>
    (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        if (!req.user) throw new HttpError(401, "Unauthorized. Please log in first.");
        if (req.user.role !== "ADMIN") {
            throw new HttpError(403, "Forbidden. You do not have permission to perform this action.");
        }
        if (!can(req.user.staffRole, permission)) {
            throw new HttpError(403, "Your admin role doesn't include this. Ask an admin with full access.");
        }
        next();
    };

// For routes shared with shoppers or sellers: is this an admin allowed to act with this permission?
export const isAdminWith = (req: AuthenticatedRequest, permission: Permission) =>
    req.user?.role === "ADMIN" && can(req.user.staffRole, permission);

// Seller routes: loads the logged-in user's store (whatever its status) into req.seller
export const loadSeller = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const seller = await prisma.seller.findUnique({ where: { userId: currentUserId(req) } });
    if (!seller) {
        throw new HttpError(403, "You don't have a store yet. Apply to sell on Shoyo first.");
    }
    req.seller = seller;
    next();
};

// Seller routes that change things: the store must be approved. Checked against the database on every
// request (not the login token), so a suspension takes effect immediately.
export const requireApprovedSeller = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const messages: Record<string, string> = {
        PENDING: "Your store is waiting for approval.",
        REJECTED: "Your seller application wasn't approved.",
        SUSPENDED: "Your store is suspended. Contact support for help.",
    };
    if (req.seller?.status !== "APPROVED") {
        throw new HttpError(403, messages[req.seller?.status ?? ""] ?? "Your store isn't active.");
    }
    next();
};

// The store loaded by loadSeller
export const currentSeller = (req: AuthenticatedRequest): Seller => {
    if (!req.seller) throw new HttpError(403, "Seller account required.");
    return req.seller;
};
