import { describe, expect, it } from "vitest";
import prisma from "../src/db.js";
import { API, api, createProduct, createUser, deliverOrder, placeCodOrder, setupTestDatabase } from "./helpers.js";

setupTestDatabase();

// A customer who has received the product
const verifiedBuyer = async (productId: number) => {
    const buyer = await createUser();
    const admin = await createUser("ADMIN");
    const order = await placeCodOrder(buyer.auth, [{ productId, quantity: 1 }]);
    await deliverOrder(order.id, admin.auth);
    return buyer;
};

const review = (auth: Record<string, string>, productId: number, body: object) =>
    api().post(`${API}/products/${productId}/reviews`).set(auth).send(body);

describe("writing reviews", () => {
    it("only customers who received the product can review it", async () => {
        const product = await createProduct();
        const stranger = await createUser();
        expect((await review(stranger.auth, product.id, { rating: 5, comment: "Great" })).status).toBe(403);

        const waiting = await createUser();
        await placeCodOrder(waiting.auth, [{ productId: product.id, quantity: 1 }]); // Ordered, not delivered
        expect((await review(waiting.auth, product.id, { rating: 5, comment: "Great" })).status).toBe(403);

        const buyer = await verifiedBuyer(product.id);
        const res = await review(buyer.auth, product.id, { rating: 4, title: "Solid", comment: "Does what it says" });
        expect(res.status).toBe(200);
        expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({ ratingAvg: 4, ratingCount: 1 });
    });

    it("writing again updates your review instead of adding a second one", async () => {
        const product = await createProduct();
        const buyer = await verifiedBuyer(product.id);
        await review(buyer.auth, product.id, { rating: 2, comment: "Meh" });
        await review(buyer.auth, product.id, { rating: 5, comment: "Grew on me" });
        expect(await prisma.review.count()).toBe(1);
        expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({ ratingAvg: 5, ratingCount: 1 });
    });

    it("validates the rating and comment", async () => {
        const product = await createProduct();
        const buyer = await verifiedBuyer(product.id);
        const res = await review(buyer.auth, product.id, { rating: 6, comment: "" });
        expect(res.body.errors.map((e: any) => e.field)).toEqual(["rating", "comment"]);
    });
});

describe("reading reviews", () => {
    it("shows the average, a star breakdown, short author names, and whether you can review", async () => {
        const product = await createProduct();
        const first = await verifiedBuyer(product.id);
        const second = await verifiedBuyer(product.id);
        await prisma.user.update({ where: { id: first.user.id }, data: { name: "Asha Rao" } });
        await prisma.user.update({ where: { id: second.user.id }, data: { name: "Ravi Kumar" } });
        await review(first.auth, product.id, { rating: 5, comment: "Love it" });
        await review(second.auth, product.id, { rating: 3, comment: "Okay" });

        const asGuest = await api().get(`${API}/products/${product.id}/reviews?sort=highest`);
        expect(asGuest.body.data.summary).toEqual({ average: 4, count: 2, breakdown: { 5: 1, 4: 0, 3: 1, 2: 0, 1: 0 } });
        expect(asGuest.body.data.reviews.map((r: any) => r.author)).toEqual(["Asha R.", "Ravi K."]);
        expect(asGuest.body.data.canReview).toBe(false);

        const asBuyer = await api().get(`${API}/products/${product.id}/reviews`).set(first.auth);
        expect(asBuyer.body.data.canReview).toBe(true);
        expect(asBuyer.body.data.myReview.rating).toBe(5);
    });
});

describe("helpful votes and deleting", () => {
    it("votes toggle, you can't vote on your own review, and deleting recalculates the rating", async () => {
        const product = await createProduct();
        const author = await verifiedBuyer(product.id);
        const reader = await createUser();
        const written = await review(author.auth, product.id, { rating: 1, comment: "Broke quickly" });
        const id = written.body.data.id;

        expect((await api().post(`${API}/reviews/${id}/helpful`).set(author.auth)).status).toBe(400);
        expect((await api().post(`${API}/reviews/${id}/helpful`).set(reader.auth)).body.data).toEqual({ votedHelpful: true, helpfulCount: 1 });
        expect((await api().post(`${API}/reviews/${id}/helpful`).set(reader.auth)).body.data).toEqual({ votedHelpful: false, helpfulCount: 0 });

        expect((await api().delete(`${API}/reviews/${id}`).set(reader.auth)).status).toBe(403);
        expect((await api().delete(`${API}/reviews/${id}`).set(author.auth)).status).toBe(200);
        expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({ ratingAvg: 0, ratingCount: 0 });
    });
});
