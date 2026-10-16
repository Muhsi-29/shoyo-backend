import logger from "../logger.js";

// A small in-process background job queue. Work like sending emails is queued here instead of being
// done inside the request, so a slow or failing mail server never delays (or breaks) an API response.
// Jobs run one at a time, and a failed job is retried with a growing delay.
// To spread jobs across several servers you'd replace this with a Redis-backed queue such as BullMQ.

interface Job {
    name: string;
    run: () => Promise<void>;
    attempt: number;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 5_000]; // Wait before the 2nd and 3rd attempts

const queue: Job[] = [];
let processing = false;
let unfinished = 0; // Jobs queued, running, or waiting to be retried

const processQueue = async () => {
    if (processing) return;
    processing = true;

    while (queue.length > 0) {
        const job = queue.shift()!;
        try {
            await job.run();
            unfinished--;
        } catch (error) {
            if (job.attempt < MAX_ATTEMPTS) {
                const delay = RETRY_DELAYS_MS[job.attempt - 1] ?? 5_000;
                logger.warn({ err: error, job: job.name, attempt: job.attempt }, `Job failed, retrying in ${delay / 1000}s`);
                setTimeout(() => {
                    queue.push({ ...job, attempt: job.attempt + 1 });
                    void processQueue();
                }, delay).unref();
            } else {
                unfinished--;
                logger.error({ err: error, job: job.name }, `Job failed after ${MAX_ATTEMPTS} attempts`);
            }
        }
    }

    processing = false;
};

export const enqueueJob = (name: string, run: () => Promise<void>) => {
    queue.push({ name, run, attempt: 1 });
    unfinished++;
    void processQueue();
};

// Resolves once every queued job has finished, or after the timeout (used by tests and on shutdown)
export const waitForJobs = async (timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (unfinished > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};
