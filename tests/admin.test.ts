import { describe, expect, it } from "vitest";
import prisma from "../src/db.js";
import { API, api, createProduct, createUser, deliverOrder, placeCodOrder, setupTestDatabase } from "./helpers.js";

setupTestDatabase();

describe("admin panel endpoints", () => {
    it("are for admins only", async () => {
        const buyer = await createUser();
        for (const path of ["stats", "orders", "customers", "reviews", "messages", "subscribers", "admins"]) {
            expect((await api().get(`${API}/admin/${path}`).set(buyer.auth)).status).toBe(403);
            expect((await api().get(`${API}/admin/${path}`)).status).toBe(401);
        }
    });

    it("dashboard stats include 30 days of sales, top products and recent orders", async () => {
        const admin = await createUser("ADMIN");
        const buyer = await createUser();
        const product = await createProduct({ title: "Bestseller", price: 700 });
        const order = await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 2 }]);
        await deliverOrder(order.id, admin.auth);

        const stats = (await api().get(`${API}/admin/stats`).set(admin.auth)).body.data;
        expect(stats.salesByDay).toHaveLength(30);
        expect(stats.salesByDay.at(-1)).toEqual({ day: new Date().toISOString().slice(0, 10), revenue: 1400, orders: 1 });
        expect(stats.topProducts[0]).toMatchObject({ title: "Bestseller", soldCount: 2 });
        expect(stats.recentOrders[0]).toMatchObject({ id: order.id, user: { name: buyer.user.name } });
    });

    it("searches orders by number or customer", async () => {
        const admin = await createUser("ADMIN");
        const asha = await createUser();
        await prisma.user.update({ where: { id: asha.user.id }, data: { name: "Asha Rao" } });
        const ravi = await createUser();
        const product = await createProduct({ stock: 10 });
        const ashasOrder = await placeCodOrder(asha.auth, [{ productId: product.id, quantity: 1 }]);
        await placeCodOrder(ravi.auth, [{ productId: product.id, quantity: 1 }]);

        const byName = await api().get(`${API}/admin/orders?q=asha`).set(admin.auth);
        expect(byName.body.data.map((o: any) => o.id)).toEqual([ashasOrder.id]);
        const byNumber = await api().get(`${API}/admin/orders?q=%23${ashasOrder.id}`).set(admin.auth);
        expect(byNumber.body.data.map((o: any) => o.id)).toEqual([ashasOrder.id]);
        expect(byNumber.body.data[0].shipments[0].nextStatuses).toEqual(["SHIPPED", "CANCELLED"]);
        expect((await api().get(`${API}/admin/orders?limit=1`).set(admin.auth)).body).toMatchObject({ total: 2, totalPages: 2 });
    });

    it("lists customers with order count and money spent", async () => {
        const admin = await createUser("ADMIN");
        const buyer = await createUser();
        const product = await createProduct({ price: 1000 });
        const order = await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 1 }]);
        await placeCodOrder(buyer.auth, [{ productId: product.id, quantity: 1 }]);
        await deliverOrder(order.id, admin.auth);

        const res = await api().get(`${API}/admin/customers`).set(admin.auth);
        expect(res.body.data).toHaveLength(1); // Admins aren't customers
        expect(res.body.data[0]).toMatchObject({ email: buyer.user.email, orderCount: 2, totalSpent: 1000 });
    });

    it("lists reviews, contact messages and subscribers", async () => {
        const admin = await createUser("ADMIN");
        const buyer = await createUser();
        const product = await createProduct();
        await prisma.review.create({ data: { productId: product.id, userId: buyer.user.id, rating: 2, comment: "Not great" } });
        await api().post(`${API}/contact`).send({ name: "Asha", email: "asha@example.com", subject: "Help", message: "Where is my order?" });
        await api().post(`${API}/newsletter`).send({ email: "fan@example.com" });

        expect((await api().get(`${API}/admin/reviews?rating=2`).set(admin.auth)).body.data[0]).toMatchObject({ comment: "Not great", product: { id: product.id } });
        expect((await api().get(`${API}/admin/reviews?rating=5`).set(admin.auth)).body.data).toEqual([]);
        expect((await api().get(`${API}/admin/messages`).set(admin.auth)).body.data[0].subject).toBe("Help");
        expect((await api().get(`${API}/admin/subscribers`).set(admin.auth)).body.total).toBe(1);
        expect((await api().get(`${API}/admin/admins`).set(admin.auth)).body.data.map((a: any) => a.email)).toEqual([admin.user.email]);
    });

    it("the admin panel's origin is allowed to call the API", async () => {
        const res = await api().get(`${API}/health`).set("Origin", "http://localhost:5174");
        expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5174");
    });
});
