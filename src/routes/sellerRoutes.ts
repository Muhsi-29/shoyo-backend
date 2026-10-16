import { Router } from "express";
import {
    applyToSell, getStorePage, getMyStore, updateMyStore, getMyProducts, createMyProduct, updateMyProduct,
    deleteMyProduct, getMyShipments, getMyReturns, resolveMyReturn, getMyPayouts,
} from "../controllers/sellerController.js";
import { authenticateUser, loadSeller, requireApprovedSeller } from "../middlewares/authMiddleware.js";
import { productImages } from "../middlewares/uploadMiddleware.js";

// Public seller routes, mounted at /api/v1/sellers
export const sellersRouter = Router();
sellersRouter.post("/apply", authenticateUser as any, applyToSell as any);    // POST /api/v1/sellers/apply
sellersRouter.get("/:slug", getStorePage as any);                             // GET  /api/v1/sellers/:slug (store page)

// The seller dashboard, mounted at /api/v1/seller. Every route needs a store; changes need an approved one.
export const sellerDashboardRouter = Router();
sellerDashboardRouter.use(authenticateUser as any, loadSeller as any);
const approved = requireApprovedSeller as any;

sellerDashboardRouter.get("/me", getMyStore as any);
sellerDashboardRouter.patch("/me", updateMyStore as any);
sellerDashboardRouter.get("/products", getMyProducts as any);
sellerDashboardRouter.post("/products", approved, productImages, createMyProduct as any);
sellerDashboardRouter.put("/products/:id", approved, productImages, updateMyProduct as any);
sellerDashboardRouter.delete("/products/:id", approved, deleteMyProduct as any);
sellerDashboardRouter.get("/shipments", getMyShipments as any);  // Shipping itself: PATCH /api/v1/shipments/:id
sellerDashboardRouter.get("/returns", getMyReturns as any);
sellerDashboardRouter.patch("/returns/:id", approved, resolveMyReturn as any);
sellerDashboardRouter.get("/payouts", getMyPayouts as any);
