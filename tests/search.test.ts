import { describe, expect, it } from "vitest";
import { API, api, createProduct, createSeller, createUser, placeCodOrder, setupTestDatabase } from "./helpers.js";

setupTestDatabase();

const seedCatalog = async () => {
    await createProduct({ title: "Apple iPhone 15", brand: "Apple", price: 79999, mrp: 89900, discountPercent: 11, category: "Electronics", ratingAvg: 4.6, ratingCount: 10, soldCount: 50 });
    await createProduct({ title: "Samsung Galaxy S24", brand: "Samsung", price: 74999, mrp: 99999, discountPercent: 25, category: "Electronics", ratingAvg: 4.2, ratingCount: 4, soldCount: 80 });
    await createProduct({ title: "Realme C35", brand: "Realme", price: 11999, mrp: 13999, discountPercent: 14, category: "Electronics", ratingAvg: 3.5, ratingCount: 2, stock: 0 });
    await createProduct({ title: "Running Shoes", brand: "Puma", price: 4999, category: "Footwear" });
};

describe("filters and sorting", () => {
    it("filters by brand (several at once), rating, discount and stock", async () => {
        await seedCatalog();
        const titles = async (query: string) => (await api().get(`${API}/products?${query}`)).body.data.map((p: any) => p.title).sort();

        expect(await titles("brand=apple,Samsung")).toEqual(["Apple iPhone 15", "Samsung Galaxy S24"]);
        expect(await titles("minRating=4")).toEqual(["Apple iPhone 15", "Samsung Galaxy S24"]);
        expect(await titles("minDiscount=20")).toEqual(["Samsung Galaxy S24"]);
        expect(await titles("category=Electronics&inStock=true")).toEqual(["Apple iPhone 15", "Samsung Galaxy S24"]);
    });

    it("sorts by popularity and discount, and lists brands for the filter", async () => {
        await seedCatalog();
        const popular = await api().get(`${API}/products?sort=popularity&category=Electronics`);
        expect(popular.body.data.map((p: any) => p.title)).toEqual(["Samsung Galaxy S24", "Apple iPhone 15", "Realme C35"]);
        expect(popular.body.facets.brands).toEqual([{ name: "Apple", count: 1 }, { name: "Realme", count: 1 }, { name: "Samsung", count: 1 }]);

        const deals = await api().get(`${API}/products?sort=discount&limit=1`);
        expect(deals.body.data[0].title).toBe("Samsung Galaxy S24");
    });

    it("hides products waiting for approval or from suspended sellers", async () => {
        await createProduct({ title: "Pending", status: "PENDING" });
        const { seller } = await createSeller({ status: "SUSPENDED" });
        await createProduct({ title: "Suspended seller", sellerId: seller.id });
        await createProduct({ title: "Visible" });
        expect((await api().get(`${API}/products`)).body.data.map((p: any) => p.title)).toEqual(["Visible"]);
    });
});

describe("smart search", () => {
    it("finds products despite typos, and says so", async () => {
        await seedCatalog();
        const res = await api().get(`${API}/products?q=iphon`);
        expect(res.body.fuzzy).toBe(false); // "iphon" is inside "iPhone": a normal match

        const typo = await api().get(`${API}/products?q=samsng`);
        expect(typo.body.fuzzy).toBe(true);
        expect(typo.body.data.map((p: any) => p.title)).toEqual(["Samsung Galaxy S24"]);

        expect((await api().get(`${API}/products?q=xyzzyq`)).body.total).toBe(0);
    });

    it("suggests products, categories and brands as you type", async () => {
        await seedCatalog();
        const res = await api().get(`${API}/products/suggest?q=sam`);
        expect(res.body.data.products.map((p: any) => p.title)).toEqual(["Samsung Galaxy S24"]);
        expect(res.body.data.brands).toEqual(["Samsung"]);

        const categories = await api().get(`${API}/products/suggest?q=foot`);
        expect(categories.body.data.categories).toEqual(["Footwear"]);
    });
});

describe("related products", () => {
    it("'frequently bought together' comes from real orders; similar products from the same category", async () => {
        const phone = await createProduct({ title: "Phone", category: "Electronics" });
        const caseItem = await createProduct({ title: "Phone Case", category: "Accessories" });
        await createProduct({ title: "Tablet", category: "Electronics" });

        const buyer = await createUser();
        await placeCodOrder(buyer.auth, [{ productId: phone.id, quantity: 1 }, { productId: caseItem.id, quantity: 1 }]);

        const res = await api().get(`${API}/products/${phone.id}/related`);
        expect(res.body.data.boughtTogether.map((p: any) => p.title)).toEqual(["Phone Case"]);
        expect(res.body.data.similar.map((p: any) => p.title)).toEqual(["Tablet"]);
    });
});
