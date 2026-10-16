import type { Request, Response } from "express";
import prisma from "../db.js";
import { queueEmail } from "../emails/mailer.js";
import { contactMessageEmail, newsletterWelcomeEmail } from "../emails/templates.js";
import { CURRENCY, PLATFORM_SELLER_NAME, RAZORPAY_KEY_ID, SUPPORT_EMAIL, WAREHOUSE_PINCODE } from "../config.js";
import { deliveryWindow } from "../services/deliveryService.js";
import { announcementLines, getSettings, paymentOptions } from "../services/settingsService.js";
import { HttpError } from "../utils/httpError.js";
import { contactSchema, deliveryEstimateQuerySchema, newsletterSchema } from "../validation/schemas.js";

// GET /config: store settings the website needs (which payment options to show, delivery rules, offers bar...)
export const getConfig = async (req: Request, res: Response) => {
    const settings = await getSettings();
    const payments = paymentOptions(settings);
    res.status(200).json({
        status: "success",
        data: {
            currency: CURRENCY.toUpperCase(),
            payments,
            razorpayKeyId: payments.razorpay ? RAZORPAY_KEY_ID : null, // The key ID is public; the secret never leaves the server
            delivery: { fee: settings.deliveryFee, freeThreshold: settings.freeDeliveryThreshold },
            returnWindowDays: settings.returnWindowDays,
            sellerCommissionRate: settings.defaultCommissionRate,
            platformSellerName: PLATFORM_SELLER_NAME,
            announcements: await announcementLines(settings),
        },
    });
};

// GET /delivery/estimate?pincode=682001&productId=12: when an order would arrive at that PIN code
export const estimateDelivery = async (req: Request, res: Response) => {
    const { pincode, productId } = deliveryEstimateQuerySchema.parse(req.query);
    let fromPincode = WAREHOUSE_PINCODE;
    if (productId) {
        const product = await prisma.product.findUnique({ where: { id: productId }, include: { seller: { select: { pickupPincode: true } } } });
        if (!product) throw new HttpError(404, "Product not found");
        fromPincode = product.seller?.pickupPincode ?? WAREHOUSE_PINCODE;
    }
    const settings = await getSettings();
    res.status(200).json({
        status: "success",
        data: {
            pincode,
            ...deliveryWindow(fromPincode, pincode),
            codAvailable: settings.codEnabled,
            deliveryFee: settings.deliveryFee,
            freeDeliveryThreshold: settings.freeDeliveryThreshold,
        },
    });
};

// POST /newsletter { email }
export const subscribeNewsletter = async (req: Request, res: Response) => {
    const { email } = newsletterSchema.parse(req.body ?? {});
    const existing = await prisma.newsletterSubscriber.findUnique({ where: { email } });
    if (!existing) {
        await prisma.newsletterSubscriber.create({ data: { email } });
        queueEmail(newsletterWelcomeEmail(email));
    }
    res.status(200).json({ status: "success", message: "You're subscribed! Watch your inbox for offers." });
};

// POST /contact { name, email, subject, message }: saved, and emailed to the support team
export const sendContactMessage = async (req: Request, res: Response) => {
    const input = contactSchema.parse(req.body ?? {});
    await prisma.contactMessage.create({ data: input });
    queueEmail(contactMessageEmail(SUPPORT_EMAIL, input));
    res.status(201).json({ status: "success", message: "Thanks! We've received your message and will reply within 1-2 working days." });
};
