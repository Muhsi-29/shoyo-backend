// An error that carries the HTTP status to send back, e.g. throw new HttpError(404, "Product not found")
export class HttpError extends Error {
    statusCode: number;
    errors?: { field: string; message: string }[];

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }

    // A 400 for one bad field, shaped like validation errors: { message: "mrp: ...", errors: [{ field: "mrp", ... }] }
    static field(field: string, message: string) {
        const error = new HttpError(400, `${field}: ${message}`);
        error.errors = [{ field, message }];
        return error;
    }
}
