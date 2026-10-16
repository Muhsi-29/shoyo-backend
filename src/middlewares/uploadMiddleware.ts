import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';
import type { Request } from 'express';
import { HttpError } from '../utils/httpError.js';

// backend/uploads, resolved from this file's location so it works whichever folder the server is started from
export const UPLOAD_DIR = fileURLToPath(new URL('../../uploads', import.meta.url));

// Multer doesn't create the folder itself, and every upload fails with ENOENT if it's missing
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Allowed image types and the extension each one is saved with
const IMAGE_EXTENSIONS: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
};

// Configure how and where Multer saves the files
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        // Create a unique filename: timestamp + extension. The extension comes from the checked
        // image type, not the user's filename, so "evil.html" can't be saved as a .html page.
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${file.fieldname}-${uniqueSuffix}${IMAGE_EXTENSIONS[file.mimetype]}`);
    }
});

// Create the upload middleware
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    // Uploaded files are served publicly, so only accept images (an HTML or SVG file could run scripts)
    fileFilter: (req, file, cb) => {
        if (file.mimetype in IMAGE_EXTENSIONS) {
            cb(null, true);
        } else {
            cb(new HttpError(400, 'Only JPEG, PNG, WebP or GIF images are allowed.'));
        }
    }
});

export default upload;

// A product's photos: one main image plus up to 6 gallery images
export const productImages = upload.fields([{ name: 'image', maxCount: 1 }, { name: 'gallery', maxCount: 6 }]);

// The files saved by productImages
export const uploadedFiles = (req: Request) => {
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>;
    return { image: files.image?.[0], gallery: files.gallery ?? [] };
};

// Deletes the files Multer just saved, e.g. when the product they belong to failed validation
export const discardUpload = (req: Request) => {
    const { image, gallery } = uploadedFiles(req);
    for (const file of [req.file, image, ...gallery]) {
        if (file) fs.promises.unlink(file.path).catch(() => {});
    }
};

// Deletes a product's old image from disk when it's replaced or the product is deleted.
// Only touches our own /uploads/ files (never external URLs); basename() blocks "../" tricks.
export const deleteUploadedImage = (imagePath: string) => {
    if (!imagePath.startsWith('/uploads/')) return;
    fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(imagePath))).catch(() => {});
};

// A homepage banner's picture (saved in req.file)
export const bannerImage = upload.single('image');
