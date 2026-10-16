import { Router } from "express";
import { getCart, addCartItem, setCartItemQuantity, saveForLater, removeCartItem, clearCart, mergeCart } from "../controllers/cartController.js";
import { authenticateUser } from "../middlewares/authMiddleware.js";

const router = Router();

// Every cart route needs a logged-in user
router.use(authenticateUser as any);

router.get("/", getCart as any);                                 // GET    /api/v1/cart
router.post("/items", addCartItem as any);                       // POST   /api/v1/cart/items { productId, quantity }
router.put("/items/:productId", setCartItemQuantity as any);     // PUT    /api/v1/cart/items/:productId { quantity }
router.patch("/items/:productId/save-for-later", saveForLater as any); // PATCH /api/v1/cart/items/:productId/save-for-later { saved }
router.delete("/items/:productId", removeCartItem as any);       // DELETE /api/v1/cart/items/:productId
router.delete("/", clearCart as any);                            // DELETE /api/v1/cart
router.post("/merge", mergeCart as any);                         // POST   /api/v1/cart/merge { items } (guest cart after login)

export default router;
