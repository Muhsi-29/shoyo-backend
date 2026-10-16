-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('FULL', 'SUPPORT', 'CATALOG');

-- CreateEnum
CREATE TYPE "BannerTheme" AS ENUM ('EMERALD', 'NAVY', 'PEACH', 'LAVENDER', 'ROSE', 'SKY');

-- CreateEnum
CREATE TYPE "BannerLayout" AS ENUM ('SPLIT', 'COVER');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "blockedAt" TIMESTAMP(3),
ADD COLUMN     "blockedReason" TEXT,
ADD COLUMN     "staffRole" "StaffRole";

-- CreateTable
CREATE TABLE "StoreSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "deliveryFee" DOUBLE PRECISION NOT NULL,
    "freeDeliveryThreshold" DOUBLE PRECISION NOT NULL,
    "returnWindowDays" INTEGER NOT NULL,
    "defaultCommissionRate" DOUBLE PRECISION NOT NULL,
    "codEnabled" BOOLEAN NOT NULL DEFAULT true,
    "stripeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "razorpayEnabled" BOOLEAN NOT NULL DEFAULT true,
    "announcements" TEXT[],
    "announceCoupons" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Banner" (
    "id" SERIAL NOT NULL,
    "eyebrow" TEXT,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "ctaLabel" TEXT NOT NULL,
    "ctaLink" TEXT NOT NULL,
    "image" TEXT,
    "theme" "BannerTheme" NOT NULL DEFAULT 'EMERALD',
    "layout" "BannerLayout" NOT NULL DEFAULT 'SPLIT',
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Banner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminActivity" (
    "id" SERIAL NOT NULL,
    "adminId" INTEGER,
    "adminName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" INTEGER,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Banner_active_position_idx" ON "Banner"("active", "position");

-- CreateIndex
CREATE INDEX "AdminActivity_createdAt_idx" ON "AdminActivity"("createdAt");

-- CreateIndex
CREATE INDEX "AdminActivity_adminId_idx" ON "AdminActivity"("adminId");

-- AddForeignKey
ALTER TABLE "AdminActivity" ADD CONSTRAINT "AdminActivity_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Existing admins keep full access
UPDATE "User" SET "staffRole" = 'FULL' WHERE "role" = 'ADMIN';

-- The homepage slides that used to be built into the storefront, now editable in the admin panel.
-- {maxDiscount} is replaced with the biggest current discount when the banner is shown.
INSERT INTO "Banner" ("eyebrow", "title", "subtitle", "ctaLabel", "ctaLink", "theme", "layout", "position", "updatedAt") VALUES
  ('Today''s deals', 'Up to {maxDiscount}% off top brands', 'Fresh discounts every day on gadgets, fashion, home and more.', 'Shop deals', '/products?sort=discount', 'EMERALD', 'SPLIT', 1, CURRENT_TIMESTAMP),
  ('Electronics', 'Gadgets you''ll love', 'Phones, laptops and audio from brands you trust, delivered fast.', 'Explore gadgets', '/products?category=Electronics', 'NAVY', 'SPLIT', 2, CURRENT_TIMESTAMP),
  ('Fashion & footwear', 'Style that ships to your door', 'Watches, bags, sneakers and more from Shoyo and independent sellers.', 'Shop fashion', '/products?category=Fashion', 'PEACH', 'SPLIT', 3, CURRENT_TIMESTAMP),
  ('For sellers', 'Open your store on Shoyo', 'List your products, ship orders and get paid to your UPI. Apply in minutes.', 'Start selling', '/sell', 'LAVENDER', 'SPLIT', 4, CURRENT_TIMESTAMP);
