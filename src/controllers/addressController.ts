import type { Response } from "express";
import prisma from "../db.js";
import { currentUserId, type AuthenticatedRequest } from "../middlewares/authMiddleware.js";
import { HttpError } from "../utils/httpError.js";
import { addressSchema, idParamsSchema } from "../validation/schemas.js";

// Saved delivery addresses. One of them is the default, picked automatically at checkout.

const MAX_ADDRESSES = 10;

const listAddresses = (userId: number) =>
    prisma.address.findMany({ where: { userId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });

const findOwnAddress = async (userId: number, id: number) => {
    const address = await prisma.address.findUnique({ where: { id } });
    if (!address || address.userId !== userId) throw new HttpError(404, "Address not found.");
    return address;
};

// GET /addresses
export const getAddresses = async (req: AuthenticatedRequest, res: Response) => {
    res.status(200).json({ status: "success", data: await listAddresses(currentUserId(req)) });
};

// POST /addresses: the first address (or one marked isDefault) becomes the default
export const createAddress = async (req: AuthenticatedRequest, res: Response) => {
    const userId = currentUserId(req);
    const { isDefault, ...fields } = addressSchema.parse(req.body ?? {});
    const count = await prisma.address.count({ where: { userId } });
    if (count >= MAX_ADDRESSES) throw new HttpError(400, `You can save up to ${MAX_ADDRESSES} addresses.`);

    const makeDefault = isDefault === true || count === 0;
    await prisma.$transaction(async (tx) => {
        if (makeDefault) await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
        await tx.address.create({
            data: { ...fields, line2: fields.line2 ?? null, label: fields.label ?? null, userId, isDefault: makeDefault },
        });
    });
    res.status(201).json({ status: "success", data: await listAddresses(userId) });
};

// PUT /addresses/:id
export const updateAddress = async (req: AuthenticatedRequest, res: Response) => {
    const userId = currentUserId(req);
    const { id } = idParamsSchema.parse(req.params);
    const { isDefault, ...fields } = addressSchema.parse(req.body ?? {});
    await findOwnAddress(userId, id);
    await prisma.$transaction(async (tx) => {
        if (isDefault === true) await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
        await tx.address.update({
            where: { id },
            data: { ...fields, line2: fields.line2 ?? null, label: fields.label ?? null, ...(isDefault === true ? { isDefault: true } : {}) },
        });
    });
    res.status(200).json({ status: "success", data: await listAddresses(userId) });
};

// PATCH /addresses/:id/default
export const setDefaultAddress = async (req: AuthenticatedRequest, res: Response) => {
    const userId = currentUserId(req);
    const { id } = idParamsSchema.parse(req.params);
    await findOwnAddress(userId, id);
    await prisma.$transaction([
        prisma.address.updateMany({ where: { userId }, data: { isDefault: false } }),
        prisma.address.update({ where: { id }, data: { isDefault: true } }),
    ]);
    res.status(200).json({ status: "success", data: await listAddresses(userId) });
};

// DELETE /addresses/:id: if it was the default, the oldest remaining address takes over
export const deleteAddress = async (req: AuthenticatedRequest, res: Response) => {
    const userId = currentUserId(req);
    const { id } = idParamsSchema.parse(req.params);
    const address = await findOwnAddress(userId, id);
    await prisma.$transaction(async (tx) => {
        await tx.address.delete({ where: { id } });
        if (address.isDefault) {
            const next = await tx.address.findFirst({ where: { userId }, orderBy: { createdAt: "asc" } });
            if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
        }
    });
    res.status(200).json({ status: "success", data: await listAddresses(userId) });
};
