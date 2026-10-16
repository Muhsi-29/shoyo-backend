import type { Prisma, ProductStatus } from "@prisma/client";
import type { Request } from "express";
import prisma from "../db.js";
import { invalidateProductCache } from "../cache.js";
import { deleteUploadedImage, discardUpload, uploadedFiles } from "../middlewares/uploadMiddleware.js";
import { HttpError } from "../utils/httpError.js";
import { productCreateSchema, productUpdateSchema } from "../validation/schemas.js";
import { discountPercentFor } from "./productService.js";

// Creating, editing and deleting products, shared by the admin (Shoyo's own products) and sellers (their own).

// Creates a product from a form-data request: fields plus a main image and optional gallery photos
export const createProductFromRequest = async (req: Request, { sellerId, status }: { sellerId: number | null; status: ProductStatus }) => {
    try {
        const { image, gallery } = uploadedFiles(req);
        if (!image) {
            throw HttpError.field("image", "is required");
        }
        const input = productCreateSchema.parse(req.body ?? {});
        const product = await prisma.product.create({
            data: {
                title: input.title,
                brand: input.brand ?? null,
                price: input.price,
                mrp: input.mrp ?? null,
                discountPercent: discountPercentFor(input.price, input.mrp),
                description: input.description,
                category: input.category,
                stock: input.stock,
                ...(input.specs ? { specs: input.specs } : {}),
                image: `/uploads/${image.filename}`,
                images: gallery.map(file => `/uploads/${file.filename}`),
                status,
                sellerId,
            },
        });
        await invalidateProductCache();
        return product;
    } catch (error) {
        discardUpload(req); // Don't keep the photos of a product that wasn't saved
        throw error;
    }
};

// Applies an edit (JSON, or form-data with new photos). With sellerId, only that seller's products can be
// edited, and a rejected product goes back to the admin for another review.
export const updateProductFromRequest = async (req: Request, productId: number, { sellerId }: { sellerId?: number } = {}) => {
    try {
        const input = productUpdateSchema.parse(req.body ?? {});
        const existing = await prisma.product.findUnique({ where: { id: productId } });
        if (!existing || (sellerId !== undefined && existing.sellerId !== sellerId)) {
            throw new HttpError(404, "Product not found");
        }

        const price = input.price ?? existing.price;
        const mrp = input.mrp === "" ? null : input.mrp ?? existing.mrp; // "" removes the MRP
        if (mrp !== null && mrp < price) {
            throw HttpError.field("mrp", "can't be lower than the price");
        }

        const { image, gallery } = uploadedFiles(req);
        const data: Prisma.ProductUpdateInput = { discountPercent: discountPercentFor(price, mrp) };
        if (input.title !== undefined) data.title = input.title;
        if (input.brand !== undefined) data.brand = input.brand || null;
        if (input.price !== undefined) data.price = input.price;
        if (input.mrp !== undefined) data.mrp = mrp;
        if (input.description !== undefined) data.description = input.description;
        if (input.category !== undefined) data.category = input.category;
        if (input.stock !== undefined) data.stock = input.stock;
        if (input.specs !== undefined) data.specs = input.specs;
        if (image) data.image = `/uploads/${image.filename}`;
        else if (input.image !== undefined) data.image = input.image;
        if (gallery.length > 0) data.images = gallery.map(file => `/uploads/${file.filename}`); // New gallery replaces the old one
        if (sellerId !== undefined && existing.status === "REJECTED") {
            data.status = "PENDING";
            data.rejectionReason = null;
        }

        const updated = await prisma.product.update({ where: { id: productId }, data });
        if (updated.image !== existing.image) deleteUploadedImage(existing.image); // Old files are no longer used
        if (gallery.length > 0) existing.images.forEach(deleteUploadedImage);
        await invalidateProductCache();
        return updated;
    } catch (error) {
        discardUpload(req);
        throw error;
    }
};

export const deleteProductById = async (productId: number, { sellerId }: { sellerId?: number } = {}) => {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || (sellerId !== undefined && product.sellerId !== sellerId)) {
        throw new HttpError(404, "Product not found");
    }
    // Past orders point at this product, and the database (rightly) won't let order history break
    const orderCount = await prisma.orderItem.count({ where: { productId } });
    if (orderCount > 0) {
        throw new HttpError(409, "This product appears in past orders and cannot be deleted. Set its stock to 0 to stop selling it.");
    }
    await prisma.product.delete({ where: { id: productId } }); // Also removes it from carts, wishlists and reviews
    [product.image, ...product.images].forEach(deleteUploadedImage);
    await invalidateProductCache();
};
