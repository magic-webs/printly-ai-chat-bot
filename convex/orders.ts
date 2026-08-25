import { v } from "convex/values";
import { internalMutation, internalQuery, query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";

// ---------------------------------------------------------------------------
// createOrder – called internally whenever the AI produces type="order"
// ---------------------------------------------------------------------------
export const createOrder = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    whatsappNumber: v.optional(v.string()),
    customerName: v.optional(v.string()),
    companyName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    product: v.optional(v.string()),
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
    webhookEventId: v.optional(v.id("webhookEvents")),
    rawPayload: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const orderId = await ctx.db.insert("orders", {
      userId: args.userId,
      whatsappNumber: args.whatsappNumber ?? "",
      customerName: args.customerName ?? "",
      companyName: args.companyName,
      email: args.email,
      phone: args.phone ?? "",
      product: args.product ?? "",
      quantity: args.quantity ?? "",
      size: args.size,
      material: args.material,
      colour: args.colour,
      pages: args.pages,
      finish: args.finish,
      printing: args.printing,
      artwork: args.artwork ?? "",
      additionalDetails: args.additionalDetails,
      deliveryAddress: args.deliveryAddress,
      deliveryPostcode: args.deliveryPostcode,
      requiredDeliveryDate: args.requiredDeliveryDate,
      status: "new",
      webhookEventId: args.webhookEventId,
      rawPayload: args.rawPayload,
      createdAt: now,
      updatedAt: now,
    });
    return orderId;
  },
});

// ---------------------------------------------------------------------------
// updateOrderStatus – update status as the team actions the enquiry
// ---------------------------------------------------------------------------
export const updateOrderStatus = mutation({
  args: {
    token: v.string(),
    orderId: v.id("orders"),
    status: v.union(
      v.literal("new"),
      v.literal("quoted"),
      v.literal("confirmed"),
      v.literal("in_progress"),
      v.literal("completed"),
      v.literal("cancelled")
    ),
  },
  handler: async (ctx, args) => {
    // Auth check
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();

    if (!session || session.expiry < Date.now()) {
      throw new Error("Unauthorized or expired session");
    }

    await ctx.db.patch(args.orderId, {
      status: args.status,
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

// ---------------------------------------------------------------------------
// listOrders – list all orders for the logged-in user or all (admin view)
// ---------------------------------------------------------------------------
export const listOrders = query({
  args: {
    token: v.string(),
    status: v.optional(
      v.union(
        v.literal("new"),
        v.literal("quoted"),
        v.literal("confirmed"),
        v.literal("in_progress"),
        v.literal("completed"),
        v.literal("cancelled")
      )
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();

    if (!session || session.expiry < Date.now()) {
      throw new Error("Unauthorized or expired session");
    }

    const lim = args.limit ?? 50;

    let orders;
    if (args.status) {
      orders = await ctx.db
        .query("orders")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .order("desc")
        .take(lim);
    } else {
      orders = await ctx.db
        .query("orders")
        .order("desc")
        .take(lim);
    }

    return orders;
  },
});

// ---------------------------------------------------------------------------
// getOrdersByPhone – internal: fetch orders by WhatsApp number
// ---------------------------------------------------------------------------
export const getOrdersByPhone = internalQuery({
  args: {
    whatsappNumber: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("orders")
      .withIndex("by_whatsappNumber", (q) => q.eq("whatsappNumber", args.whatsappNumber))
      .order("desc")
      .take(args.limit ?? 20);
  },
});

// ---------------------------------------------------------------------------
// getOrder – get a single order by ID (public, auth required)
// ---------------------------------------------------------------------------
export const getOrder = query({
  args: {
    token: v.string(),
    orderId: v.id("orders"),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();

    if (!session || session.expiry < Date.now()) {
      throw new Error("Unauthorized or expired session");
    }

    return await ctx.db.get(args.orderId);
  },
});
