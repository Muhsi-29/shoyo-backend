import pino from "pino";
import { LOG_LEVEL, NODE_ENV } from "./config.js";

// App-wide logger. In development it prints readable, colored lines; everywhere else it writes one
// JSON object per line, which log services (Render, Railway, Datadog...) can search and filter.
const logger = pino({
    level: LOG_LEVEL,
    ...(NODE_ENV === "development"
        ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } } }
        : {}),
    // Never write secrets to the logs, even if someone logs a whole request or user object
    redact: ["req.headers.authorization", "req.headers.cookie", "password", "*.password"],
});

export default logger;
