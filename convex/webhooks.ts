import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

// ---------------------------------------------------------------------------
// Webhook payload types
// ---------------------------------------------------------------------------

interface OrderCreatedPayload {
  customer: {
    full_name: string;
    company_name: string;
    email: string;
    phone: string;
  };
  order: {
    product: string;
    quantity: string;
    size?: string;
    material?: string;
    colour?: string;
    pages?: string;
    finish?: string;
    printing?: string;
    artwork: string;
    delivery: {
      postcode: string;
      address: string;
      required_delivery_date: string;
    };
    additional_details?: string;
  };
}

interface HumanAgentPayload {
  customer_name: string;
  company_name: string;
  phone: string;
  email: string;
  reason: string;
  additional_details: string;
}

// ---------------------------------------------------------------------------
// logWebhookEvent – persist the outgoing event + response to webhookEvents table
// ---------------------------------------------------------------------------
export const logWebhookEvent = internalMutation({
  args: {
    event: v.string(),
    payload: v.string(),
    status: v.union(v.literal("sent"), v.literal("failed")),
    responseStatus: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("webhookEvents", {
      event: args.event,
      payload: args.payload,
      status: args.status,
      responseStatus: args.responseStatus,
      error: args.error,
      createdAt: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// triggerWebhook – fire an HTTP POST to WEBHOOK_URL with event + data
// ---------------------------------------------------------------------------
export const triggerWebhook = internalAction({
  args: {
    event: v.union(v.literal("order_created"), v.literal("human_agent")),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    const webhookUrl = process.env.WEBHOOK_URL;

    const payloadObj = {
      event: args.event,
      timestamp: new Date().toISOString(),
      data: args.data,
    };
    const payloadStr = JSON.stringify(payloadObj);

    if (!webhookUrl) {
      console.warn(
        "[Webhook] WEBHOOK_URL env var not set – event logged but not delivered.",
        { event: args.event }
      );
      await ctx.runMutation(internal.webhooks.logWebhookEvent, {
        event: args.event,
        payload: payloadStr,
        status: "failed",
        error: "WEBHOOK_URL environment variable is not configured.",
      });
      return { success: false, reason: "WEBHOOK_URL not configured" };
    }

    let responseStatus: number | undefined;
    let success = false;
    let errorMessage: string | undefined;

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Printly-Event": args.event,
          "X-Printly-Timestamp": payloadObj.timestamp,
        },
        body: payloadStr,
      });

      responseStatus = response.status;
      success = response.ok;

      if (!response.ok) {
        const responseText = await response.text().catch(() => "");
        errorMessage = `HTTP ${response.status}: ${responseText.slice(0, 200)}`;
        console.error("[Webhook] Delivery failed:", errorMessage);
      } else {
        console.log("[Webhook] Delivered successfully:", {
          event: args.event,
          status: response.status,
        });
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      console.error("[Webhook] Network error:", errorMessage);
    }

    await ctx.runMutation(internal.webhooks.logWebhookEvent, {
      event: args.event,
      payload: payloadStr,
      status: success ? "sent" : "failed",
      responseStatus,
      error: errorMessage,
    });

    return { success, responseStatus, error: errorMessage };
  },
});
