import { API_PREFIX, CORS_ORIGINS, TRUST_PROXY } from "./config.js"; // Must stay the first import: it loads .env before other modules read it
import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import { pinoHttp } from "pino-http";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "./db.js";
import logger from "./logger.js";
import authRoutes from "./routes/authRoutes.js";
import productRoutes from "./routes/productRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import cartRoutes from "./routes/cartRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import accountRoutes from "./routes/accountRoutes.js";
import siteRoutes from "./routes/siteRoutes.js";
import { sellersRouter, sellerDashboardRouter } from "./routes/sellerRoutes.js";
import webhookRoutes from "./routes/webhookRoutes.js";
import { apiLimiter } from "./middlewares/rateLimiters.js";
import { UPLOAD_DIR } from "./middlewares/uploadMiddleware.js";
import { HttpError } from "./utils/httpError.js";

// The Express app, without starting a server: server.ts listens on a port, and tests use the app directly

const app = express();

// Behind a proxy (Render, Railway, Nginx), trust its X-Forwarded-For header so rate limits see real client IPs
if (TRUST_PROXY) app.set("trust proxy", 1);

// Security headers. Images are loaded by the frontend from another origin, so allow cross-origin reads.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

// One log line per request (method, URL, status, time taken). Headers aren't logged, so tokens never end up in logs.
app.use(pinoHttp({
    logger,
    customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
    serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
    },
    autoLogging: { ignore: (req) => req.url === `${API_PREFIX}/health` },
}));

// Only our own frontend may call the API from a browser
app.use(cors({ origin: CORS_ORIGINS }));

// Stripe webhooks need the raw request body, so they're mounted before express.json() (and aren't rate limited)
app.use(`${API_PREFIX}/webhook`, webhookRoutes);
app.use(express.json({ limit: "100kb" }));

app.get("/", (req, res) => {
    res.status(200).json({
        status: 'success',
        message: "Server is Running"
    })
});

// Used by Docker and hosting platforms to check the server and its database are up
app.get(`${API_PREFIX}/health`, async (req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        res.status(200).json({ status: 'success', database: 'up' });
    } catch {
        res.status(503).json({ status: 'error', database: 'down' });
    }
});

app.use(API_PREFIX, apiLimiter);
app.use(`${API_PREFIX}/auth`, authRoutes);
app.use(`${API_PREFIX}/products`, productRoutes);
app.use(`${API_PREFIX}/cart`, cartRoutes);
app.use(`${API_PREFIX}/orders`, orderRoutes);
app.use(`${API_PREFIX}/admin`, adminRoutes);
app.use(`${API_PREFIX}/sellers`, sellersRouter);
app.use(`${API_PREFIX}/seller`, sellerDashboardRouter);
app.use(API_PREFIX, accountRoutes); // /wishlist, /addresses, /coupons, /reviews, /shipments
app.use(API_PREFIX, siteRoutes);    // /config, /delivery/estimate, /newsletter, /contact

// Route to serve static files (like uploaded images).
// nosniff stops browsers from guessing a file is HTML and running it.
app.use("/uploads", express.static(UPLOAD_DIR, {
    setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff")
}));

// Unknown routes get a JSON 404 instead of Express's default HTML page
app.use((req, res) => {
    res.status(404).json({
        status: 'error',
        message: `Route ${req.method} ${req.originalUrl} not found`
    });
});

// Central error handler: every error thrown in a route ends up here (Express 5 forwards async errors too).
// Always answers with JSON and never sends stack traces or server file paths to the client.
const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
    // Invalid input: list every bad field, e.g. "email: must be a valid email address"
    if (err instanceof ZodError) {
        const errors = err.issues.map(issue => ({ field: issue.path.join(".") || "body", message: issue.message }));
        return res.status(400).json({
            status: 'error',
            message: errors.map(e => `${e.field}: ${e.message}`).join("; "),
            errors,
        });
    }
    // Our own errors carry a status and a message written for the client (e.g. 404, 409, 502)
    if (err instanceof HttpError) {
        return res.status(err.statusCode).json({ status: 'error', message: err.message, ...(err.errors ? { errors: err.errors } : {}) });
    }
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ status: 'error', message: err.message });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === "P2002") return res.status(409).json({ status: 'error', message: 'That record already exists.' });
        if (err.code === "P2025") return res.status(404).json({ status: 'error', message: 'Record not found.' });
    }
    // Body-parser errors (e.g. malformed JSON) carry a safe 4xx status and message
    const status = err.statusCode ?? err.status;
    if (status >= 400 && status < 500) {
        return res.status(status).json({ status: 'error', message: err.message });
    }
    req.log.error({ err }, "Unhandled error");
    res.status(500).json({ status: 'error', message: 'Internal server error' });
};
app.use(errorHandler);

export default app;
