/**
 * Shared, dependency-free helpers for the John sales agent.
 *
 * These are plain TypeScript functions (not Convex functions) so they can be
 * used from actions, mutations and the Next.js layer alike.
 */

// ---------------------------------------------------------------------------
// Field normalisation
// ---------------------------------------------------------------------------

/**
 * Placeholder strings that language models emit in place of a real answer.
 * Treating these as "captured" is how incomplete enquiries used to slip through
 * the gate, so they are normalised away to undefined.
 */
const PLACEHOLDER_VALUES = new Set([
  "",
  "-",
  "--",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "unknown",
  "not provided",
  "not specified",
  "not sure",
  "notsure",
  "tbc",
  "tbd",
  "to be confirmed",
  "to be decided",
  "pending",
  "string",
  "?",
]);

/** Trim a model-supplied value, collapsing placeholders to undefined. */
export function normaliseField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

/** Apply {@link normaliseField} across an object, dropping empty keys entirely. */
export function normaliseFields<T extends Record<string, unknown>>(
  input: T
): Partial<Record<keyof T, string>> {
  const out: Partial<Record<keyof T, string>> = {};
  for (const [key, value] of Object.entries(input)) {
    const clean = normaliseField(value);
    if (clean !== undefined) out[key as keyof T] = clean;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Completeness gate — Knowledge Base section 30
// ---------------------------------------------------------------------------

/** The subset of enquiry fields the gate inspects. */
export interface EnquirySnapshot {
  customerName?: string;
  companyName?: string;
  email?: string;
  phone?: string;
  product?: string;
  productSlug?: string;
  quantity?: string;
  size?: string;
  material?: string;
  colour?: string;
  pages?: string;
  finish?: string;
  printing?: string;
  artwork?: string;
  additionalDetails?: string;
  deliveryAddress?: string;
  deliveryPostcode?: string;
  requiredDeliveryDate?: string;
}

export interface CompletenessResult {
  complete: boolean;
  /** Human-readable labels of what is still outstanding, for the agent to ask. */
  missing: string[];
}

/** Every requirement field an enquiry can carry. Single source of truth. */
export const ENQUIRY_FIELD_KEYS = [
  "customerName",
  "companyName",
  "email",
  "phone",
  "product",
  "productSlug",
  "quantity",
  "size",
  "material",
  "colour",
  "pages",
  "finish",
  "printing",
  "artwork",
  "additionalDetails",
  "deliveryAddress",
  "deliveryPostcode",
  "requiredDeliveryDate",
] as const satisfies ReadonlyArray<keyof EnquirySnapshot>;

/**
 * Project any record (an enquiry document, or raw tool input) down to a clean
 * snapshot, dropping unknown keys and placeholder values.
 */
export function toSnapshot(
  doc: Record<string, unknown> | null | undefined
): EnquirySnapshot {
  if (!doc) return {};
  const snapshot: Record<string, string> = {};
  for (const key of ENQUIRY_FIELD_KEYS) {
    const value = normaliseField(doc[key]);
    if (value) snapshot[key] = value;
  }
  return snapshot as EnquirySnapshot;
}

/**
 * Mandatory fields from KB section 30. An enquiry may only become an order when
 * all of these are present — this is the gate that stops half-captured
 * enquiries from being raised as quotation requests.
 */
const MANDATORY_FIELDS: Array<{ key: keyof EnquirySnapshot; label: string }> = [
  { key: "customerName", label: "customer name" },
  { key: "product", label: "product" },
  { key: "quantity", label: "quantity" },
  { key: "artwork", label: "artwork status (print-ready supplied, or design needed)" },
  { key: "requiredDeliveryDate", label: "required delivery date" },
];

export function evaluateCompleteness(enquiry: EnquirySnapshot): CompletenessResult {
  const missing: string[] = [];

  for (const { key, label } of MANDATORY_FIELDS) {
    if (!normaliseField(enquiry[key])) missing.push(label);
  }

  // Delivery: either a postcode or a full address satisfies the requirement.
  if (
    !normaliseField(enquiry.deliveryPostcode) &&
    !normaliseField(enquiry.deliveryAddress)
  ) {
    missing.push("delivery postcode or address");
  }

  return { complete: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// WhatsApp message formatting
// ---------------------------------------------------------------------------

/** Field order used when echoing a captured enquiry back to the customer. */
const SUMMARY_FIELDS: Array<{ key: keyof EnquirySnapshot; label: string }> = [
  { key: "product", label: "Product" },
  { key: "quantity", label: "Quantity" },
  { key: "size", label: "Size" },
  { key: "material", label: "Material" },
  { key: "colour", label: "Colour" },
  { key: "pages", label: "Pages" },
  { key: "finish", label: "Finish" },
  { key: "printing", label: "Printing" },
  { key: "artwork", label: "Artwork" },
  { key: "deliveryAddress", label: "Delivery Address" },
  { key: "deliveryPostcode", label: "Postcode" },
  { key: "requiredDeliveryDate", label: "Required Date" },
  { key: "additionalDetails", label: "Notes" },
];

/**
 * Render the confirmation card sent to the customer once a quotation request
 * has been raised. WhatsApp uses *single asterisks* for bold.
 */
export function formatOrderConfirmation(
  enquiry: EnquirySnapshot,
  message?: string
): string {
  const lines: string[] = [];

  const who = normaliseField(enquiry.customerName);
  const company = normaliseField(enquiry.companyName);
  if (who) lines.push(`*Customer:* ${who}${company ? ` (${company})` : ""}`);

  const email = normaliseField(enquiry.email);
  if (email) lines.push(`*Email:* ${email}`);

  const phone = normaliseField(enquiry.phone);
  if (phone) lines.push(`*Phone:* ${phone}`);

  for (const { key, label } of SUMMARY_FIELDS) {
    const value = normaliseField(enquiry[key]);
    if (value) lines.push(`*${label}:* ${value}`);
  }

  const intro =
    message?.trim() ||
    "Thank you. We have all the details required. Our team will review your requirements and prepare a quotation shortly.";

  return [
    "✅ *Quotation Request Received*",
    "",
    intro,
    "",
    ...(lines.length ? [lines.join("\n"), ""] : []),
    "Our team will be in touch shortly with an official quotation. \u{1F5A8}️",
  ].join("\n");
}

/** Prefixes applied to routed (non-order) outcomes. */
const ROUTED_PREFIX: Record<string, string> = {
  agent: "\u{1F91D}",
  support: "\u{1F534}",
  customer: "\u{1F4E6}",
};

/** Render a routed outcome (human agent / support / existing-customer). */
export function formatRoutedMessage(kind: string, message: string): string {
  const prefix = ROUTED_PREFIX[kind];
  return prefix ? `${prefix} ${message}` : message;
}
