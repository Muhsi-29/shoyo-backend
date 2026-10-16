import { z } from "zod";
import { OrderStatus } from "@prisma/client";

// Every request body, query string and URL parameter is checked against one of these schemas before use.
// A failed check throws a ZodError, which the error handler in app.ts turns into a 400 response
// listing each invalid field.

const MAX_INT = 2147483647; // Largest value a Postgres INTEGER column can hold

// Query strings send "" for empty inputs (?minPrice=); treat that as "not provided"
const optional = <T extends z.ZodType>(schema: T) =>
    z.preprocess(value => (value === "" ? undefined : value), schema.optional());

const requiredText = (max: number) =>
    z.string({ error: "is required" }).trim().min(1, "is required").max(max, `must be at most ${max} characters`);

const optionalText = (max: number) =>
    z.preprocess(
        value => (typeof value === "string" && value.trim() === "" ? undefined : value),
        z.string().trim().max(max, `must be at most ${max} characters`).optional()
    );

const email = z.string({ error: "is required" }).trim().toLowerCase().pipe(z.email("must be a valid email address"));

// bcrypt only uses the first 72 bytes of a password
const newPassword = z.string({ error: "is required" }).min(8, "must be at least 8 characters").max(72, "must be at most 72 characters");

export const idSchema = z.coerce.number({ error: "must be a number" })
    .int("must be a whole number").positive("must be positive").max(MAX_INT, "is too large");

const quantity = z.coerce.number({ error: "must be a number" })
    .int("must be a whole number").min(1, "must be at least 1").max(100, "can't be more than 100");

const rating = z.coerce.number({ error: "must be a number" }).int("must be a whole number").min(1, "must be 1 to 5").max(5, "must be 1 to 5");

const phone = z.string({ error: "is required" }).trim().regex(/^[0-9+\-\s()]{7,20}$/, "must be a valid phone number");

// Indian PIN codes: 6 digits, not starting with 0
const pincode = z.string({ error: "is required" }).trim().regex(/^[1-9][0-9]{5}$/, "must be a valid 6-digit PIN code");

const upiId = z.string({ error: "is required" }).trim().regex(/^[\w.-]{2,256}@[a-zA-Z]{2,64}$/, "must be a valid UPI ID (like name@bank)");

const booleanFlag = z.preprocess(value => (value === "true" ? true : value === "false" ? false : value), z.boolean());

// ---------- Auth and account ----------

export const registerSchema = z.object({
    name: requiredText(100),
    email,
    password: newPassword,
});

// An admin creating another admin also picks what they can do
export const adminRegisterSchema = registerSchema.extend({
    staffRole: z.enum(["FULL", "SUPPORT", "CATALOG"], { error: "must be FULL, SUPPORT or CATALOG" }).optional(),
});

export const loginSchema = z.object({
    email,
    password: z.string({ error: "is required" }).min(1, "is required"),
});

export const profileSchema = z.object({
    name: requiredText(100),
});

export const changePasswordSchema = z.object({
    currentPassword: z.string({ error: "is required" }).min(1, "is required"),
    newPassword,
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
    token: z.string({ error: "is required" }).trim().min(20, "is invalid").max(200, "is invalid"),
    password: newPassword,
});

const addressFields = {
    fullName: requiredText(100),
    phone,
    line1: requiredText(200),
    line2: optionalText(200),
    city: requiredText(100),
    state: requiredText(100),
    postalCode: pincode,
};

export const shippingAddressSchema = z.object(addressFields, { error: "is required" });

export const addressSchema = z.object({
    ...addressFields,
    label: optionalText(30),
    isDefault: optional(booleanFlag),
});

// ---------- Products ----------

// Specs arrive as an array from JSON requests, or as a JSON string from form-data uploads
const specs = z.preprocess(
    value => {
        if (typeof value !== "string") return value;
        try { return JSON.parse(value); } catch { return value; }
    },
    z.array(z.object({ label: requiredText(50), value: requiredText(200) }), { error: "must be a list of { label, value }" })
        .max(20, "can have at most 20 rows")
);

