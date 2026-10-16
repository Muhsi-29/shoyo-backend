import { Router } from "express";
import {
    getStats, getAllProductsAdmin, moderateProduct, getSellers, updateSeller, createPayout,
    getReturns, resolveReturnAdmin, getCoupons, createCoupon, updateCoupon, deleteCoupon,
    getOrdersAdmin, exportOrdersCsv, getOrderSellerOptions, getCustomers, getReviewsAdmin, getMessages, getSubscribers,
} from "../controllers/adminController.js";
import {
    getActivity, getAdmins, getCustomerDetail, removeAdmin, updateAdmin, updateCustomer,
} from "../controllers/peopleAdminController.js";
import {
    createBanner, deleteBanner, getBannersAdmin, getStoreSettings, reorderBanners, updateBanner, updateStoreSettings,
} from "../controllers/storeAdminController.js";
import { authenticateUser, authorizeRoles, requirePermission } from "../middlewares/authMiddleware.js";
import { bannerImage } from "../middlewares/uploadMiddleware.js";

const router = Router();

// Every route needs an admin; each one also needs a permission that the admin's role must include (see permissions.ts)
router.use(authenticateUser as any, authorizeRoles("ADMIN") as any);
const can = requirePermission as (...args: Parameters<typeof requirePermission>) => any;

router.get("/stats", can("dashboard"), getStats);                              // Dashboard numbers and charts

router.get("/orders", can("orders"), getOrdersAdmin);                          // ?status=&q=&paymentMethod=&seller=&from=&to=&page=
router.get("/orders/export", can("orders"), exportOrdersCsv);                  // Same filters, as a CSV file
router.get("/orders/sellers", can("orders"), getOrderSellerOptions);           // Stores, for the seller filter

router.get("/customers", can("customers"), getCustomers);                      // ?q=&page=
router.get("/customers/:id", can("customers"), getCustomerDetail);
router.patch("/customers/:id", can("customers"), updateCustomer as any);       // { blocked, reason }

router.get("/admins", can("admins"), getAdmins);                               // Adding admins: POST /auth/admin/register
router.patch("/admins/:id", can("admins"), updateAdmin as any);                // { staffRole }
router.delete("/admins/:id", can("admins"), removeAdmin as any);               // Takes away admin access

router.get("/reviews", can("reviews"), getReviewsAdmin);                       // ?rating=&page=
router.get("/messages", can("messages"), getMessages);                         // ?page=
router.get("/subscribers", can("messages"), getSubscribers);

router.get("/products", can("catalog"), getAllProductsAdmin);                  // ?status=PENDING
router.patch("/products/:id/status", can("catalog"), moderateProduct as any);  // Approve or reject a listing

router.get("/sellers", can("sellers"), getSellers);                            // ?status=PENDING
router.patch("/sellers/:id", can("sellers"), updateSeller as any);             // Approve, suspend, commission
router.post("/sellers/:id/payouts", can("payouts"), createPayout as any);

router.get("/returns", can("returns"), getReturns);
router.patch("/returns/:id", can("returns"), resolveReturnAdmin as any);

router.get("/coupons", can("coupons"), getCoupons);
router.post("/coupons", can("coupons"), createCoupon as any);
router.patch("/coupons/:id", can("coupons"), updateCoupon as any);
router.delete("/coupons/:id", can("coupons"), deleteCoupon as any);

router.get("/settings", can("settings"), getStoreSettings);                    // Store rules and offers bar
router.patch("/settings", can("settings"), updateStoreSettings as any);

router.get("/banners", can("homepage"), getBannersAdmin);                      // Homepage banners
router.post("/banners", can("homepage"), bannerImage, createBanner as any);    // form-data, optional "image"
router.patch("/banners/reorder", can("homepage"), reorderBanners as any);      // { ids: [...] }
router.put("/banners/:id", can("homepage"), bannerImage, updateBanner as any);
router.delete("/banners/:id", can("homepage"), deleteBanner as any);

router.get("/activity", can("activity"), getActivity);                         // ?adminId=&area=&q=&page=

export default router;
