// Prices are stored in rupees with up to 2 decimals; payment gateways want whole paise
export const round2 = (amount: number) => Math.round(amount * 100) / 100;
export const toPaise = (rupees: number) => Math.round(rupees * 100);

const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
export const formatRupees = (amount: number) => rupees.format(amount);