const productFields = {
    title: requiredText(200),
    brand: optionalText(60),
    price: z.coerce.number({ error: "must be a number" }).positive("must be greater than 0").max(10_000_000, "is too large"),
    mrp: optional(z.coerce.number({ error: "must be a number" }).positive("must be greater than 0").max(10_000_000, "is too large")),
    description: requiredText(5000),
    category: requiredText(100),
    stock: z.coerce.number({ error: "must be a number" }).int("must be a whole number").min(0, "can't be negative").max(1_000_000, "is too large"),
    specs: optional(specs),
};

// Form-data sends every field as text, hence z.coerce for numbers
export const productCreateSchema = z.object(productFields).refine(
    p => p.mrp === undefined || p.mrp >= p.price,
    { message: "can't be lower than the price", path: ["mrp"] }
);

export const productUpdateSchema = z.object(productFields).partial().extend({
    // An edit can clear these by sending ""
    brand: z.string().trim().max(60, "must be at most 60 characters").optional(),
    mrp: z.union([
        z.literal(""),
        z.coerce.number({ error: "must be a number" }).positive("must be greater than 0").max(10_000_000, "is too large"),
    ]).optional(),
    // Lets an admin point to an image URL instead of uploading a file
    image: z.string().trim().regex(/^(https?:\/\/|\/uploads\/)/, "must be an http(s) URL or an /uploads/ path").max(500).optional(),
});

export const productQuerySchema = z.object({
    q: optional(z.string().trim().max(100)),
    category: optional(z.string().trim().max(100)),
    brand: optional(z.string().trim().max(500)), // Comma-separated: "Apple,Samsung"
    minPrice: optional(z.coerce.number({ error: "must be a number" }).min(0, "can't be negative")),
    maxPrice: optional(z.coerce.number({ error: "must be a number" }).min(0, "can't be negative")),
    minRating: optional(z.coerce.number({ error: "must be a number" }).int().min(1, "must be 1 to 4").max(4, "must be 1 to 4")),
    minDiscount: optional(z.coerce.number({ error: "must be a number" }).int().min(1, "must be 1 to 90").max(90, "must be 1 to 90")),
    inStock: optional(booleanFlag),
    sort: optional(z.enum(["newest", "popularity", "rating", "discount", "price_asc", "price_desc", "name_asc"], {
        error: "must be newest, popularity, rating, discount, price_asc, price_desc or name_asc",
    })).transform(sort => sort ?? "newest"),
    page: optional(z.coerce.number().int().min(1, "must be at least 1")).transform(page => page ?? 1),
    limit: optional(z.coerce.number().int().min(1).max(100, "can't be more than 100")).transform(limit => limit ?? 12),
});

export const suggestQuerySchema = z.object({
    q: z.string({ error: "is required" }).trim().min(1, "is required").max(50, "is too long"),
});

export const productModerationSchema = z.object({
    status: z.enum(["ACTIVE", "REJECTED"], { error: "must be ACTIVE or REJECTED" }),
    reason: optionalText(300),
});

export const adminProductQuerySchema = z.object({
    status: optional(z.enum(["PENDING", "ACTIVE", "REJECTED"], { error: "must be PENDING, ACTIVE or REJECTED" })),
    q: optional(z.string().trim().max(100)),
    page: optional(z.coerce.number().int().min(1)).transform(page => page ?? 1),
    limit: optional(z.coerce.number().int().min(1).max(100)).transform(limit => limit ?? 20),
});

// ---------- Reviews ----------

export const reviewSchema = z.object({
    rating,
    title: optionalText(100),
    comment: requiredText(2000),
});

export const reviewQuerySchema = z.object({
    sort: optional(z.enum(["helpful", "newest", "highest", "lowest"])).transform(sort => sort ?? "helpful"),
    page: optional(z.coerce.number().int().min(1)).transform(page => page ?? 1),
});

// ---------- Cart and wishlist ----------

