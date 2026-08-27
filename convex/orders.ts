import { v } from "convex/values";
import { internalQuery, query, mutation } from "./_generated/server";

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
