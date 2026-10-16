import type { Request, Response } from "express";
import type { Banner, Prisma, StoreSettings } from "@prisma/client";
import prisma from "../db.js";
import { CURRENCY, PLATFORM_SELLER_NAME, RAZORPAY_ENABLED, STRIPE_ENABLED, SUPPORT_EMAIL, WAREHOUSE_PINCODE } from "../config.js";
import type { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { deleteUploadedImage, discardUpload } from "../middlewares/uploadMiddleware.js";
import { logActivity } from "../services/activityService.js";
import { bannersChanged, bannerStatus, listLiveBanners } from "../services/bannerService.js";
import { getSettings, updateSettings, type SettingsUpdate } from "../services/settingsService.js";
import { HttpError } from "../utils/httpError.js";
import {
    bannerCreateSchema, bannerReorderSchema, bannerUpdateSchema, idParamsSchema, settingsUpdateSchema,
} from "../validation/schemas.js";

// ---------- Store settings ----------

const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 });
const percent = (rate: number) => `${Math.round(rate * 1000) / 10}%`;

// Plain-English list of what changed, for the activity log: "delivery fee ₹40 → ₹50; cash on delivery off"
const describeChanges = (before: StoreSettings, after: StoreSettings) => {
    const changes: string[] = [];
    const value = (label: string, from: string, to: string) => { if (from !== to) changes.push(`${label} ${from} → ${to}`); };
    const toggle = (label: string, from: boolean, to: boolean) => { if (from !== to) changes.push(`${label} ${to ? "on" : "off"}`); };
    value("delivery fee", money.format(before.deliveryFee), money.format(after.deliveryFee));
    value("free delivery from", money.format(before.freeDeliveryThreshold), money.format(after.freeDeliveryThreshold));
    value("return window", `${before.returnWindowDays} days`, `${after.returnWindowDays} days`);
    value("default commission", percent(before.defaultCommissionRate), percent(after.defaultCommissionRate));
    toggle("cash on delivery", before.codEnabled, after.codEnabled);
    toggle("card payments", before.stripeEnabled, after.stripeEnabled);
    toggle("UPI payments", before.razorpayEnabled, after.razorpayEnabled);
    toggle("coupon codes in the offers bar", before.announceCoupons, after.announceCoupons);
    if (before.announcements.join("\n") !== after.announcements.join("\n")) changes.push("offers bar messages");
    return changes;
};

const settingsResponse = (settings: StoreSettings) => ({
    settings,
    // Card and UPI payments can only be switched on when their keys are set on the server
    paymentKeys: { stripe: STRIPE_ENABLED, razorpay: RAZORPAY_ENABLED },
    info: {
        currency: CURRENCY.toUpperCase(),
        platformSellerName: PLATFORM_SELLER_NAME,
        warehousePincode: WAREHOUSE_PINCODE,
        supportEmail: SUPPORT_EMAIL,
    },
});

// GET /admin/settings
export const getStoreSettings = async (req: Request, res: Response) => {
    res.status(200).json({ status: "success", data: settingsResponse(await getSettings()) });
};

// PATCH /admin/settings
export const updateStoreSettings = async (req: AuthenticatedRequest, res: Response) => {
    const input = settingsUpdateSchema.parse(req.body ?? {});
    const changes = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as SettingsUpdate;
    const before = await getSettings();
    const after = await updateSettings(changes);
    const described = describeChanges(before, after);
    if (described.length > 0) {
        await logActivity(req, { action: "settings.updated", summary: `Changed store settings: ${described.join("; ")}`, targetType: "settings" });
    }
    res.status(200).json({ status: "success", message: described.length ? "Settings saved" : "Nothing changed", data: settingsResponse(after) });
};

// ---------- Homepage banners ----------

const withStatus = (banner: Banner) => ({ ...banner, status: bannerStatus(banner) });

// GET /banners: what the storefront's homepage shows
export const getLiveBanners = async (req: Request, res: Response) => {
    res.status(200).json({ status: "success", data: await listLiveBanners() });
};

// GET /admin/banners: every banner, in display order
export const getBannersAdmin = async (req: Request, res: Response) => {
    const banners = await prisma.banner.findMany({ orderBy: [{ position: "asc" }, { id: "asc" }] });
    res.status(200).json({ status: "success", data: banners.map(withStatus) });
};

