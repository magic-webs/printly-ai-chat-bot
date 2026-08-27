import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  ENQUIRY_FIELD_KEYS,
  evaluateCompleteness,
  nextQuestion,
  normaliseField,
  toSnapshot,
  type EnquirySnapshot,
} from "./agent/enquiry";

// ---------------------------------------------------------------------------
// Field validators shared by the save/read surface
// ---------------------------------------------------------------------------

const enquiryFieldArgs = {
  customerName: v.optional(v.string()),
  companyName: v.optional(v.string()),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  product: v.optional(v.string()),
  productSlug: v.optional(v.string()),
  quantity: v.optional(v.string()),
  size: v.optional(v.string()),
  material: v.optional(v.string()),
  colour: v.optional(v.string()),
  pages: v.optional(v.string()),
  finish: v.optional(v.string()),
  printing: v.optional(v.string()),
  artwork: v.optional(v.string()),
  additionalDetails: v.optional(v.string()),
  deliveryAddress: v.optional(v.string()),
  deliveryPostcode: v.optional(v.string()),
  requiredDeliveryDate: v.optional(v.string()),
};

/**
 * Match a free-text product name to a catalogue slug.
 *
 * The agent is told to pass the slug from getProductDetails, but it frequently
 * does not. Without a slug the question planner has no requirement fields and
 * silently skips every specification question, so the slug is resolved here
 * rather than left to the model.
 */
async function resolveProductSlug(
  ctx: MutationCtx,
  productName: string
): Promise<string | undefined> {
  const all = await ctx.db.query("products").collect();
  const lower = productName.toLowerCase().trim();
  const slugified = lower.replace(/\s+/g, "-");

  const match =
    all.find((p) => p.name.toLowerCase() === lower) ??
    all.find((p) => p.slug === slugified) ??
    all.find(
      (p) => p.name.toLowerCase().includes(lower) || p.slug.includes(slugified)
    ) ??
    all.find((p) => lower.includes(p.name.toLowerCase()));

  return match?.slug;
}

/**
 * Collect the requirement fields carrying a real value. A blank or placeholder
 * from the model must never overwrite something already captured, so anything
 * that normalises away is simply dropped from the patch.
 */
function buildPatch(args: Record<string, unknown>): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const key of ENQUIRY_FIELD_KEYS) {
    const value = normaliseField(args[key]);
    if (value) patch[key] = value;
  }
  return patch;
}

// ---------------------------------------------------------------------------
// getActiveEnquiry – the open "collecting" enquiry for a user, if any
// ---------------------------------------------------------------------------
export const getActiveEnquiry = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("enquiries")
      .withIndex("by_user_and_status", (q) =>
        q.eq("userId", args.userId).eq("status", "collecting")
      )
      .order("desc")
      .first();
  },
});

/**
 * Return the open enquiry for a user, creating one if none exists.
 * Callers already inside a mutation use this rather than the query above.
 */
async function ensureActiveEnquiry(
  ctx: MutationCtx,
  userId: Id<"users">,
  whatsappNumber: string
): Promise<Doc<"enquiries">> {
  const existing = await ctx.db
    .query("enquiries")
    .withIndex("by_user_and_status", (q) =>
      q.eq("userId", userId).eq("status", "collecting")
    )
    .order("desc")
    .first();

  if (existing) return existing;

  const now = Date.now();
  const id = await ctx.db.insert("enquiries", {
    userId,
    whatsappNumber,
    status: "collecting" as const,
    createdAt: now,
    updatedAt: now,
  });
  return (await ctx.db.get(id))!;
}

// ---------------------------------------------------------------------------
// saveEnquiryDetails – upsert captured requirement fields onto the open enquiry
// ---------------------------------------------------------------------------
export const saveEnquiryDetails = internalMutation({
  args: {
    userId: v.id("users"),
    whatsappNumber: v.string(),
    ...enquiryFieldArgs,
  },
  handler: async (ctx, args) => {
    const enquiry = await ensureActiveEnquiry(
      ctx,
      args.userId,
      args.whatsappNumber
    );

    const patch = buildPatch(args);

    // Backfill the slug whenever a product name lands without one.
    if (patch.product && !patch.productSlug && !enquiry.productSlug) {
      const slug = await resolveProductSlug(ctx, patch.product);
      if (slug) patch.productSlug = slug;
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(enquiry._id, { ...patch, updatedAt: Date.now() });
    }

    const updated = await ctx.db.get(enquiry._id);
    const snapshot = toSnapshot(updated);
    const { complete, missing } = evaluateCompleteness(snapshot);

    // Only ask about specs the chosen product actually calls for.
    let requirementFields: string[] | undefined;
    if (snapshot.productSlug) {
      const product = await ctx.db
        .query("products")
        .withIndex("by_slug", (q) => q.eq("slug", snapshot.productSlug!))
        .unique();
      requirementFields = product?.requirementFields;
    }

    return {
      saved: Object.keys(patch),
      captured: snapshot,
      complete,
      missing,
      nextQuestion: nextQuestion(snapshot, requirementFields),
    };
  },
});

