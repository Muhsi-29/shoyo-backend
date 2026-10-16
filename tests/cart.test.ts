import { describe, expect, it } from "vitest";
import prisma from "../src/db.js";
import { API, api, createProduct, createUser, setupTestDatabase } from "./helpers.js";

setupTestDatabase();

describe("cart", () => {
    it("requires login", async () => {
        expect((await api().get(`${API}/cart`)).status).toBe(401);
    });

    it("adds items, increases the quantity when added again, and totals the cart", async () => {
        const { auth } = await createUser();
        const phone = await createProduct({ price: 1000 });
        const case_ = await createProduct({ price: 250 });

        await api().post(`${API}/cart/items`).set(auth).send({ productId: phone.id });
        await api().post(`${API}/cart/items`).set(auth).send({ productId: phone.id, quantity: 2 });
        const res = await api().post(`${API}/cart/items`).set(auth).send({ productId: case_.id, quantity: 1 });

        expect(res.status).toBe(200);
        expect(res.body.data.items.map((i: any) => [i.productId, i.quantity])).toEqual([[phone.id, 3], [case_.id, 1]]);
        expect(res.body.data).toMatchObject({ count: 4, subtotal: 3250 });
    });

    it("won't hold more than is in stock", async () => {
        const { auth } = await createUser();
        const product = await createProduct({ stock: 2 });
        const soldOut = await createProduct({ stock: 0 });

        expect((await api().post(`${API}/cart/items`).set(auth).send({ productId: product.id, quantity: 3 })).status).toBe(400);
        expect((await api().post(`${API}/cart/items`).set(auth).send({ productId: soldOut.id })).body.message).toMatch(/out of stock/);
        expect((await api().post(`${API}/cart/items`).set(auth).send({ productId: 999 })).status).toBe(404);
    });

    it("sets quantities, removes items and clears", async () => {
        const { auth } = await createUser();
        const a = await createProduct();
        const b = await createProduct();
        await api().post(`${API}/cart/items`).set(auth).send({ productId: a.id });
        await api().post(`${API}/cart/items`).set(auth).send({ productId: b.id });

        const set = await api().put(`${API}/cart/items/${a.id}`).set(auth).send({ quantity: 5 });
        expect(set.body.data.count).toBe(6);

        const removed = await api().delete(`${API}/cart/items/${b.id}`).set(auth);
        expect(removed.body.data.items.map((i: any) => i.productId)).toEqual([a.id]);

        const cleared = await api().delete(`${API}/cart`).set(auth);
        expect(cleared.body.data).toMatchObject({ items: [], count: 0, subtotal: 0, deliveryFee: 0, total: 0 });
    });

    it("adds delivery below the free-delivery amount", async () => {
        const { auth } = await createUser();
        const product = await createProduct({ price: 200 });
        const res = await api().post(`${API}/cart/items`).set(auth).send({ productId: product.id, quantity: 2 });
        expect(res.body.data).toMatchObject({ subtotal: 400, deliveryFee: 40, total: 440, freeDeliveryThreshold: 499 });
    });

    it("'save for later' moves an item out of the order and back", async () => {
        const { auth } = await createUser();
        const keep = await createProduct({ price: 600 });
        const later = await createProduct({ price: 900 });
        await api().post(`${API}/cart/items`).set(auth).send({ productId: keep.id });
        await api().post(`${API}/cart/items`).set(auth).send({ productId: later.id });

        const saved = await api().patch(`${API}/cart/items/${later.id}/save-for-later`).set(auth).send({ saved: true });
        expect(saved.body.data.items.map((i: any) => i.productId)).toEqual([keep.id]);
        expect(saved.body.data.savedItems.map((i: any) => i.productId)).toEqual([later.id]);
        expect(saved.body.data.subtotal).toBe(600);

        // Ordering the cart leaves the saved item where it is
        await api().post(`${API}/orders`).set(auth).send({ shippingAddress: { fullName: "A", phone: "9876543210", line1: "x", city: "y", state: "z", postalCode: "560001" } });
        const after = await api().get(`${API}/cart`).set(auth);
        expect(after.body.data.items).toEqual([]);
        expect(after.body.data.savedItems.map((i: any) => i.productId)).toEqual([later.id]);

        const back = await api().patch(`${API}/cart/items/${later.id}/save-for-later`).set(auth).send({ saved: false });
        expect(back.body.data.items.map((i: any) => i.productId)).toEqual([later.id]);
    });

    it("flags items that were taken off sale after being added", async () => {
        const { auth } = await createUser();
        const product = await createProduct();
        await api().post(`${API}/cart/items`).set(auth).send({ productId: product.id });
        await prisma.product.update({ where: { id: product.id }, data: { status: "REJECTED" } });
        expect((await api().get(`${API}/cart`).set(auth)).body.data.items[0].available).toBe(false);
        expect((await api().post(`${API}/cart/items`).set(auth).send({ productId: product.id })).status).toBe(400);
    });

    it("keeps each user's cart separate", async () => {
        const alice = await createUser();
        const bob = await createUser();
        const product = await createProduct();
        await api().post(`${API}/cart/items`).set(alice.auth).send({ productId: product.id });
        expect((await api().get(`${API}/cart`).set(bob.auth)).body.data.count).toBe(0);
    });

    it("merges a guest cart after login, skipping missing products and capping at stock", async () => {
        const { auth } = await createUser();
        const product = await createProduct({ stock: 4 });
        await api().post(`${API}/cart/items`).set(auth).send({ productId: product.id, quantity: 2 });

        const res = await api().post(`${API}/cart/merge`).set(auth).send({
            items: [{ productId: product.id, quantity: 5 }, { productId: 999, quantity: 1 }],
        });
        expect(res.status).toBe(200);
        expect(res.body.data.items.map((i: any) => [i.productId, i.quantity])).toEqual([[product.id, 4]]);
    });
});
