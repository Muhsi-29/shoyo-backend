import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import { EMAIL_FROM, NODE_ENV, SMTP_HOST, SMTP_PASS, SMTP_PORT, SMTP_SECURE, SMTP_USER } from "../config.js";
import logger from "../logger.js";
import { enqueueJob } from "../jobs/queue.js";
import { escapeHtml, type Email } from "./templates.js";

// With SMTP settings in .env, emails are really sent (Gmail, Brevo, Mailtrap, SES...).
// Without them, each email is saved as an .html file in backend/outbox/ so you can open it in a browser.
export const OUTBOX_DIR = fileURLToPath(new URL("../../outbox", import.meta.url));

const transporter = SMTP_HOST
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        ...(SMTP_USER ? { auth: { user: SMTP_USER, pass: SMTP_PASS } } : {}),
    })
    : nodemailer.createTransport({ jsonTransport: true }); // Builds the message without sending it

// Emails "sent" during tests, so tests can check what would have gone out
export const testOutbox: Email[] = [];

const fileNameFor = (subject: string) =>
    `${Date.now()}-${subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)}.html`;

export const sendEmail = async (email: Email) => {
    await transporter.sendMail({ from: EMAIL_FROM, ...email });

    if (NODE_ENV === "test") {
        testOutbox.push(email);
    } else if (!SMTP_HOST) {
        fs.mkdirSync(OUTBOX_DIR, { recursive: true });
        const file = path.join(OUTBOX_DIR, fileNameFor(email.subject));
        const header = `<p style="font:13px monospace;background:#fef9c3;padding:8px;margin:0">To: ${escapeHtml(email.to)}<br>Subject: ${escapeHtml(email.subject)}</p>`;
        fs.writeFileSync(file, header + email.html);
        logger.info({ to: email.to, subject: email.subject, file }, "Email saved to outbox (SMTP not configured)");
    } else {
        logger.info({ to: email.to, subject: email.subject }, "Email sent");
    }
};

// Send in the background (with retries) so the API response doesn't wait for the mail server
export const queueEmail = (email: Email | null) => {
    if (email) enqueueJob(`email "${email.subject}"`, () => sendEmail(email));
};
