import { rateLimit } from "express-rate-limit";
import { API_RATE_LIMIT, LOGIN_RATE_LIMIT, REGISTER_RATE_LIMIT } from "../config.js";

// Limits how many requests one IP address can make, to slow down password guessing,
// fake sign-ups and scripts hammering the API. Over the limit, the API answers 429 Too Many Requests.

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

const tooMany = (message: string) => ({ status: "error", message });

// Every API route
export const apiLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: API_RATE_LIMIT,
    standardHeaders: "draft-8", // Tells clients their remaining quota in RateLimit-* headers
    legacyHeaders: false,
    message: tooMany("Too many requests. Please try again in a few minutes."),
});

// Login: only failed attempts count, so normal users are never blocked but guessing passwords is
export const loginLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: LOGIN_RATE_LIMIT,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: tooMany("Too many failed login attempts. Please try again in 15 minutes."),
});

export const registerLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: REGISTER_RATE_LIMIT,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: tooMany("Too many accounts created from this network. Please try again later."),
});