export const cartItemSchema = z.object({
    productId: idSchema,
    quantity: optional(quantity).transform(q => q ?? 1),
});

export const cartQuantitySchema = z.object({ quantity });

export const saveForLaterSchema = z.object({ saved: booleanFlag });

// A guest's cart (kept in the browser) is merged into their account cart when they log in
export const cartMergeSchema = z.object({
    items: z.array(z.object({ productId: idSchema, quantity })).max(100),
});

export const wishlistSchema = z.object({ productId: idSchema });

// ---------- Orders ----------

const couponCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,30}$/, "must be 3-30 letters or numbers");

export const placeOrderSchema = z.object({
    // Optional: when left out, the order is made from the user's cart
    items: z.array(z.object({ productId: idSchema, quantity })).min(1, "must not be empty").max(100).optional(),
    shippingAddress: shippingAddressSchema,
    couponCode: optional(couponCode),
});

export const couponValidateSchema = z.object({ code: couponCode });

export const confirmCheckoutSchema = z.object({
    sessionId: requiredText(255),
});

export const razorpayVerifySchema = z.object({
    orderId: idSchema,
    razorpayOrderId: requiredText(100),
    razorpayPaymentId: requiredText(100),
    razorpaySignature: requiredText(200),
});

export const orderListQuerySchema = z.object({
    status: optional(z.enum(OrderStatus, { error: `must be one of ${Object.values(OrderStatus).join(", ")}` })),
});

export const shipmentUpdateSchema = z.object({
    status: z.enum(["SHIPPED", "DELIVERED", "CANCELLED"], { error: "must be SHIPPED, DELIVERED or CANCELLED" }),
    courier: optionalText(60),
    trackingNumber: optionalText(60),
    reason: optionalText(300),
});

export const sellerRatingSchema = z.object({
    rating,
    feedback: optionalText(500),
});

export const RETURN_REASONS = ["DAMAGED", "WRONG_ITEM", "NOT_AS_DESCRIBED", "NO_LONGER_NEEDED", "OTHER"] as const;

export const returnRequestSchema = z.object({
    reason: z.enum(RETURN_REASONS, { error: `must be one of ${RETURN_REASONS.join(", ")}` }),
    comment: optionalText(500),
    refundUpi: optional(upiId),
});

export const returnResolveSchema = z.object({
    action: z.enum(["approve", "reject"], { error: "must be approve or reject" }),
    note: optionalText(300),
});

// ---------- Sellers ----------

const gstin = z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "must be a valid 15-character GSTIN");

const sellerFields = {
    storeName: requiredText(60),
    description: optionalText(500),
    phone,
    gstin: optional(gstin),
    pickupAddress: z.object({
        line1: requiredText(200),
        city: requiredText(100),
        state: requiredText(100),
        postalCode: pincode,
    }, { error: "is required" }),
    payoutUpi: upiId,
};

export const sellerApplySchema = z.object(sellerFields);
export const sellerUpdateSchema = z.object(sellerFields).partial().extend({
    // Store settings can clear these by sending ""
    description: z.string().trim().max(500, "must be at most 500 characters").optional(),
    gstin: z.union([z.literal(""), gstin]).optional(),
});

export const adminSellerUpdateSchema = z.object({
    status: optional(z.enum(["APPROVED", "REJECTED", "SUSPENDED"], { error: "must be APPROVED, REJECTED or SUSPENDED" })),
    reason: optionalText(300),
    // 0.08 = 8%. null goes back to the platform default.
    commissionRate: z.number({ error: "must be a number" }).min(0, "can't be negative").max(0.5, "can't be more than 0.5").nullable().optional(),
});

// Admin lists: optional search and page
export const adminListQuerySchema = z.object({
    q: optional(z.string().trim().max(100)),
    rating: optional(z.coerce.number().int().min(1).max(5)),
    page: optional(z.coerce.number().int().min(1)).transform(page => page ?? 1),
    limit: optional(z.coerce.number().int().min(1).max(100)).transform(limit => limit ?? 20),
});

