import { Redis } from "ioredis";
import { CACHE_TTL_SECONDS, REDIS_URL } from "./config.js";
import logger from "./logger.js";

// Caches product responses (lists, details, categories), which are read far more often than they change.
// Uses Redis when REDIS_URL is set, so every server shares one cache; otherwise an in-memory Map.
// A cache problem never breaks a request: it just falls back to reading the database.

interface CacheStore {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSeconds: number): Promise<void>;
    incr(key: string): Promise<number>;
}

class MemoryStore implements CacheStore {
    private entries = new Map<string, { value: string; expiresAt: number }>();

    async get(key: string) {
        const entry = this.entries.get(key);
        if (!entry) return null;
        if (entry.expiresAt < Date.now()) {
            this.entries.delete(key);
            return null;
        }
        return entry.value;
    }

    async set(key: string, value: string, ttlSeconds: number) {
        this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
        if (this.entries.size > 1000) this.removeExpired();
    }

    async incr(key: string) {
        const next = Number((await this.get(key)) ?? 0) + 1;
        this.entries.set(key, { value: String(next), expiresAt: Infinity });
        return next;
    }

    private removeExpired() {
        const now = Date.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt < now) this.entries.delete(key);
        }
    }
}

class RedisStore implements CacheStore {
    private client: Redis;

    constructor(client: Redis) {
        this.client = client;
    }

    get(key: string) {
        return this.client.get(key);
    }

    async set(key: string, value: string, ttlSeconds: number) {
        await this.client.set(key, value, "EX", ttlSeconds);
    }

    incr(key: string) {
        return this.client.incr(key);
    }
}

let redisClient: Redis | null = null;
if (REDIS_URL) {
    // Fail fast instead of queueing commands while Redis is down, so requests fall back to the database
    redisClient = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    let lastErrorLog = 0;
    redisClient.on("error", (error) => {
        // ioredis keeps reconnecting and emits an error each time; log at most once a minute
        if (Date.now() - lastErrorLog > 60_000) {
            lastErrorLog = Date.now();
            logger.warn({ err: error }, "Redis unavailable, product cache disabled until it reconnects");
        }
    });
}
const store: CacheStore = redisClient ? new RedisStore(redisClient) : new MemoryStore();

// Every cached key contains the current "version". Bumping the version (on any product or stock change)
// makes all old entries unreachable at once, without having to find and delete each one.
const VERSION_KEY = "products:version";

export const cachedProducts = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (CACHE_TTL_SECONDS <= 0) return load();

    let fullKey: string | null = null;
    try {
        const version = (await store.get(VERSION_KEY)) ?? "0";
        fullKey = `products:v${version}:${key}`;
        const hit = await store.get(fullKey);
        if (hit !== null) return JSON.parse(hit) as T;
    } catch (error) {
        logger.warn({ err: error }, "Cache read failed");
        fullKey = null;
    }

    const value = await load();
    if (fullKey) {
        store.set(fullKey, JSON.stringify(value), CACHE_TTL_SECONDS)
            .catch(error => logger.warn({ err: error }, "Cache write failed"));
    }
    return value;
};

// Call after anything that changes products or their stock (admin edits, orders, cancellations)
export const invalidateProductCache = async () => {
    try {
        await store.incr(VERSION_KEY);
    } catch (error) {
        logger.warn({ err: error }, "Cache invalidation failed");
    }
};

export const closeCache = async () => {
    await redisClient?.quit();
};
