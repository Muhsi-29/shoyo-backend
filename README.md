# Shoyo API (backend)

The REST API behind the Shoyo marketplace. One backend serves two separate frontends:

```
Project_Resume/
  backend/             <- this project: Express + PostgreSQL API on http://localhost:5000
  E-Commerce Website/  <- storefront for shoppers and sellers, http://localhost:5173
  Admin-Panel/         <- admin panel, http://localhost:5174
```

**Stack:** Node 22, Express 5, TypeScript, Prisma 7 + PostgreSQL 17 (pg_trgm for typo-tolerant search), zod validation,
JWT auth, Stripe + Razorpay payments, Redis (optional) caching, pino logging, Vitest + Supertest.

## First-time setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill it in. `DATABASE_URL` and `JWT_SECRET` are required; set `ADMIN_EMAIL` / `ADMIN_PASSWORD` for an admin login.
3. `npx prisma migrate deploy` creates the tables (and the `pg_trgm` extension).
4. `npx prisma db seed` adds sample products with photos, a demo seller store, coupons, and the logins from `.env`.
   Safe to re-run: nothing is duplicated.

## Run

| What | Command | Address |
|---|---|---|
| API | `npm run dev` | http://localhost:5000/api/v1 (health: `/api/v1/health`) |
| Database viewer | `npx prisma studio` | opens in the browser |
| Storefront | `npm run dev` in `../E-Commerce Website` | http://localhost:5173 |
| Admin panel | `npm run dev` in `../Admin-Panel` | http://localhost:5174 |

The API allows browser requests from `CLIENT_URL` and `ADMIN_URL` (or the list in `CORS_ORIGINS`).

## Logins

All logins live in `.env` (they're created or updated when the API starts and when you run the seed):

| Account | Variables | Where to sign in |
|---|---|---|
| Admin | `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Admin panel |
| Demo shopper | `DEMO_BUYER_EMAIL` / `DEMO_BUYER_PASSWORD` | Storefront |
| Demo seller ("Urban Trend Co.") | `DEMO_SELLER_EMAIL` / `DEMO_SELLER_PASSWORD` | Storefront, then **Seller dashboard** |

To change a password, edit it in `.env` and run `npx prisma db seed`. Anyone can also register on the storefront and apply to sell.

## Tests

`npm test` runs the API tests against a separate `ecommerce_test` database (created automatically, your data is never touched).
`npm run typecheck` checks the TypeScript.

## What the API does

- **Catalogue:** products with brand, MRP and discount, gallery, specs; search with autocomplete (`/products/suggest`), typo tolerance and filters (category, brand, price, rating, discount, stock).
- **Shoppers:** accounts, password reset by email, saved addresses, cart with save-for-later, wishlist, coupons, delivery estimates by PIN code.
- **Orders:** cash on delivery, Stripe Checkout and Razorpay (UPI); orders split into one shipment per seller with tracking; cancellations and refunds; returns within `RETURN_WINDOW_DAYS`.
- **Reviews:** verified-buyer ratings and reviews with helpful votes; buyers also rate sellers after delivery.
- **Marketplace:** shoppers apply to sell; admins approve, suspend and set commission; sellers list products (moderated), ship orders, handle returns and see earnings; admins record payouts.
- **Admin:** dashboard stats and sales chart, orders, products, sellers, customers, returns, coupons, reviews, messages and newsletter subscribers.

All routes are under `/api/v1`. See `src/routes/` for the full list.

## Payments

- **Stripe (cards, test mode):** put a `sk_test_...` key in `STRIPE_SECRET_KEY`, then pay with card `4242 4242 4242 4242`, any future date and CVC.
  For webhooks: `stripe listen --forward-to localhost:5000/api/v1/webhook/stripe` and put the printed `whsec_...` in `STRIPE_WEBHOOK_SECRET`.
- **Razorpay (UPI):** set `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (test keys), and `RAZORPAY_WEBHOOK_SECRET` for a webhook at `/api/v1/webhook/razorpay`.
- Payment options the storefront shows come from `/api/v1/config`; without keys only cash on delivery is offered.

## Emails

Without SMTP settings, emails (welcome, password reset, invoices, shipping updates, seller notices...) are saved as `.html`
files in `outbox/`. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `EMAIL_FROM` to really send them.

## Docker

With Docker Desktop running, from this folder:

```
docker compose up --build
```

Storefront http://localhost:8080, admin panel http://localhost:8081, API http://localhost:5000/api/v1.
PostgreSQL and Redis run in containers too. Sample data: `docker compose exec backend npx prisma db seed`.

## Deploy (Render)

Each project has its own `render.yaml`. Deploy this one first (database, Redis, API), then the storefront and admin panel
as static sites pointing `VITE_API_URL` at the API. Set `CLIENT_URL` and `ADMIN_URL` on the API to the two site URLs.

Uploaded product images are stored on the server's disk, which Render's free plan wipes on each deploy; for real use add a
disk or move uploads to a storage service.

## CI

`.github/workflows/ci.yml` typechecks, tests (against a real PostgreSQL) and builds the API on every push and pull request.
