import { PORT } from "./config.js"; // Must stay the first import: it loads .env before other modules read it
import app from "./app.js";
import prisma from "./db.js";
import logger from "./logger.js";
import { closeCache } from "./cache.js";
import { enqueueJob, waitForJobs } from "./jobs/queue.js";
import { cancelStaleOnlineOrders } from "./services/orderService.js";
import { ensureAdminAccount } from "./services/accounts.js";

const server = app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
});

// Create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD, so a fresh deployment can be managed straight away
ensureAdminAccount()
    .then(email => email && logger.info(`Admin account ready: ${email}`))
    .catch(error => logger.error({ err: error }, "Could not create the admin account"));

// Scheduled background job: every 5 minutes, cancel online orders that were never paid so their stock is released
const cleanupTimer = setInterval(() => {
    enqueueJob("cancel unpaid online orders", async () => {
        await cancelStaleOnlineOrders();
    });
}, 5 * 60 * 1000);

// Graceful shutdown (Docker, Render and Ctrl+C send these signals): stop accepting requests,
// let queued jobs such as emails finish, then close the database and cache connections
const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    clearInterval(cleanupTimer);
    server.close(async () => {
        await waitForJobs(5_000);
        await prisma.$disconnect();
        await closeCache();
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref(); // Don't hang forever on stuck connections
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
