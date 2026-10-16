import { Prisma, type StoreSettings } from "@prisma/client";
import prisma from "../db.js";
import {
    DEFAULT_COMMISSION_RATE, DELIVERY_FEE, FREE_DELIVERY_THRESHOLD, RAZORPAY_ENABLED, RETURN_WINDOW_DAYS, STRIPE_ENABLED,
} from "../config.js";
import { HttpError } from "../utils/httpError.js";
import { availableCoupons } from "./couponService.js";

// The store's rules (delivery fee, return window, commission, payment options, offers bar), edited in the
// admin panel. The first time they're needed they're created from the values in .env.

const CACHE_MS = 30_000; // Read on every cart and order, so kept in memory briefly; edits update it at once

// {freeDeliveryThreshold} and {returnWindowDays} are filled in with the current values when shown
export const DEFAULT_ANNOUNCEMENTS = [
    "Free delivery on orders over {freeDeliveryThreshold}",
    "{returnWindowDays}-day easy returns",
    "Sell on Shoyo: open your store in minutes",
];

let cached: { settings: StoreSettings; at: number } | null = null;
let loading: Promise<StoreSettings> | null = null;

const loadSettings = async () => {
    let settings = await prisma.storeSettings.findUnique({ where: { id: 1 } });
    if (!settings) {
        try {
            settings = await prisma.storeSettings.create({
                data: {
                    id: 1,
                    deliveryFee: DELIVERY_FEE,
                    freeDeliveryThreshold: FREE_DELIVERY_THRESHOLD,
                    returnWindowDays: RETURN_WINDOW_DAYS,
                    defaultCommissionRate: DEFAULT_COMMISSION_RATE,
                    announcements: DEFAULT_ANNOUNCEMENTS,
                },
            });
        } catch (error) {
            // Another server created the row at the same moment: use theirs
            if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
            settings = await prisma.storeSettings.findUniqueOrThrow({ where: { id: 1 } });
        }
    }
    cached = { settings, at: Date.now() };
    return settings;
};

export const getSettings = async (): Promise<StoreSettings> => {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.settings;
    // Requests arriving together share one database read
    loading ??= loadSettings().finally(() => { loading = null; });
    return loading;
};

// For tests, which empty the tables between runs
export const clearSettingsCache = () => { cached = null; };

// Which ways to pay are actually on: card and UPI also need their keys on the server
export const paymentOptions = (settings: StoreSettings) => ({
    stripe: STRIPE_ENABLED && settings.stripeEnabled,
    razorpay: RAZORPAY_ENABLED && settings.razorpayEnabled,
    cod: settings.codEnabled,
});

export type SettingsUpdate = Partial<Pick<StoreSettings,
    "deliveryFee" | "freeDeliveryThreshold" | "returnWindowDays" | "defaultCommissionRate" |
    "codEnabled" | "stripeEnabled" | "razorpayEnabled" | "announcements" | "announceCoupons">>;

export const updateSettings = async (input: SettingsUpdate) => {
    const current = await getSettings();
    const options = paymentOptions({ ...current, ...input });
    if (!options.cod && !options.stripe && !options.razorpay) {
        throw new HttpError(400, "Keep at least one way to pay switched on, or shoppers can't place orders.");
    }
    const settings = await prisma.storeSettings.update({ where: { id: 1 }, data: input });
    cached = { settings, at: Date.now() };
    return settings;
};

const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 });

// The offers bar lines with their placeholders filled in, plus active coupon codes when switched on
export const announcementLines = async (settings: StoreSettings) => {
    const lines = settings.announcements.map(line => line
        .replaceAll("{freeDeliveryThreshold}", money.format(settings.freeDeliveryThreshold))
        .replaceAll("{deliveryFee}", money.format(settings.deliveryFee))
        .replaceAll("{returnWindowDays}", String(settings.returnWindowDays)));
    if (settings.announceCoupons) {
        const coupons = await availableCoupons();
        lines.splice(1, 0, ...coupons.slice(0, 2).map(c => `Use code ${c.code}: ${c.description}`));
    }
    return lines;
};
