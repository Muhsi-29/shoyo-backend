import type { StoreSettings } from "@prisma/client";

// Delivery charge for an items total (coupons don't change it), using the store's current rules
export const deliveryFeeFor = (subtotal: number, rules: Pick<StoreSettings, "deliveryFee" | "freeDeliveryThreshold">) =>
    subtotal <= 0 || subtotal >= rules.freeDeliveryThreshold ? 0 : rules.deliveryFee;

// Rough delivery time between two Indian PIN codes. The first digit of a PIN is the postal zone, the first
// two the postal circle (roughly a state) and the first three the sorting district, so sharing more leading
// digits means a shorter trip. A real store would ask its courier's API instead.
export const estimateDeliveryDays = (fromPincode: string, toPincode: string) => {
    if (fromPincode.slice(0, 3) === toPincode.slice(0, 3)) return { minDays: 1, maxDays: 2 };
    if (fromPincode.slice(0, 2) === toPincode.slice(0, 2)) return { minDays: 2, maxDays: 3 };
    if (fromPincode[0] === toPincode[0]) return { minDays: 3, maxDays: 5 };
    return { minDays: 4, maxDays: 7 };
};

// Couriers don't deliver on Sundays
const addDeliveryDays = (start: Date, days: number) => {
    const date = new Date(start);
    date.setDate(date.getDate() + days);
    if (date.getDay() === 0) date.setDate(date.getDate() + 1);
    return date;
};

export const deliveryWindow = (fromPincode: string, toPincode: string, start = new Date()) => {
    const { minDays, maxDays } = estimateDeliveryDays(fromPincode, toPincode);
    return {
        minDays,
        maxDays,
        earliest: addDeliveryDays(start, minDays).toISOString(),
        latest: addDeliveryDays(start, maxDays).toISOString(),
    };
};
