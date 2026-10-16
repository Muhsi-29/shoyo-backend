import type { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { invalidateProductCache } from "../cache.js";
import { HttpError } from "../utils/httpError.js";
import { refreshProductRating } from "./productService.js";

const PAGE_SIZE = 10;

// Only customers who have received the product can review it, so every review is a verified purchase
export const canReview = async (userId: number, productId: number) =>
    Boolean(await prisma.orderItem.findFirst({
        where: { productId, order: { userId }, shipment: { status: "DELIVERED" } },
        select: { id: true },
    }));

// "Asha Rao" -> "Asha R." (reviews are public, so full names aren't shown)
const displayName = (name: string) => {
    const [first, ...rest] = name.trim().split(/\s+/);
    const last = rest.at(-1);
    return last ? `${first} ${last[0]!.toUpperCase()}.` : first ?? "Customer";
};

const SORTS: Record<string, Prisma.ReviewOrderByWithRelationInput[]> = {
    helpful: [{ helpfulCount: "desc" }, { createdAt: "desc" }],
    newest: [{ createdAt: "desc" }],
    highest: [{ rating: "desc" }, { createdAt: "desc" }],
    lowest: [{ rating: "asc" }, { createdAt: "desc" }],
};

export const listReviews = async (productId: number, { sort, page }: { sort: string; page: number }, viewerId?: number) => {
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { ratingAvg: true, ratingCount: true } });
    if (!product) throw new HttpError(404, "Product not found");

    const [reviews, groups, eligible, mine] = await Promise.all([
        prisma.review.findMany({
            where: { productId },
            include: {
                user: { select: { name: true } },
                votes: { where: { userId: viewerId ?? -1 }, select: { userId: true } },
            },
            orderBy: SORTS[sort] ?? SORTS.helpful!,
            skip: (page - 1) * PAGE_SIZE,
            take: PAGE_SIZE,
        }),
        prisma.review.groupBy({ by: ["rating"], where: { productId }, _count: { _all: true } }),
        viewerId ? canReview(viewerId, productId) : Promise.resolve(false),
        viewerId ? prisma.review.findUnique({ where: { productId_userId: { productId, userId: viewerId } } }) : Promise.resolve(null),
    ]);

    const breakdown: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    for (const group of groups) breakdown[group.rating] = group._count._all;

    return {
        summary: { average: product.ratingAvg, count: product.ratingCount, breakdown },
        reviews: reviews.map(review => ({
            id: review.id,
            rating: review.rating,
            title: review.title,
            comment: review.comment,
            helpfulCount: review.helpfulCount,
            createdAt: review.createdAt,
            author: displayName(review.user.name),
            isMine: review.userId === viewerId,
            votedHelpful: review.votes.length > 0,
        })),
        page,
        totalPages: Math.max(1, Math.ceil(product.ratingCount / PAGE_SIZE)),
        canReview: eligible,
        myReview: mine,
    };
};

// Adds the customer's review, or updates it if they already reviewed this product
export const saveReview = async (userId: number, productId: number, input: { rating: number; title?: string | undefined; comment: string }) => {
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) throw new HttpError(404, "Product not found");
    if (!(await canReview(userId, productId))) {
        throw new HttpError(403, "Only customers who have received this product can review it.");
    }

    const data = { rating: input.rating, title: input.title ?? null, comment: input.comment };
    const review = await prisma.$transaction(async (tx) => {
        const saved = await tx.review.upsert({
            where: { productId_userId: { productId, userId } },
            create: { productId, userId, ...data },
            update: data,
        });
        await refreshProductRating(productId, tx);
        return saved;
    });
    await invalidateProductCache(); // Ratings show on product lists
    return review;
};

export const deleteReview = async (reviewId: number, actor: { userId: number; role: string }) => {
    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) throw new HttpError(404, "Review not found");
    if (review.userId !== actor.userId && actor.role !== "ADMIN") {
        throw new HttpError(403, "Forbidden. You can only delete your own review.");
    }
    await prisma.$transaction(async (tx) => {
        await tx.review.delete({ where: { id: reviewId } });
        await refreshProductRating(review.productId, tx);
    });
    await invalidateProductCache();
};

// "Was this review helpful?" Voting again removes the vote.
export const toggleHelpful = async (reviewId: number, userId: number) => {
    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) throw new HttpError(404, "Review not found");
    if (review.userId === userId) throw new HttpError(400, "You can't vote on your own review.");

    return prisma.$transaction(async (tx) => {
        const existing = await tx.reviewVote.findUnique({ where: { reviewId_userId: { reviewId, userId } } });
        if (existing) {
            await tx.reviewVote.delete({ where: { reviewId_userId: { reviewId, userId } } });
        } else {
            await tx.reviewVote.create({ data: { reviewId, userId } });
        }
        const updated = await tx.review.update({
            where: { id: reviewId },
            data: { helpfulCount: { increment: existing ? -1 : 1 } },
        });
        return { votedHelpful: !existing, helpfulCount: updated.helpfulCount };
    });
};
