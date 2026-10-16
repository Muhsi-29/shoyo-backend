import { execSync } from "child_process";
import { TEST_DATABASE_URL } from "./testDatabaseUrl.js";

// Runs once before all tests: creates the test database if needed and applies every migration to it
export default function setup() {
    execSync("npx prisma migrate deploy", {
        env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
        stdio: "pipe",
    });
}
