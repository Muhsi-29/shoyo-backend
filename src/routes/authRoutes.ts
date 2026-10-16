import { Router } from "express";
import {
    register, login, adminLogin, registerAdmin, getMe, updateProfile, changePassword, forgotPassword, resetPassword,
} from "../controllers/authController.js";
import { authenticateUser, authorizeRoles, requirePermission } from "../middlewares/authMiddleware.js";
import { loginLimiter, registerLimiter } from "../middlewares/rateLimiters.js";

const router = Router();

router.post("/register", registerLimiter, register); // Public sign-up: always creates a BUYER
router.post("/login", loginLimiter, login);
router.post("/admin/login", loginLimiter, adminLogin);
router.post("/admin/register", authenticateUser as any, authorizeRoles("ADMIN") as any, requirePermission("admins") as any, registerAdmin as any); // Only an admin with full access can add admins
router.get("/me", authenticateUser as any, getMe as any); // GET /api/v1/auth/me -> the logged-in user
router.patch("/me", authenticateUser as any, updateProfile as any); // PATCH /api/v1/auth/me { name }
router.post("/change-password", authenticateUser as any, changePassword as any);
router.post("/forgot-password", registerLimiter, forgotPassword); // Emails a reset link (rate limited against spam)
router.post("/reset-password", resetPassword);

export default router;
