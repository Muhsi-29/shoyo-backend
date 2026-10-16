import fs from "fs";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API, api, createProduct, createUser, pngBuffer, setupTestDatabase, placeCodOrder } from "./helpers.js";
import { UPLOAD_DIR } from "../src/middlewares/uploadMiddleware.js";

setupTestDatabase();

// Remove any image files these tests upload
let filesBefore: Set<string>;
beforeAll(() => { filesBefore = new Set(fs.readdirSync(UPLOAD_DIR)); });
afterAll(() => {
    for (const file of fs.readdirSync(UPLOAD_DIR)) {
        if (!filesBefore.has(file)) fs.rmSync(path.join(UPLOAD_DIR, file), { force: true });
    }
});

const seedCatalog = async () => {
    await createProduct({ title: "Budget Phone", price: 9999, category: "Electronics", description: "Cheap and cheerful" });
    await createProduct({ title: "Flagship Phone", price: 79999, category: "Electronics", description: "Top camera" });
    await createProduct({ title: "Running Shoes", price: 4999, category: "Footwear", description: "Light and fast" });
    await createProduct({ title: "Headphones", price: 24999, category: "Accessories", description: "Noise cancelling phone audio" });
};

describe("GET /products", () => {
    it("paginates", async () => {
        await seedCatalog();
        const res = await api().get(`${API}/products?limit=3&page=2&sort=name_asc`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ total: 4, page: 2, totalPages: 2, results: 1 });
        expect(res.body.data[0].title).toBe("Running Shoes");
    });

    it("sorts by price", async () => {
        await seedCatalog();
        const res = await api().get(`${API}/products?sort=price_desc`);
        expect(res.body.data.map((p: any) => p.price)).toEqual([79999, 24999, 9999, 4999]);
    });

    it("filters by category (any case), price range and search text", async () => {
        await seedCatalog();
        const byCategory = await api().get(`${API}/products?category=electronics`);
        expect(byCategory.body.total).toBe(2);

        const byPrice = await api().get(`${API}/products?minPrice=5000&maxPrice=30000`);
        expect(byPrice.body.data.map((p: any) => p.title).sort()).toEqual(["Budget Phone", "Headphones"]);

        // Matches titles and descriptions
        const bySearch = await api().get(`${API}/products/search?q=phone`);
        expect(bySearch.body.total).toBe(3);
    });

    it("rejects invalid query values", async () => {
        const res = await api().get(`${API}/products?minPrice=abc&sort=random&limit=1000`);
        expect(res.status).toBe(400);
        expect(res.body.errors.map((e: any) => e.field)).toEqual(["minPrice", "sort", "limit"]);
    });
});

describe("GET /products/categories and /products/:id", () => {
    it("counts products per category", async () => {
        await seedCatalog();
        const res = await api().get(`${API}/products/categories`);
        expect(res.body.data).toEqual([
            { name: "Accessories", count: 1 },
            { name: "Electronics", count: 2 },
            { name: "Footwear", count: 1 },
        ]);
    });

    it("returns 400 for a bad ID and 404 for a missing one", async () => {
        expect((await api().get(`${API}/products/abc`)).status).toBe(400);
        expect((await api().get(`${API}/products/99999999999`)).status).toBe(400);
        expect((await api().get(`${API}/products/999`)).status).toBe(404);
    });
});

