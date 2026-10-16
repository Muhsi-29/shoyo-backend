// Builds a CSV file (opens in Excel or Google Sheets) from rows of values.
// Cells starting with = + - @ get a leading apostrophe, so a customer named "=HYPERLINK(...)" can't
// turn into a live formula when an admin opens the export (CSV injection).
const cell = (value: string | number | null | undefined) => {
    if (value === null || value === undefined) return "";
    let text = String(value);
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const toCsv = (rows: (string | number | null | undefined)[][]) =>
    // The byte-order mark makes Excel read ₹ and other non-English characters correctly
    "﻿" + rows.map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
