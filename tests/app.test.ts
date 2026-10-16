import { describe, expect, it, vi } from "vitest";
import { API, api, setupTestDatabase } from "./helpers.js";
import { enqueueJob, waitForJobs } from "../src/jobs/queue.js";

setupTestDatabase();

describe("app basics", () => {
    it("reports health, including the database", async () => {
        const res = await api().get(`${API}/health`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: "success", database: "up" });
    });

    it("answers unknown routes with JSON 404", async () => {
        const res = await api().get(`${API}/does-not-exist`);
        expect(res.status).toBe(404);
        expect(res.body.status).toBe("error");
    });

    it("answers malformed JSON with 400, without leaking a stack trace", async () => {
        const res = await api().post(`${API}/auth/login`).set("Content-Type", "application/json").send("{bad json");
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).not.toMatch(/node_modules|\\src\\|\/src\//);
    });

    it("sends security headers and only allows the frontend's origin", async () => {
        const allowed = await api().get(`${API}/health`).set("Origin", "http://localhost:5173");
        expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
        expect(allowed.headers["x-content-type-options"]).toBe("nosniff");

        const other = await api().get(`${API}/health`).set("Origin", "https://evil.example");
        expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    });
});

describe("background job queue", () => {
    it("retries a failing job until it succeeds", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout"] });
        let calls = 0;
        enqueueJob("flaky", async () => {
            calls++;
            if (calls < 3) throw new Error("temporary failure");
        });

        await vi.advanceTimersByTimeAsync(1_000); // 1st retry after 1s
        await vi.advanceTimersByTimeAsync(5_000); // 2nd retry after 5s
        vi.useRealTimers();
        await waitForJobs();
        expect(calls).toBe(3);
    });
});
