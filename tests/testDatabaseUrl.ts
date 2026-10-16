import dotenv from "dotenv";

// Tests run against their own database, so they can wipe tables freely without touching your data.
// It's TEST_DATABASE_URL if set, otherwise DATABASE_URL with the database name changed to "ecommerce_test".
dotenv.config({ quiet: true });

const resolveTestDatabaseUrl = () => {
    if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
    if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL (or TEST_DATABASE_URL) before running tests");

    const url = new URL(process.env.DATABASE_URL);
    url.pathname = "/ecommerce_test";
    return url.toString();
};

export const TEST_DATABASE_URL = resolveTestDatabaseUrl();

if (TEST_DATABASE_URL === process.env.DATABASE_URL) {
    throw new Error("The test database must be different from DATABASE_URL: tests delete all data in it");
}
