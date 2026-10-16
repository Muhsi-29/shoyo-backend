import type { Banner, Prisma } from "@prisma/client";
import prisma from "../db.js";
import { cachedProducts, invalidateProductCache } from "../cache.js";
import { visibleProductWhere } from "./productService.js";

export type BannerStatus = "LIVE" | "SCHEDULED" | "ENDED" | "HIDDEN";

// Whether shoppers see a banner right now
export const bannerStatus = (banner: Pick<Banner, "active" | "startsAt" | "endsAt">, now = new Date()): BannerStatus => {
    if (!banner.active) return "HIDDEN";
    if (banner.startsAt && banner.startsAt > now) return "SCHEDULED";
    if (banner.endsAt && banner.endsAt <= now) return "ENDED";
    return "LIVE";
};

// A banner without its own picture shows popular products from the page its button opens: a category,
// brand, search, today's deals, a seller's store, or (for "Sell on Shoyo") sellers' products
const productsForLink = async (link: string, exclude: number[]) => {
    const where: Prisma.ProductWhereInput[] = [visibleProductWhere, { stock: { gt: 0 } }, { image: { not: "" } }, { id: { notIn: exclude } }];
    let orderBy: Prisma.ProductOrderByWithRelationInput[] = [{ soldCount: "desc" }, { ratingAvg: "desc" }, { id: "asc" }];

    if (link.startsWith("/")) {
        const url = new URL(link, "https://store.invalid");
        const params = url.searchParams;
        if (url.pathname === "/products") {
            const category = params.get("category");
            const brands = params.get("brand")?.split(",").map(b => b.trim()).filter(Boolean) ?? [];
            const q = params.get("q");
            if (category) where.push({ category: { equals: category, mode: "insensitive" } });
            if (brands.length) where.push({ OR: brands.map(brand => ({ brand: { equals: brand, mode: "insensitive" as const } })) });
            if (q) where.push({ OR: [{ title: { contains: q, mode: "insensitive" } }, { brand: { contains: q, mode: "insensitive" } }] });
            if (params.get("sort") === "discount") {
                where.push({ discountPercent: { gte: 10 } });
                orderBy = [{ discountPercent: "desc" }, { soldCount: "desc" }];
            }
            if (params.get("sort") === "newest") orderBy = [{ createdAt: "desc" }];
        } else if (url.pathname.startsWith("/store/")) {
            where.push({ seller: { slug: decodeURIComponent(url.pathname.split("/")[2] ?? "") } });
        } else if (url.pathname === "/sell") {
            where.push({ sellerId: { not: null } });
        }
    }

    return prisma.product.findMany({
        where: { AND: where },
        orderBy,
        take: 3,
        select: { id: true, title: true, image: true, category: true },
    });
};

// The banners shoppers see now, in order, with {maxDiscount} filled in. Cached with the product data
// (banner edits clear that cache, and the short cache time lets scheduled banners start on time).
export const listLiveBanners = () => cachedProducts("banners:live", async () => {
    const now = new Date();
    const [banners, discount] = await Promise.all([
        prisma.banner.findMany({
            where: {
                active: true,
                AND: [
                    { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
                    { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
                ],
            },
            orderBy: [{ position: "asc" }, { id: "asc" }],
        }),
        prisma.product.aggregate({ where: { AND: [visibleProductWhere, { stock: { gt: 0 } }] }, _max: { discountPercent: true } }),
    ]);
    const maxDiscount = String(discount._max.discountPercent ?? 0);
    const fill = (text: string | null) => text?.replaceAll("{maxDiscount}", maxDiscount) ?? null;

    const shown: number[] = []; // Each product appears on one banner only
    const result = [];
    for (const banner of banners) {
        const products = banner.image ? [] : await productsForLink(banner.ctaLink, shown);
        shown.push(...products.map(p => p.id));
        result.push({
            id: banner.id,
            eyebrow: banner.eyebrow,
            title: fill(banner.title)!,
            subtitle: fill(banner.subtitle),
            ctaLabel: banner.ctaLabel,
            ctaLink: banner.ctaLink,
            image: banner.image,
            theme: banner.theme,
            layout: banner.layout,
            products,
        });
    }
    return result;
});

// After any banner change
export const bannersChanged = () => invalidateProductCache();
