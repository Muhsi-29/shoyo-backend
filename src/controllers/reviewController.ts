import type { Response } from "express";
import prisma from "../db.js";
import { currentUserId, isAdminWith, type AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { logActivity } from "../services/activityService.js";
import { deleteReview, listReviews, saveReview, toggleHelpful } from "../services/reviewService.js";
import { idParamsSchema, reviewQuerySchema, reviewSchema } from "../validation/schemas.js";

// GET /products/:id/reviews?sort=helpful|newest|highest|lowest&page=
// Rating summary plus one page of reviews. Logged-in shoppers also learn whether they can review.
export const getProductReviews = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const query = reviewQuerySchema.parse(req.query);
    res.status(200).json({ status: "success", data: await listReviews(id, query, req.user?.id) });
};

// POST /products/:id/reviews: write (or update) your review. Only customers who received the product can.
export const createOrUpdateReview = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = reviewSchema.parse(req.body ?? {});
    const review = await saveReview(currentUserId(req), id, input);
    res.status(200).json({ status: "success", message: "Thanks for your review!", data: review });
};

// DELETE /reviews/:id: your own review (admins who moderate reviews can delete any)
export const removeReview = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    const moderator = isAdminWith(req, "reviews");
    const review = await prisma.review.findUnique({
        where: { id },
        select: { userId: true, rating: true, user: { select: { name: true } }, product: { select: { title: true } } },
    });
    await deleteReview(id, { userId: currentUserId(req), role: moderator ? "ADMIN" : "BUYER" });
    if (moderator && review && review.userId !== currentUserId(req)) {
        await logActivity(req, {
            action: "review.deleted",
            summary: `Removed ${review.user.name}'s ${review.rating}-star review of "${review.product.title}"`,
            targetType: "review",
            targetId: id,
        });
    }
    res.status(200).json({ status: "success", message: "Review deleted" });
};

// POST /reviews/:id/helpful: "Was this helpful?" (again to undo)
export const markReviewHelpful = async (req: AuthenticatedRequest, res: Response) => {
    const { id } = idParamsSchema.parse(req.params);
    res.status(200).json({ status: "success", data: await toggleHelpful(id, currentUserId(req)) });
};
