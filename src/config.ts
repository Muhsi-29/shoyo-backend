// Load .env before anything reads process.env. Every module that needs config imports it from here,
// so the values are always loaded no matter which file happens to be imported first.
import "dotenv/config";

const requireEnv = (name: string): string => {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name} (set it in backend/.env)`);
    }
    return value;
};

const numberEnv = (name: string, fallback: number): number => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && process.env[name] !== "" ? value : fallback;
};

export const NODE_ENV = process.env.NODE_ENV || "development";
export const PORT = Number(process.env.PORT) || 8000;

// All API routes live under this prefix. A future breaking change can ship as /api/v2 while v1 keeps working.
export const API_PREFIX = "/api/v1";

// No fallback: a guessable default secret would let anyone forge login tokens
export const JWT_SECRET = requireEnv("JWT_SECRET");

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
// Card payments are offered only with a real-looking key (a placeholder like "sk_test_..." hides the option)
export const STRIPE_ENABLED = /^sk_(test|live)_[0-9A-Za-z]{20,}$/.test(STRIPE_SECRET_KEY);

// Razorpay (UPI, cards, net banking): keys from https://dashboard.razorpay.com/app/keys
export const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
export const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
export const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";
export const RAZORPAY_ENABLED = /^rzp_(test|live)_[0-9A-Za-z]+$/.test(RAZORPAY_KEY_ID) && RAZORPAY_KEY_SECRET.length > 0;

// Product prices are stored in rupees, so Stripe must charge in INR unless told otherwise
export const CURRENCY = (process.env.CURRENCY || "inr").toLowerCase();

// The shopping website (Stripe sends shoppers back here after checkout; customer emails link here)
export const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

// The admin panel website (admin emails link here)
export const ADMIN_URL = process.env.ADMIN_URL || "http://localhost:5174";

// Browser origins allowed to call the API (comma-separated). Defaults to both websites.
export const CORS_ORIGINS = (process.env.CORS_ORIGINS || `${CLIENT_URL},${ADMIN_URL}`).split(",").map(origin => origin.trim()).filter(Boolean);

// Public URL of this backend, used to turn "/uploads/..." image paths into absolute URLs for Stripe.
// Leave empty in local development: Stripe can't reach localhost anyway.
export const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || "";

// Set to true when running behind a proxy/load balancer (Render, Railway, Nginx) so the real client IP
// is used for rate limiting instead of the proxy's IP
export const TRUST_PROXY = process.env.TRUST_PROXY === "true";

export const LOG_LEVEL = process.env.LOG_LEVEL || (NODE_ENV === "test" ? "silent" : "info");

// Optional Redis for caching. Without it, a small in-memory cache is used instead.
export const REDIS_URL = process.env.REDIS_URL || "";
export const CACHE_TTL_SECONDS = numberEnv("CACHE_TTL_SECONDS", 60);

// Requests allowed per IP in a 15-minute window
export const API_RATE_LIMIT = numberEnv("API_RATE_LIMIT", 1000); // Shared by the storefront and admin panel
export const LOGIN_RATE_LIMIT = numberEnv("LOGIN_RATE_LIMIT", 10); // Failed logins only
export const REGISTER_RATE_LIMIT = numberEnv("REGISTER_RATE_LIMIT", 20);

// Email. Without SMTP_HOST, emails are saved as .html files in backend/outbox/ instead of being sent.
export const SMTP_HOST = process.env.SMTP_HOST || "";
export const SMTP_PORT = numberEnv("SMTP_PORT", 587);
export const SMTP_SECURE = process.env.SMTP_SECURE === "true"; // true for port 465
export const SMTP_USER = process.env.SMTP_USER || "";
export const SMTP_PASS = process.env.SMTP_PASS || "";
export const EMAIL_FROM = process.env.EMAIL_FROM || "Shoyo <no-reply@shoyo.test>";

// First admin account. Created when the server starts (and by the seed) if both are set,
// because public sign-up only ever creates buyers.
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
export const ADMIN_NAME = process.env.ADMIN_NAME || "Admin";

// Optional demo shopper account, created by `npx prisma db seed`
export const DEMO_BUYER_EMAIL = (process.env.DEMO_BUYER_EMAIL || "").trim().toLowerCase();
export const DEMO_BUYER_PASSWORD = process.env.DEMO_BUYER_PASSWORD || "";
export const DEMO_BUYER_NAME = process.env.DEMO_BUYER_NAME || "Demo Buyer";

// Optional demo seller account (with its own store), created by `npx prisma db seed`
export const DEMO_SELLER_EMAIL = (process.env.DEMO_SELLER_EMAIL || "").trim().toLowerCase();
export const DEMO_SELLER_PASSWORD = process.env.DEMO_SELLER_PASSWORD || "";
export const DEMO_SELLER_NAME = process.env.DEMO_SELLER_NAME || "Demo Seller";

// ---------- Store rules ----------

// Orders below FREE_DELIVERY_THRESHOLD (items total, in rupees) pay DELIVERY_FEE
export const DELIVERY_FEE = numberEnv("DELIVERY_FEE", 40);
export const FREE_DELIVERY_THRESHOLD = numberEnv("FREE_DELIVERY_THRESHOLD", 499);
// Days after delivery during which an item can be returned
export const RETURN_WINDOW_DAYS = numberEnv("RETURN_WINDOW_DAYS", 7);
// Share of each sale the platform keeps from sellers (0.1 = 10%); can be changed per seller
export const DEFAULT_COMMISSION_RATE = numberEnv("DEFAULT_COMMISSION_RATE", 0.1);
// Shown as the seller of products that belong to the store itself
export const PLATFORM_SELLER_NAME = process.env.PLATFORM_SELLER_NAME || "Shoyo Retail";
// Where the store's own products ship from (used for delivery estimates)
export const WAREHOUSE_PINCODE = process.env.WAREHOUSE_PINCODE || "560001";
// Receives contact-form messages and new-seller notifications
export const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || ADMIN_EMAIL || "support@shoyo.test";
