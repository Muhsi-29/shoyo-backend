import Stripe from "stripe";
import { STRIPE_SECRET_KEY } from "./config.js";

// One shared Stripe client for the whole app (like db.ts does for Prisma)
const stripe = new Stripe(STRIPE_SECRET_KEY);

export default stripe;
