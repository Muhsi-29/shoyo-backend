import { Router } from "express";
import {
    createOrder, getUserOrders, getOrderById, getAllOrders, createCheckoutSession, confirmCheckout,
    createRazorpayOrder, verifyRazorpayCheckout, cancelOrder, createReturnRequest,
} from "../controllers/orderController.js";
import { authenticateUser, authorizeRoles, requirePermission } from "../middlewares/authMiddleware.js";

const router = Router();

// Apply auth check to all routes below this line
router.use(authenticateUser as any);

router.post("/", createOrder as any); // POST /api/v1/orders -> Place a cash-on-delivery order
router.get("/", getUserOrders as any); // GET /api/v1/orders -> Get user order history
router.get("/all", authorizeRoles("ADMIN") as any, requirePermission("orders") as any, getAllOrders as any); // GET /api/v1/orders/all -> Admin view all orders
router.post("/checkout", createCheckoutSession as any); // POST /api/v1/orders/checkout -> Start a Stripe card payment
router.post("/checkout/confirm", confirmCheckout as any); // POST /api/v1/orders/checkout/confirm -> Check a Stripe payment
router.post("/razorpay", createRazorpayOrder as any); // POST /api/v1/orders/razorpay -> Start a Razorpay payment (UPI etc.)
router.post("/razorpay/verify", verifyRazorpayCheckout as any); // POST /api/v1/orders/razorpay/verify -> Confirm it
router.post("/items/:id/return", createReturnRequest as any); // POST /api/v1/orders/items/:id/return -> Return a delivered item
router.get("/:id", getOrderById as any); // GET /api/v1/orders/:id -> View details of a specific order
router.patch("/:id/cancel", cancelOrder as any); // PATCH /api/v1/orders/:id/cancel -> Shopper cancels (refunded if paid)

export default router;