// A calendar day like 2026-10-17 (the order filters' "from" and "to")
const day = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date like 2026-10-17")
    .refine(value => !Number.isNaN(Date.parse(value)), "must be a real date");

// Filters shared by the admin orders list and its CSV export
const adminOrderFilters = {
    status: optional(z.enum(OrderStatus, { error: `must be one of ${Object.values(OrderStatus).join(", ")}` })),
    q: optional(z.string().trim().max(100)), // Order number, or customer name/email
    paymentMethod: optional(z.enum(["STRIPE", "RAZORPAY", "COD"], { error: "must be STRIPE, RAZORPAY or COD" })),
    seller: optional(z.union([z.literal("shoyo"), z.coerce.number().int().positive().max(MAX_INT)], { error: "must be a seller ID or shoyo" })),
    from: optional(day),
    to: optional(day),
};

export const adminOrderQuerySchema = z.object({
    ...adminOrderFilters,
    page: optional(z.coerce.number().int().min(1)).transform(page => page ?? 1),
    limit: optional(z.coerce.number().int().min(1).max(100)).transform(limit => limit ?? 20),
}).refine(f => !f.from || !f.to || f.from <= f.to, { message: "must be on or after the start date", path: ["to"] });

export const adminOrderExportSchema = z.object(adminOrderFilters)
    .refine(f => !f.from || !f.to || f.from <= f.to, { message: "must be on or after the start date", path: ["to"] });

export const sellerListQuerySchema = z.object({
    status: optional(z.enum(["PENDING", "APPROVED", "REJECTED", "SUSPENDED"])),
});

export const payoutSchema = z.object({
    amount: z.coerce.number({ error: "must be a number" }).positive("must be greater than 0").max(10_000_000, "is too large"),
    reference: optionalText(100),
});

// ---------- Coupons ----------

const couponFields = {
    code: couponCode,
    description: requiredText(200),
    type: z.enum(["PERCENT", "FLAT"], { error: "must be PERCENT or FLAT" }),
    value: z.coerce.number({ error: "must be a number" }).positive("must be greater than 0").max(100_000, "is too large"),
    minOrderAmount: optional(z.coerce.number().min(0, "can't be negative")).transform(v => v ?? 0),
    maxDiscount: optional(z.coerce.number().positive("must be greater than 0")).nullable(),
    usageLimit: optional(z.coerce.number().int().min(1, "must be at least 1")).nullable(),
    expiresAt: optional(z.coerce.date({ error: "must be a date" })).nullable(),
    active: optional(z.boolean()).transform(v => v ?? true),
};

export const couponCreateSchema = z.object(couponFields).refine(
    c => c.type !== "PERCENT" || c.value <= 90,
    { message: "a percentage can't be more than 90", path: ["value"] }
);

export const couponUpdateSchema = z.object({
    active: z.boolean().optional(),
    description: requiredText(200).optional(),
    expiresAt: z.coerce.date({ error: "must be a date" }).nullable().optional(),
    usageLimit: z.coerce.number().int().min(1).nullable().optional(),
});

// ---------- Delivery and site ----------

export const deliveryEstimateQuerySchema = z.object({
    pincode,
    productId: optional(idSchema),
});

export const newsletterSchema = z.object({ email });

export const contactSchema = z.object({
    name: requiredText(100),
    email,
    subject: requiredText(150),
    message: z.string({ error: "is required" }).trim().min(10, "must be at least 10 characters").max(3000, "must be at most 3000 characters"),
});

// ---------- URL parameters ----------

export const idParamsSchema = z.object({ id: idSchema });
export const productIdParamsSchema = z.object({ productId: idSchema });
export const slugParamsSchema = z.object({ slug: z.string().trim().regex(/^[a-z0-9-]{1,80}$/, "is invalid") });

export type ShippingAddress = z.infer<typeof shippingAddressSchema>;
export type OrderItemInput = { productId: number; quantity: number };
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;

// ---------- Admin: store settings, homepage, people, activity ----------