// POST /admin/banners (form-data with an optional "image" file). New banners go last.
export const createBanner = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const input = bannerCreateSchema.parse(req.body ?? {});
        const image = req.file ? `/uploads/${req.file.filename}` : null;
        if (input.layout === "COVER" && !image) throw HttpError.field("image", "is needed for a full-picture banner");

        const last = await prisma.banner.aggregate({ _max: { position: true } });
        const banner = await prisma.banner.create({
            data: {
                title: input.title,
                ctaLabel: input.ctaLabel,
                ctaLink: input.ctaLink,
                eyebrow: input.eyebrow || null,
                subtitle: input.subtitle || null,
                theme: input.theme ?? "EMERALD",
                layout: input.layout ?? "SPLIT",
                active: input.active ?? true,
                startsAt: input.startsAt ?? null,
                endsAt: input.endsAt ?? null,
                image,
                position: (last._max.position ?? 0) + 1,
            },
        });
        await bannersChanged();
        await logActivity(req, { action: "banner.created", summary: `Added homepage banner "${banner.title}"`, targetType: "banner", targetId: banner.id });
        res.status(201).json({ status: "success", message: "Banner added", data: withStatus(banner) });
    } catch (error) {
        discardUpload(req);
        throw error;
    }
};

// PUT /admin/banners/:id (form-data; a new "image" replaces the old one, removeImage=true drops it)
export const updateBanner = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { id } = idParamsSchema.parse(req.params);
        const input = bannerUpdateSchema.parse(req.body ?? {});
        const existing = await prisma.banner.findUnique({ where: { id } });
        if (!existing) throw new HttpError(404, "Banner not found");

        const image = req.file ? `/uploads/${req.file.filename}` : input.removeImage ? null : existing.image;
        if ((input.layout ?? existing.layout) === "COVER" && !image) {
            throw HttpError.field("image", "is needed for a full-picture banner");
        }
        const startsAt = input.startsAt !== undefined ? input.startsAt : existing.startsAt;
        const endsAt = input.endsAt !== undefined ? input.endsAt : existing.endsAt;
        if (startsAt && endsAt && endsAt <= startsAt) throw HttpError.field("endsAt", "must be after the start date");

        const data: Prisma.BannerUpdateInput = { image, startsAt, endsAt };
        if (input.title !== undefined) data.title = input.title;
        if (input.ctaLabel !== undefined) data.ctaLabel = input.ctaLabel;
        if (input.ctaLink !== undefined) data.ctaLink = input.ctaLink;
        if (input.eyebrow !== undefined) data.eyebrow = input.eyebrow || null;
        if (input.subtitle !== undefined) data.subtitle = input.subtitle || null;
        if (input.theme !== undefined) data.theme = input.theme;
        if (input.layout !== undefined) data.layout = input.layout;
        if (input.active !== undefined) data.active = input.active;

        const banner = await prisma.banner.update({ where: { id }, data });
        if (existing.image && existing.image !== image) deleteUploadedImage(existing.image);
        await bannersChanged();

        const onlyToggled = Object.keys(input).length === 1 && input.active !== undefined && !req.file;
        await logActivity(req, {
            action: onlyToggled ? (banner.active ? "banner.shown" : "banner.hidden") : "banner.updated",
            summary: onlyToggled
                ? `${banner.active ? "Showed" : "Hid"} homepage banner "${banner.title}"`
                : `Edited homepage banner "${banner.title}"`,
            targetType: "banner",
            targetId: banner.id,
        });
        res.status(200).json({ status: "success", message: "Banner saved", data: withStatus(banner) });
    } catch (error) {
        discardUpload(req);
        throw error;
    }
};

// DELETE /admin/banners/:id
export const deleteBanner = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const banner = await prisma.banner.findUnique({ where: { id } });
    if (!banner) throw new HttpError(404, "Banner not found");
    await prisma.banner.delete({ where: { id } });
    if (banner.image) deleteUploadedImage(banner.image);
    await bannersChanged();
    await logActivity(req, { action: "banner.deleted", summary: `Deleted homepage banner "${banner.title}"`, targetType: "banner", targetId: id });
    res.status(200).json({ status: "success", message: "Banner deleted" });
};

// PATCH /admin/banners/reorder { ids: [3, 1, 2] }: the order shoppers see them in
export const reorderBanners = async (req: AuthenticatedRequest, res: Response) => {
    const { ids } = bannerReorderSchema.parse(req.body ?? {});
    if (new Set(ids).size !== ids.length) throw HttpError.field("ids", "contains the same banner twice");
    const found = await prisma.banner.count({ where: { id: { in: ids } } });
    if (found !== ids.length) throw new HttpError(404, "Some of these banners no longer exist. Refresh and try again.");

    await prisma.$transaction(ids.map((id, index) => prisma.banner.update({ where: { id }, data: { position: index + 1 } })));
    await bannersChanged();
    await logActivity(req, { action: "banner.reordered", summary: "Changed the order of the homepage banners", targetType: "banner" });
    const banners = await prisma.banner.findMany({ orderBy: [{ position: "asc" }, { id: "asc" }] });
    res.status(200).json({ status: "success", message: "Banner order saved", data: banners.map(withStatus) });
};
