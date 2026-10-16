import {
    getAllProducts, getProductById, createProduct, updateProduct, deleteProduct, searchProduct,
    getCategories, suggestProducts, getRelatedProducts,
} from "../controllers/productController.js";
import { createOrUpdateReview, getProductReviews } from "../controllers/reviewController.js";
import { Router } from "express";
import { authenticateUser, authorizeRoles, optionalAuth, requirePermission } from "../middlewares/authMiddleware.js";
import { productImages } from "../middlewares/uploadMiddleware.js";

const router = Router();
// Public Routes

router.get("/", getAllProducts); // ?q=&category=&brand=&minPrice=&maxPrice=&minRating=&minDiscount=&inStock=&sort=&page=&limit=
router.get("/search", searchProduct);
router.get("/suggest", suggestProducts); // ?q= (search-as-you-type)
router.get("/categories", getCategories);
router.get("/:id", getProductById);
router.get("/:id/related", getRelatedProducts); // Frequently bought together + similar
router.get("/:id/reviews", optionalAuth as any, getProductReviews as any);
router.post("/:id/reviews", authenticateUser as any, createOrUpdateReview as any); // Verified buyers only

// Protected routes (Admin-only): Shoyo's own products. Sellers manage theirs under /seller/products.
// Note: We cast authenticateUser as any to avoid Express version-specific handler parameter incompatibilities with custom request types.
router.post("/", authenticateUser as any, authorizeRoles("ADMIN") as any, requirePermission("catalog") as any, productImages, createProduct as any);
router.put("/:id", authenticateUser as any, authorizeRoles("ADMIN") as any, requirePermission("catalog") as any, productImages, updateProduct as any); // photos are optional here
router.delete("/:id", authenticateUser as any, authorizeRoles("ADMIN") as any, requirePermission("catalog") as any, deleteProduct as any);
export default router;