describe("admin product management", () => {
    it("creates a product with an uploaded image that is then served", async () => {
        const admin = await createUser("ADMIN");
        const res = await api().post(`${API}/products`).set(admin.auth)
            .field({ title: "Desk Lamp", price: "1499", description: "Warm light", category: "Home", stock: "5" })
            .attach("image", pngBuffer, { filename: "lamp.png", contentType: "image/png" });

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ title: "Desk Lamp", price: 1499, stock: 5, status: "ACTIVE", sellerId: null });
        expect(res.body.data.image).toMatch(/^\/uploads\/image-.*\.png$/);

        const image = await api().get(res.body.data.image);
        expect(image.status).toBe(200);
        expect(image.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("saves gallery photos, MRP, brand and specs", async () => {
        const admin = await createUser("ADMIN");
        const res = await api().post(`${API}/products`).set(admin.auth)
            .field({ title: "Desk Lamp", brand: "Lumo", price: "1500", mrp: "2000", description: "Warm light", category: "Home", stock: "5",
                specs: JSON.stringify([{ label: "Power", value: "9 W" }]) })
            .attach("image", pngBuffer, { filename: "lamp.png", contentType: "image/png" })
            .attach("gallery", pngBuffer, { filename: "side.png", contentType: "image/png" })
            .attach("gallery", pngBuffer, { filename: "back.png", contentType: "image/png" });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ brand: "Lumo", mrp: 2000, discountPercent: 25, specs: [{ label: "Power", value: "9 W" }] });
        expect(res.body.data.images).toHaveLength(2);

        const wrongMrp = await api().put(`${API}/products/${res.body.data.id}`).set(admin.auth).send({ price: 2500 });
        expect(wrongMrp.body.message).toBe("mrp: can't be lower than the price");
        expect(wrongMrp.body.errors).toEqual([{ field: "mrp", message: "can't be lower than the price" }]);

        // Empty values clear the brand and MRP (and with them the discount)
        const cleared = await api().put(`${API}/products/${res.body.data.id}`).set(admin.auth).field({ brand: "", mrp: "" });
        expect(cleared.status).toBe(200);
        expect(cleared.body.data).toMatchObject({ brand: null, mrp: null, discountPercent: 0 });
    });

    it("rejects non-images, and saves the extension from the type, not the filename", async () => {
        const admin = await createUser("ADMIN");
        const fields = { title: "T", price: "1", description: "D", category: "C", stock: "1" };

        const html = await api().post(`${API}/products`).set(admin.auth).field(fields)
            .attach("image", Buffer.from("<script>alert(1)</script>"), { filename: "evil.html", contentType: "text/html" });
        expect(html.status).toBe(400);

        const disguised = await api().post(`${API}/products`).set(admin.auth).field(fields)
            .attach("image", pngBuffer, { filename: "evil.html", contentType: "image/png" });
        expect(disguised.body.data.image).toMatch(/\.png$/);
    });

    it("validates fields and doesn't keep the image of a rejected product", async () => {
        const admin = await createUser("ADMIN");
        const before = fs.readdirSync(UPLOAD_DIR).length;
        const res = await api().post(`${API}/products`).set(admin.auth)
            .field({ title: "T", price: "free", description: "D", category: "C", stock: "-1" })
            .attach("image", pngBuffer, { filename: "x.png", contentType: "image/png" });
        expect(res.status).toBe(400);
        expect(res.body.errors.map((e: any) => e.field)).toEqual(["price", "stock"]);

        await new Promise(resolve => setTimeout(resolve, 50)); // File deletion is async
        expect(fs.readdirSync(UPLOAD_DIR).length).toBe(before);
    });

    it("updates a product and the cached copy is refreshed", async () => {
        const admin = await createUser("ADMIN");
        const product = await createProduct({ price: 500 });

        expect((await api().get(`${API}/products/${product.id}`)).body.data.price).toBe(500); // Now cached
        const update = await api().put(`${API}/products/${product.id}`).set(admin.auth).send({ price: 450, stock: 0 });
        expect(update.status).toBe(200);
        expect((await api().get(`${API}/products/${product.id}`)).body.data).toMatchObject({ price: 450, stock: 0 });
    });

    it("buyers can't create, update or delete products", async () => {
        const buyer = await createUser("BUYER");
        const product = await createProduct();
        expect((await api().put(`${API}/products/${product.id}`).set(buyer.auth).send({ price: 1 })).status).toBe(403);
        expect((await api().delete(`${API}/products/${product.id}`).set(buyer.auth)).status).toBe(403);
    });

    it("won't delete a product that has orders, but deletes one that doesn't", async () => {
        const admin = await createUser("ADMIN");
        const buyer = await createUser("BUYER");
        const ordered = await createProduct();
        const unordered = await createProduct();
        await placeCodOrder(buyer.auth, [{ productId: ordered.id, quantity: 1 }]);

        expect((await api().delete(`${API}/products/${ordered.id}`).set(admin.auth)).status).toBe(409);
        expect((await api().delete(`${API}/products/${unordered.id}`).set(admin.auth)).status).toBe(200);
    });
});
