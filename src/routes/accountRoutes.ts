import { Router } from "express";
import { authenticateUser, optionalAuth } from "../middlewares/authMiddleware.js";
import { getWishlist, addToWishlist, removeFromWishlist } from "../controllers/wishlistController.js";
import { getAddresses, createAddress, updateAddress, setDefaultAddress, deleteAddress } from "../controllers/addressController.js";
import { getAvailableCoupons, validateCoupon } from "../controllers/couponController.js";
import { removeReview, markReviewHelpful } from "../controllers/reviewController.js";
import { updateShipment, rateSeller } from "../controllers/shipmentController.js";

// Shopper features that don't belong to one bigger area: wishlist, saved addresses, coupons, reviews, shipments
const router = Router();

router.get("/wishlist", authenticateUser as any, getWishlist as any);                          // GET    /api/v1/wishlist
router.post("/wishlist", authenticateUser as any, addToWishlist as any);                       // POST   /api/v1/wishlist { productId }
router.delete("/wishlist/:productId", authenticateUser as any, removeFromWishlist as any);     // DELETE /api/v1/wishlist/:productId

router.get("/addresses", authenticateUser as any, getAddresses as any);                        // GET    /api/v1/addresses
router.post("/addresses", authenticateUser as any, createAddress as any);                      // POST   /api/v1/addresses
router.put("/addresses/:id", authenticateUser as any, updateAddress as any);                   // PUT    /api/v1/addresses/:id
router.patch("/addresses/:id/default", authenticateUser as any, setDefaultAddress as any);     // PATCH  /api/v1/addresses/:id/default
router.delete("/addresses/:id", authenticateUser as any, deleteAddress as any);                // DELETE /api/v1/addresses/:id

router.get("/coupons", optionalAuth as any, getAvailableCoupons as any);                       // GET    /api/v1/coupons
router.post("/coupons/validate", authenticateUser as any, validateCoupon as any);              // POST   /api/v1/coupons/validate { code }

router.delete("/reviews/:id", authenticateUser as any, removeReview as any);                   // DELETE /api/v1/reviews/:id
router.post("/reviews/:id/helpful", authenticateUser as any, markReviewHelpful as any);        // POST   /api/v1/reviews/:id/helpful

router.patch("/shipments/:id", authenticateUser as any, updateShipment as any);                // PATCH  /api/v1/shipments/:id (seller or admin)
router.post("/shipments/:id/rating", authenticateUser as any, rateSeller as any);              // POST   /api/v1/shipments/:id/rating (customer)

export default router;
