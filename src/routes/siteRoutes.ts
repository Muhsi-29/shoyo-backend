import { Router } from "express";
import { getConfig, estimateDelivery, subscribeNewsletter, sendContactMessage } from "../controllers/siteController.js";
import { getLiveBanners } from "../controllers/storeAdminController.js";
import { registerLimiter } from "../middlewares/rateLimiters.js";

// Public site features, mounted at /api/v1
const router = Router();

router.get("/config", getConfig);                                       // GET  /api/v1/config
router.get("/banners", getLiveBanners);                                 // GET  /api/v1/banners (homepage slides)
router.get("/delivery/estimate", estimateDelivery);                     // GET  /api/v1/delivery/estimate?pincode=&productId=
router.post("/newsletter", registerLimiter, subscribeNewsletter);       // POST /api/v1/newsletter { email }
router.post("/contact", registerLimiter, sendContactMessage);           // POST /api/v1/contact { name, email, subject, message }

export default router;
