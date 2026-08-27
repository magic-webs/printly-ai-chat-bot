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
// Next-question planning
// ---------------------------------------------------------------------------

/**
 * The single question to put to the customer next.
 *
 * Deciding this server-side is deliberate: left to its own judgement the model
 * mirrors the bullet lists in the knowledge base and dumps every outstanding
 * field at once, which reads nothing like a consultant.
 */
export interface NextQuestion {
  field: keyof EnquirySnapshot;
  question: string;
}

/** Natural conversational order: what → how many → how it looks → logistics. */
const QUESTION_PLAN: Array<{
  field: keyof EnquirySnapshot;
  question: string;
  /** Spec fields are only asked when the chosen product actually needs them. */
  spec?: boolean;
}> = [
  { field: "product", question: "What would you like printed?" },
  { field: "quantity", question: "How many do you need?" },
  { field: "size", question: "What size do you need?", spec: true },
  { field: "pages", question: "How many pages will it be?", spec: true },
  { field: "material", question: "What paper or material would you like?", spec: true },
  {
    field: "printing",
    question: "Would you like it printed on one side or both?",
    spec: true,
  },
  { field: "colour", question: "How many colours should it print in?", spec: true },
  {
    field: "finish",
    question: "Any finishing — lamination, binding, folding or embellishments?",
    spec: true,
  },
  {
    field: "artwork",
    question:
      "Will you supply print-ready artwork, or would you like Printwell to design it?",
  },
  { field: "deliveryPostcode", question: "What's the delivery postcode?" },
  { field: "requiredDeliveryDate", question: "When do you need them by?" },
  { field: "customerName", question: "Could I take your name for the quotation?" },
];

/**
 * Map a product's `requirementFields` tokens onto enquiry keys, so only the
 * specs that matter for the chosen product get asked.
 */
const REQUIREMENT_TOKEN_TO_FIELD: Record<string, keyof EnquirySnapshot> = {
  quantity: "quantity",
  size: "size",
  dimensions: "size",
  size_or_dimensions: "size",
  approximate_dimensions: "size",
  number_of_pages: "pages",
  material: "material",
  paper_material: "material",
  material_paper: "material",
  colour: "colour",
  number_of_colours: "colour",
  single_or_double_sided: "printing",
  printing: "printing",
  branding_method: "printing",
  finish: "finish",
  embellishments: "finish",
  binding: "finish",
  fold_type: "finish",
  eyelets: "finish",
  pocket_type: "finish",
  reels_or_sheets: "finish",
  removable_or_permanent_adhesive: "finish",
  artwork_status: "artwork",
  artwork: "artwork",
};

/**
 * Pick the next outstanding field to ask about, or null when everything the
 * product needs has been captured and the enquiry is ready to confirm.
 *
 * `productRequirementFields` comes from the products table; when it is absent
 * (no product chosen yet) only the non-spec questions are considered.
 */
export function nextQuestion(
  enquiry: EnquirySnapshot,
  productRequirementFields?: string[]
): NextQuestion | null {
  const relevantSpecs = new Set<keyof EnquirySnapshot>();
  for (const token of productRequirementFields ?? []) {
    const field = REQUIREMENT_TOKEN_TO_FIELD[token];
    if (field) relevantSpecs.add(field);
  }

  // A product with no resolvable requirement fields must not cause every
  // specification question to be skipped — fall back to the specs that apply
  // to virtually all printed work.
  if (relevantSpecs.size === 0 && normaliseField(enquiry.product)) {
    relevantSpecs.add("size");
    relevantSpecs.add("material");
    relevantSpecs.add("printing");
  }

  for (const step of QUESTION_PLAN) {
    if (normaliseField(enquiry[step.field])) continue;

    // Delivery is satisfied by either a postcode or a full address.
    if (
      step.field === "deliveryPostcode" &&
      normaliseField(enquiry.deliveryAddress)
    ) {
      continue;
    }

    // Skip specs this product does not call for.
    if (step.spec && !relevantSpecs.has(step.field)) continue;

    return { field: step.field, question: step.question };
  }

  return null;
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