const money = (max: number) => z.coerce.number({ error: "must be a number" }).min(0, "can't be negative").max(max, "is too large");

export const settingsUpdateSchema = z.object({
    deliveryFee: money(10_000).optional(),
    freeDeliveryThreshold: money(1_000_000).optional(),
    returnWindowDays: z.coerce.number({ error: "must be a number" }).int("must be a whole number").min(1, "must be at least 1 day").max(60, "can be at most 60 days").optional(),
    defaultCommissionRate: z.number({ error: "must be a number" }).min(0, "can't be negative").max(0.5, "can't be more than 50%").optional(),
    codEnabled: z.boolean({ error: "must be true or false" }).optional(),
    stripeEnabled: z.boolean({ error: "must be true or false" }).optional(),
    razorpayEnabled: z.boolean({ error: "must be true or false" }).optional(),
    announcements: z.array(requiredText(120), { error: "must be a list of messages" }).max(8, "can have at most 8 messages").optional(),
    announceCoupons: z.boolean({ error: "must be true or false" }).optional(),
});

// "" clears a date (e.g. removes a banner's end date)
const clearableDate = z.preprocess(
    value => (value === "" || value === "null" ? null : value),
    z.coerce.date({ error: "must be a date" }).nullable()
).optional();

// Banner buttons go to a page of the store ("/products?sort=discount") or a secure external link
const bannerLink = z.string({ error: "is required" }).trim().min(1, "is required").max(300, "must be at most 300 characters")
    .refine(
        value => (value.startsWith("/") && !value.startsWith("//")) || /^https:\/\/[^\s]+$/.test(value),
        "must be a store page starting with / (like /products?category=Fashion) or an https:// link"
    );

const bannerFields = {
    eyebrow: z.string().trim().max(40, "must be at most 40 characters").optional(),   // "" clears
    title: requiredText(90),
    subtitle: z.string().trim().max(180, "must be at most 180 characters").optional(), // "" clears
    ctaLabel: requiredText(30),
    ctaLink: bannerLink,
    theme: z.enum(["EMERALD", "NAVY", "PEACH", "LAVENDER", "ROSE", "SKY"], { error: "isn't one of the colour themes" }).optional(),
    layout: z.enum(["SPLIT", "COVER"], { error: "must be SPLIT or COVER" }).optional(),
    active: optional(booleanFlag),
    startsAt: clearableDate,
    endsAt: clearableDate,
};

const endsAfterStarts = (b: { startsAt?: Date | null | undefined; endsAt?: Date | null | undefined }) => !b.startsAt || !b.endsAt || b.endsAt > b.startsAt;

export const bannerCreateSchema = z.object(bannerFields)
    .refine(endsAfterStarts, { message: "must be after the start date", path: ["endsAt"] });

export const bannerUpdateSchema = z.object(bannerFields).partial().extend({
    removeImage: optional(booleanFlag), // Go back to showing products instead of a picture
}).refine(endsAfterStarts, { message: "must be after the start date", path: ["endsAt"] });

export const bannerReorderSchema = z.object({
    ids: z.array(idSchema, { error: "must be a list of banner IDs" }).min(1, "can't be empty").max(100, "is too long"),
});

export const customerUpdateSchema = z.object({
    blocked: z.boolean({ error: "must be true or false" }),
    reason: optionalText(300),
});

export const adminUpdateSchema = z.object({
    staffRole: z.enum(["FULL", "SUPPORT", "CATALOG"], { error: "must be FULL, SUPPORT or CATALOG" }),
});

export const activityQuerySchema = z.object({
    adminId: optional(idSchema),
    area: optional(z.enum(["order", "product", "seller", "customer", "return", "coupon", "banner", "admin", "settings", "review"], { error: "isn't a known area" })),
    q: optional(z.string().trim().max(100)),
    page: optional(z.coerce.number().int().min(1)).transform(page => page ?? 1),
    limit: optional(z.coerce.number().int().min(1).max(100)).transform(limit => limit ?? 30),
});
