import type { Request, Response } from "express";
import type { User } from "@prisma/client";
import crypto from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import prisma from "../db.js";
import { CLIENT_URL, JWT_SECRET } from "../config.js";
import { currentUserId, type AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { permissionsFor, STAFF_ROLE_LABELS } from "../permissions.js";
import { logActivity } from "../services/activityService.js";
import { queueEmail } from "../emails/mailer.js";
import { passwordResetEmail, welcomeEmail } from "../emails/templates.js";
import { HttpError } from "../utils/httpError.js";
import {
    adminRegisterSchema, changePasswordSchema, forgotPasswordSchema, loginSchema, profileSchema, registerSchema,
    resetPasswordSchema,
} from "../validation/schemas.js";

// Errors thrown here (validation, HttpError) are turned into JSON responses by the error handler in app.ts

// Never send the password hash to the client. Admins also get the list of things their role lets them do.
const publicUser = <T extends User>(user: T) => {
    const { password: _, ...userWithoutPassword } = user;
    return { ...userWithoutPassword, permissions: user.role === "ADMIN" ? permissionsFor(user.staffRole) : [] };
};

// The store details sent with the user, so the website knows whether to show the seller dashboard
const withSeller = { seller: { select: { id: true, storeName: true, slug: true, status: true, statusReason: true } } } as const;

const signToken = (user: User) =>
    jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "1d" }); // Token is valid for 1 day

// Compared against when the email doesn't exist, so a login takes the same time either way
// and response timing can't reveal which emails are registered
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 10);

const checkCredentials = async (body: unknown) => {
    const { email, password } = loginSchema.parse(body ?? {});
    const user = await prisma.user.findUnique({ where: { email }, include: withSeller });
    const isPasswordCorrect = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);
    if (!user || !isPasswordCorrect) {
        throw new HttpError(401, "Invalid email or password.");
    }
    if (user.blockedAt) {
        throw new HttpError(403, "This account has been blocked. Contact support for help.");
    }
    return user;
};

// Shared by public sign-up and admin creation. The role is decided by the route, never by the
// request body, so nobody can make themselves an admin by sending { "role": "ADMIN" }.
const createUser = async (req: AuthenticatedRequest, res: Response, role: "BUYER" | "ADMIN") => {
    const { name, email, password, staffRole } = role === "ADMIN"
        ? adminRegisterSchema.parse(req.body ?? {})
        : { ...registerSchema.parse(req.body ?? {}), staffRole: undefined };

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
        throw new HttpError(400, "Email is already registered.");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await prisma.user.create({
        data: { email, password: hashedPassword, name, role, staffRole: role === "ADMIN" ? staffRole ?? "FULL" : null },
    });

    if (role === "BUYER") queueEmail(welcomeEmail(newUser));
    if (role === "ADMIN") {
        await logActivity(req, {
            action: "admin.added",
            summary: `Added admin ${newUser.name} (${newUser.email}) with ${STAFF_ROLE_LABELS[newUser.staffRole ?? "FULL"]}`,
            targetType: "admin",
            targetId: newUser.id,
        });
    }

    res.status(201).json({
        status: "success",
        message: role === "ADMIN" ? "Admin registered successfully" : "User registered successfully",
        data: publicUser(newUser),
    });
};

// Public sign-up: always creates a BUYER
export const register = (req: AuthenticatedRequest, res: Response) => createUser(req, res, "BUYER");

// Admin-only (see authRoutes): lets a logged-in admin create another admin
export const registerAdmin = (req: AuthenticatedRequest, res: Response) => createUser(req, res, "ADMIN");

export const login = async (req: Request, res: Response) => {
    const user = await checkCredentials(req.body);
    res.status(200).json({
        status: "success",
        message: "Logged in successfully",
        token: signToken(user),
        data: publicUser(user),
    });
};

export const adminLogin = async (req: Request, res: Response) => {
    // Password is checked first, so the "admin only" message can't reveal which emails are registered
    const user = await checkCredentials(req.body);

    // STRICT ADMIN CHECK
    if (user.role !== "ADMIN") {
        throw new HttpError(403, "Forbidden: Admin access only.");
    }

    res.status(200).json({
        status: "success",
        message: "Admin logged in successfully",
        token: signToken(user),
        data: publicUser(user),
    });
};

// GET /auth/me: who is logged in. The frontend calls this on page load to restore the session.
export const getMe = async (req: AuthenticatedRequest, res: Response) => {
    const user = await prisma.user.findUnique({ where: { id: currentUserId(req) }, include: withSeller });
    if (!user) {
        throw new HttpError(401, "This account no longer exists.");
    }
    res.status(200).json({ status: "success", data: publicUser(user) });
};

// PATCH /auth/me { name }
export const updateProfile = async (req: AuthenticatedRequest, res: Response) => {
    const { name } = profileSchema.parse(req.body ?? {});
    const user = await prisma.user.update({ where: { id: currentUserId(req) }, data: { name }, include: withSeller });
    res.status(200).json({ status: "success", message: "Profile updated", data: publicUser(user) });
};

// POST /auth/change-password { currentPassword, newPassword }
export const changePassword = async (req: AuthenticatedRequest, res: Response) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body ?? {});
    const user = await prisma.user.findUniqueOrThrow({ where: { id: currentUserId(req) } });
    if (!(await bcrypt.compare(currentPassword, user.password))) {
        throw HttpError.field("currentPassword", "is incorrect");
    }
    await prisma.user.update({ where: { id: user.id }, data: { password: await bcrypt.hash(newPassword, 10) } });
    res.status(200).json({ status: "success", message: "Password changed" });
};

// Reset tokens are stored hashed: someone reading the database can't use them
const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const RESET_LINK_MINUTES = 30;

// POST /auth/forgot-password { email }: emails a one-time link to choose a new password
export const forgotPassword = async (req: Request, res: Response) => {
    const { email } = forgotPasswordSchema.parse(req.body ?? {});
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
        const token = crypto.randomBytes(32).toString("base64url");
        await prisma.$transaction([
            prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }), // Only the newest link works
            prisma.passwordResetToken.create({
                data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_LINK_MINUTES * 60 * 1000) },
            }),
        ]);
        queueEmail(passwordResetEmail(user, `${CLIENT_URL}/reset-password?token=${token}`));
    }
    // Same answer whether or not the email is registered, so this can't be used to find out who has an account
    res.status(200).json({
        status: "success",
        message: "If an account exists for that email, we've sent a link to reset the password.",
    });
};

// POST /auth/reset-password { token, password }
export const resetPassword = async (req: Request, res: Response) => {
    const { token, password } = resetPasswordSchema.parse(req.body ?? {});
    const invalid = new HttpError(400, "This reset link is invalid or has expired. Please request a new one.");
    const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!record || record.usedAt || record.expiresAt < new Date()) throw invalid;

    const hashed = await bcrypt.hash(password, 10);
    await prisma.$transaction(async (tx) => {
        // Mark the link used in the same step, so it can't be used twice
        const { count } = await tx.passwordResetToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
        if (count === 0) throw invalid;
        await tx.user.update({ where: { id: record.userId }, data: { password: hashed } });
    });
    res.status(200).json({ status: "success", message: "Your password has been changed. You can now log in." });
};
