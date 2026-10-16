import { Router } from "express";
import express from "express";
import { handleStripeWebhook, handleRazorpayWebhook } from "../controllers/webhookController.js";

const router = Router();

// CRITICAL: Stripe requires the raw body (not parsed JSON) to verify the signature!
router.post("/stripe", express.raw({ type: 'application/json' }), handleStripeWebhook);
router.post("/razorpay", express.raw({ type: 'application/json' }), handleRazorpayWebhook);

export default router;