// ---------------------------------------------------------------------------
// submitQuotationRequest – the completeness gate + order creation, atomically
// ---------------------------------------------------------------------------
export const submitQuotationRequest = internalMutation({
  args: {
    userId: v.id("users"),
    whatsappNumber: v.string(),
    // Last-moment details the agent may pass alongside the submission.
    ...enquiryFieldArgs,
  },
  handler: async (ctx, args): Promise<
    | { submitted: false; missing: string[]; captured: EnquirySnapshot }
    | { submitted: true; orderId: Id<"orders">; captured: EnquirySnapshot }
  > => {
    const enquiry = await ensureActiveEnquiry(
      ctx,
      args.userId,
      args.whatsappNumber
    );

    // Fold in anything supplied with the submit call itself.
    const patch = buildPatch(args);
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(enquiry._id, { ...patch, updatedAt: Date.now() });
    }

    const current = await ctx.db.get(enquiry._id);
    const snapshot = toSnapshot(current);
    const { complete, missing } = evaluateCompleteness(snapshot);

    // The gate: refuse rather than raising a half-captured quotation request.
    if (!complete) {
      return { submitted: false, missing, captured: snapshot };
    }

    const user = await ctx.db.get(args.userId);
    const now = Date.now();

    const orderId = await ctx.db.insert("orders", {
      userId: args.userId,
      whatsappNumber: args.whatsappNumber,
      customerName: snapshot.customerName ?? user?.name ?? "",
      companyName: snapshot.companyName,
      email: snapshot.email,
      phone: snapshot.phone ?? args.whatsappNumber,
      product: snapshot.product!,
      productSlug: snapshot.productSlug,
      quantity: snapshot.quantity!,
      size: snapshot.size,
      material: snapshot.material,
      colour: snapshot.colour,
      pages: snapshot.pages,
      finish: snapshot.finish,
      printing: snapshot.printing,
      artwork: snapshot.artwork!,
      additionalDetails: snapshot.additionalDetails,
      deliveryAddress: snapshot.deliveryAddress,
      deliveryPostcode: snapshot.deliveryPostcode,
      requiredDeliveryDate: snapshot.requiredDeliveryDate,
      status: "new",
      enquiryId: enquiry._id,
      rawPayload: JSON.stringify(snapshot),
      createdAt: now,
      updatedAt: now,
    });

    // Close the enquiry. A repeated "yes" from the customer therefore starts a
    // fresh enquiry instead of raising a duplicate order against this one.
    await ctx.db.patch(enquiry._id, {
      status: "submitted",
      orderId,
      updatedAt: now,
    });

    // Deliver the webhook outside this transaction so a slow or failing
    // endpoint never delays the customer's WhatsApp reply.
    await ctx.scheduler.runAfter(0, internal.webhooks.triggerWebhook, {
      event: "order_created",
      orderId,
      data: buildOrderCreatedPayload(orderId, snapshot),
    });

    return { submitted: true, orderId, captured: snapshot };
  },
});

/** Shape the outbound `order_created` payload. Kept stable for consumers. */
function buildOrderCreatedPayload(
  orderId: Id<"orders">,
  snapshot: EnquirySnapshot
) {
  return {
    order_id: orderId,
    customer: {
      full_name: snapshot.customerName ?? "",
      company_name: snapshot.companyName ?? "",
      email: snapshot.email ?? "",
      phone: snapshot.phone ?? "",
    },
    order: {
      product: snapshot.product ?? "",
      quantity: snapshot.quantity ?? "",
      size: snapshot.size ?? "",
      material: snapshot.material ?? "",
      colour: snapshot.colour ?? "",
      pages: snapshot.pages ?? "",
      finish: snapshot.finish ?? "",
      printing: snapshot.printing ?? "",
      artwork: snapshot.artwork ?? "",
      delivery: {
        postcode: snapshot.deliveryPostcode ?? "",
        address: snapshot.deliveryAddress ?? "",
        required_delivery_date: snapshot.requiredDeliveryDate ?? "",
      },
      additional_details: snapshot.additionalDetails ?? "",
    },
  };
}

// ---------------------------------------------------------------------------
// routeToTeam – hand off to a human and fire the matching webhook
// ---------------------------------------------------------------------------
export const routeToTeam = internalMutation({
  args: {
    userId: v.id("users"),
    whatsappNumber: v.string(),
    kind: v.union(v.literal("agent"), v.literal("support"), v.literal("customer")),
    reason: v.optional(v.string()),
    orderNumber: v.optional(v.string()),
    customerName: v.optional(v.string()),
    companyName: v.optional(v.string()),
    email: v.optional(v.string()),
    additionalDetails: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);

    // Reuse anything already captured on the open enquiry so the team receives
    // the full picture, not just what the model repeated in this one call.
    const enquiry = await ctx.db
      .query("enquiries")
      .withIndex("by_user_and_status", (q) =>
        q.eq("userId", args.userId).eq("status", "collecting")
      )
      .order("desc")
      .first();
    const snapshot = toSnapshot(enquiry);

    const event =
      args.kind === "agent"
        ? ("human_agent" as const)
        : args.kind === "support"
          ? ("support_request" as const)
          : ("customer_enquiry" as const);

    await ctx.scheduler.runAfter(0, internal.webhooks.triggerWebhook, {
      event,
      data: {
        customer_name:
          normaliseField(args.customerName) ??
          snapshot.customerName ??
          user?.name ??
          "",
        company_name:
          normaliseField(args.companyName) ?? snapshot.companyName ?? "",
        phone: snapshot.phone ?? args.whatsappNumber,
        email: normaliseField(args.email) ?? snapshot.email ?? "",
        order_number: normaliseField(args.orderNumber) ?? "",
        reason: normaliseField(args.reason) ?? "",
        additional_details: normaliseField(args.additionalDetails) ?? "",
        enquiry_so_far: snapshot,
      },
    });

    return { routed: true, event };
  },
});

// ---------------------------------------------------------------------------
// linkWebhookEvent – attach the delivery log row back onto the order
// ---------------------------------------------------------------------------
export const linkWebhookEvent = internalMutation({
  args: {
    orderId: v.id("orders"),
    webhookEventId: v.id("webhookEvents"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.orderId, {
      webhookEventId: args.webhookEventId,
      updatedAt: Date.now(),
    });
  },
});
