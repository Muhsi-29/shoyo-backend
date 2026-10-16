import type { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import prisma from "../db.js";
import { cachedProducts } from "../cache.js";
import { HttpError } from "../utils/httpError.js";
import {
    sellerNameFor, sellerRatingFor, sellerSummarySelect, visibleProductWhere,
} from "../services/productService.js";
import { createProductFromRequest, deleteProductById, updateProductFromRequest } from "../services/productListingService.js";
import { idParamsSchema, productQuerySchema, suggestQuerySchema } from "../validation/schemas.js";
import type { AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { logActivity } from "../services/activityService.js";

// Errors thrown here (validation, HttpError) are turned into JSON responses by the error handler in app.ts

type ProductQuery = ReturnType<typeof productQuerySchema.parse>;

const SORT_ORDERS: Record<ProductQuery["sort"], Prisma.ProductOrderByWithRelationInput[]> = {
    newest: [{ createdAt: "desc" }],
    popularity: [{ soldCount: "desc" }, { ratingCount: "desc" }],
    rating: [{ ratingAvg: "desc" }, { ratingCount: "desc" }],
    discount: [{ discountPercent: "desc" }],
    price_asc: [{ price: "asc" }],
    price_desc: [{ price: "desc" }],
    name_asc: [{ title: "asc" }],
};

const withSeller = { seller: { select: sellerSummarySelect } } satisfies Prisma.ProductInclude;

// Adds the seller's display name ("Shoyo Retail" for the store's own products)
const toPublicProduct = <T extends { seller: { storeName: string } | null }>(product: T) => ({
    ...product,
    sellerName: sellerNameFor(product.seller),
});

// Shoppers' filters as Prisma conditions, always limited to products shoppers may see.
// `ids` replaces the text search (used for typo-tolerant matches); includeBrand: false is for the brand list.
const buildWhere = (query: ProductQuery, { includeBrand = true, ids }: { includeBrand?: boolean; ids?: number[] } = {}): Prisma.ProductWhereInput => {
    const conditions: Prisma.ProductWhereInput[] = [visibleProductWhere];
    if (query.category) conditions.push({ category: { equals: query.category, mode: "insensitive" } });

    const brands = includeBrand ? (query.brand?.split(",").map(b => b.trim()).filter(Boolean) ?? []) : [];
    if (brands.length > 0) conditions.push({ OR: brands.map(brand => ({ brand: { equals: brand, mode: "insensitive" } })) });

    if (query.minPrice !== undefined) conditions.push({ price: { gte: query.minPrice } });
    if (query.maxPrice !== undefined) conditions.push({ price: { lte: query.maxPrice } });
    if (query.minRating !== undefined) conditions.push({ ratingAvg: { gte: query.minRating } });
    if (query.minDiscount !== undefined) conditions.push({ discountPercent: { gte: query.minDiscount } });
    if (query.inStock) conditions.push({ stock: { gt: 0 } });

    if (ids) {
        conditions.push({ id: { in: ids } });
    } else if (query.q) {
        conditions.push({
            OR: [
                { title: { contains: query.q, mode: "insensitive" } },
                { brand: { contains: query.q, mode: "insensitive" } },
                { category: { contains: query.q, mode: "insensitive" } },
                { description: { contains: query.q, mode: "insensitive" } },
            ],
        });
    }
    return { AND: conditions };
};

// Typo-tolerant search: products whose title, brand or category is *close* to what was typed
// ("iphon", "samsng"), using PostgreSQL's trigram matching (pg_trgm)
const fuzzyMatchIds = async (q: string) => {
    const rows = await prisma.$queryRaw<{ id: number }[]>`
        SELECT p."id"
        FROM "Product" p
        WHERE GREATEST(word_similarity(${q}, p."title"), word_similarity(${q}, COALESCE(p."brand", '')), word_similarity(${q}, p."category")) > 0.4
        ORDER BY GREATEST(word_similarity(${q}, p."title"), word_similarity(${q}, COALESCE(p."brand", '')), word_similarity(${q}, p."category")) DESC
        LIMIT 50`;
    return rows.map(row => row.id);
};

// GET /products?q=&category=&brand=&minPrice=&maxPrice=&minRating=&minDiscount=&inStock=&sort=&page=&limit=
// Search, filter, sort and paginate. If a search finds nothing, close matches are shown instead (fuzzy: true).
// (GET /products/search does the same, for older clients.)
export const getAllProducts = async (req: Request, res: Response) => {
    const query = productQuerySchema.parse(req.query);

    const result = await cachedProducts(`list:${JSON.stringify(query)}`, async () => {
        const run = async (ids?: number[]) => {
            const where = buildWhere(query, ids ? { ids } : {});
            const [total, products] = await prisma.$transaction([
                prisma.product.count({ where }),
                prisma.product.findMany({
                    where,
                    include: withSeller,
                    orderBy: [...SORT_ORDERS[query.sort], { id: "asc" }], // id keeps the order stable between pages
                    skip: (query.page - 1) * query.limit,
                    take: query.limit,
                }),
            ]);
            return { total, products };
        };

        let found = await run();
        let fuzzyIds: number[] | undefined;
        if (found.total === 0 && query.q) {
            const ids = await fuzzyMatchIds(query.q);
            if (ids.length > 0) {
                found = await run(ids);
                if (found.total > 0) fuzzyIds = ids;
            }
        }

        // Brands in the current results (ignoring the brand filter itself), for the brand filter list
        const brandGroups = await prisma.product.groupBy({
            by: ["brand"],
            where: { AND: [buildWhere(query, { includeBrand: false, ...(fuzzyIds ? { ids: fuzzyIds } : {}) }), { brand: { not: null } }] },
            _count: { _all: true },
            orderBy: { brand: "asc" },
        });

        return {
            ...found,
            fuzzy: Boolean(fuzzyIds),
            brands: brandGroups.map(group => ({ name: group.brand!, count: group._count._all })),
        };
    });

    res.status(200).json({
        status: 'success',
        results: result.products.length,
        total: result.total,
        page: query.page,
        totalPages: Math.max(1, Math.ceil(result.total / query.limit)),
        fuzzy: result.fuzzy,
        facets: { brands: result.brands },
        data: result.products.map(toPublicProduct),
    });
};

export const searchProduct = getAllProducts;

// GET /products/suggest?q=: search-as-you-type suggestions (products, plus matching categories and brands)
export const suggestProducts = async (req: Request, res: Response) => {
    const { q } = suggestQuerySchema.parse(req.query);
    const data = await cachedProducts(`suggest:${q.toLowerCase()}`, async () => {
        const like = `%${q}%`;
        const products = await prisma.$queryRaw<{ id: number; title: string; image: string; price: number; category: string; brand: string | null }[]>`
            SELECT p."id", p."title", p."image", p."price", p."category", p."brand"
            FROM "Product" p
            LEFT JOIN "Seller" s ON s."id" = p."sellerId"
            WHERE p."status" = 'ACTIVE' AND (p."sellerId" IS NULL OR s."status" = 'APPROVED')
              AND (p."title" ILIKE ${like} OR COALESCE(p."brand", '') ILIKE ${like} OR word_similarity(${q}, p."title") > 0.4)
            ORDER BY (p."title" ILIKE ${`${q}%`}) DESC, word_similarity(${q}, p."title") DESC, p."soldCount" DESC
            LIMIT 6`;
        const [categories, brands] = await Promise.all([
            prisma.product.groupBy({
                by: ["category"],
                where: { AND: [visibleProductWhere, { category: { contains: q, mode: "insensitive" } }] },
                orderBy: { category: "asc" },
                take: 3,
            }),
            prisma.product.groupBy({
                by: ["brand"],
                where: { AND: [visibleProductWhere, { brand: { contains: q, mode: "insensitive" } }] },
                orderBy: { brand: "asc" },
                take: 3,
            }),
        ]);
        return {
            products,
            categories: categories.map(c => c.category),
            brands: brands.map(b => b.brand).filter((brand): brand is string => Boolean(brand)),
        };
    });
    res.status(200).json({ status: 'success', data });
};

// GET /products/categories: every category with how many products it has (for menus and filters)
export const getCategories = async (req: Request, res: Response) => {
    const categories = await cachedProducts("categories", async () => {
        const groups = await prisma.product.groupBy({
            by: ["category"],
            where: visibleProductWhere,
            _count: { _all: true },
            orderBy: { category: "asc" },
        });
        return groups.map(group => ({ name: group.category, count: group._count._all }));
    });
    res.status(200).json({ status: 'success', data: categories });
};

export const getProductById = async (req: Request, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const product = await cachedProducts(`product:${id}`, async () => {
        const found = await prisma.product.findFirst({
            where: { AND: [visibleProductWhere, { id }] },
            include: { seller: { select: { ...sellerSummarySelect, description: true, createdAt: true } } },
        });
        if (!found) return null;
        return { ...toPublicProduct(found), sellerRating: found.sellerId ? await sellerRatingFor(found.sellerId) : null };
    });
    if (!product) {
        throw new HttpError(404, 'Product not found');
    }
    res.status(200).json({ status: 'success', data: product });
};

// GET /products/:id/related: "Frequently bought together" (from real orders) and similar products
export const getRelatedProducts = async (req: Request, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const data = await cachedProducts(`related:${id}`, async () => {
        const product = await prisma.product.findUnique({ where: { id }, select: { id: true, category: true } });
        if (!product) throw new HttpError(404, 'Product not found');

        // Products that appear in the same (non-cancelled) orders as this one, most often first
        const pairs = await prisma.$queryRaw<{ productId: number }[]>`
            SELECT other."productId"
            FROM "OrderItem" mine
            JOIN "OrderItem" other ON other."orderId" = mine."orderId" AND other."productId" <> mine."productId"
            JOIN "Order" o ON o."id" = mine."orderId" AND o."status" <> 'CANCELLED'
            WHERE mine."productId" = ${id}
            GROUP BY other."productId"
            ORDER BY COUNT(*) DESC, other."productId"
            LIMIT 8`;
        const togetherIds = pairs.map(pair => pair.productId);
        const together = togetherIds.length > 0
            ? await prisma.product.findMany({ where: { AND: [visibleProductWhere, { id: { in: togetherIds } }] }, include: withSeller })
            : [];
        together.sort((a, b) => togetherIds.indexOf(a.id) - togetherIds.indexOf(b.id));
        const boughtTogether = together.slice(0, 4);

        const similar = await prisma.product.findMany({
            where: { AND: [visibleProductWhere, { category: product.category }, { id: { notIn: [id, ...boughtTogether.map(p => p.id)] } }] },
            include: withSeller,
            orderBy: [{ ratingAvg: "desc" }, { soldCount: "desc" }, { id: "asc" }],
            take: 4,
        });
        return { boughtTogether: boughtTogether.map(toPublicProduct), similar: similar.map(toPublicProduct) };
    });
    res.status(200).json({ status: 'success', data });
};

// ---------- Admin: Shoyo's own products (and any product, for moderation) ----------

export const createProduct = async (req: AuthenticatedRequest, res: Response) => {
    const product = await createProductFromRequest(req, { sellerId: null, status: "ACTIVE" });
    await logActivity(req, { action: "product.created", summary: `Added product "${product.title}"`, targetType: "product", targetId: product.id });
    res.status(201).json({ status: 'success', data: product });
};

export const updateProduct = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const product = await updateProductFromRequest(req, id);
    await logActivity(req, { action: "product.updated", summary: `Edited product "${product.title}"`, targetType: "product", targetId: id });
    res.status(200).json({ status: 'success', data: product });
};

export const deleteProduct = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const product = await prisma.product.findUnique({ where: { id }, select: { title: true } });
    await deleteProductById(id);
    await logActivity(req, { action: "product.deleted", summary: `Deleted product "${product?.title ?? `#${id}`}"`, targetType: "product", targetId: id });
    res.status(200).json({ status: 'success', message: 'Product deleted successfully' });
};
