import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL } from "./tests/testDatabaseUrl.js";

export default defineConfig({
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        globalSetup: ["./tests/globalSetup.ts"],
        fileParallelism: false, // Test files share one database, so run them one after another
        testTimeout: 20_000,
        hookTimeout: 60_000,
        env: {
            NODE_ENV: "test",
            DATABASE_URL: TEST_DATABASE_URL,
            JWT_SECRET: "test-jwt-secret",
            // Fake but well-formed keys, so both gateways count as set up (their APIs are mocked in tests)
            STRIPE_SECRET_KEY: "sk_test_FakeKeyForTests0123456789",
            STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
            RAZORPAY_KEY_ID: "rzp_test_FakeKeyForTests",
            RAZORPAY_KEY_SECRET: "razorpay_test_secret",
            RAZORPAY_WEBHOOK_SECRET: "razorpay_webhook_secret",
            // Fixed values, so settings in backend/.env can't change test results
            CLIENT_URL: "http://localhost:5173",
            ADMIN_URL: "http://localhost:5174",
            CORS_ORIGINS: "",
            CURRENCY: "inr",
            PUBLIC_BACKEND_URL: "",
            TRUST_PROXY: "false",
            LOG_LEVEL: "silent",
            CACHE_TTL_SECONDS: "60",
            ADMIN_EMAIL: "",
            ADMIN_PASSWORD: "",
            DEMO_BUYER_EMAIL: "",
            DEMO_SELLER_EMAIL: "",
            DELIVERY_FEE: "40",
            FREE_DELIVERY_THRESHOLD: "499",
            RETURN_WINDOW_DAYS: "7",
            DEFAULT_COMMISSION_RATE: "0.1",
            WAREHOUSE_PINCODE: "560001",
            SUPPORT_EMAIL: "support@example.com",
            REDIS_URL: "",  // In-memory cache
            SMTP_HOST: "",  // Emails are collected in testOutbox instead of being sent
            // High limits so tests never trip them; rateLimit.test.ts lowers them for itself
            API_RATE_LIMIT: "100000",
            LOGIN_RATE_LIMIT: "100000",
            REGISTER_RATE_LIMIT: "100000",
        },
    },
});
