import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Events the bot emits. Each maps to one routing outcome in the knowledge base. */
export const WEBHOOK_EVENTS = v.union(
  v.literal("order_created"),
  v.literal("human_agent"),
  v.literal("support_request"),
  v.literal("customer_enquiry")
);

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
/** Backoff before attempts 2 and 3. */
const RETRY_DELAYS_MS = [500, 2_000];

/** Retry on transport errors, 5xx, and 429 — but not on other 4xx. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

// ---------------------------------------------------------------------------
// logWebhookEvent – persist the outgoing event + delivery outcome
// ---------------------------------------------------------------------------
export const logWebhookEvent = internalMutation({
  args: {
    event: v.string(),
    payload: v.string(),
    status: v.union(v.literal("pending"), v.literal("sent"), v.literal("failed")),
    responseStatus: v.optional(v.number()),
    error: v.optional(v.string()),
    attempts: v.optional(v.number()),
    orderId: v.optional(v.id("orders")),
    deliveredAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Id<"webhookEvents">> => {
    return await ctx.db.insert("webhookEvents", {
      event: args.event,
      payload: args.payload,
      status: args.status,
      responseStatus: args.responseStatus,
      error: args.error,
      attempts: args.attempts,
      orderId: args.orderId,
      deliveredAt: args.deliveredAt,
      createdAt: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// Payload signing – lets the receiver verify the call really came from us
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA256 of the raw body, hex encoded. The receiver recomputes this with
 * the shared WEBHOOK_SECRET and compares against the X-Printly-Signature header.
 */
async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** POST once, with a hard timeout so a hanging endpoint cannot stall the action. */
async function postOnce(
  url: string,
  body: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    if (response.ok) return { ok: true, status: response.status };

    const text = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}: ${text.slice(0, 300)}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: controller.signal.aborted
        ? `Timed out after ${REQUEST_TIMEOUT_MS}ms`
        : message,
    };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// triggerWebhook – deliver an event to WEBHOOK_URL, with retries and logging
// ---------------------------------------------------------------------------
export const triggerWebhook = internalAction({
  args: {
    event: WEBHOOK_EVENTS,
    data: v.any(),
    /** Present for order_created, so the log row can be linked to the order. */
    orderId: v.optional(v.id("orders")),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ success: boolean; responseStatus?: number; error?: string }> => {
    const webhookUrl = process.env.WEBHOOK_URL;
    const secret = process.env.WEBHOOK_SECRET;

    const timestamp = new Date().toISOString();
    const payloadStr = JSON.stringify({
      event: args.event,
      timestamp,
      data: args.data,
    });

    // Record the attempt, then link it to the order, so an event is traceable
    // even if every delivery attempt fails.
    const recordOutcome = async (outcome: {
      status: "sent" | "failed";
      responseStatus?: number;
      error?: string;
      attempts: number;
    }) => {
      const eventId = await ctx.runMutation(internal.webhooks.logWebhookEvent, {
        event: args.event,
        payload: payloadStr,
        status: outcome.status,
        responseStatus: outcome.responseStatus,
        error: outcome.error,
        attempts: outcome.attempts,
        orderId: args.orderId,
        deliveredAt: outcome.status === "sent" ? Date.now() : undefined,
      });

      if (args.orderId) {
        await ctx.runMutation(internal.enquiries.linkWebhookEvent, {
          orderId: args.orderId,
          webhookEventId: eventId,
        });
      }
    };

    if (!webhookUrl) {
      console.warn(
        "[Webhook] WEBHOOK_URL is not set — event logged but not delivered.",
        { event: args.event }
      );
      await recordOutcome({
        status: "failed",
        error: "WEBHOOK_URL environment variable is not configured.",
        attempts: 0,
      });
      return { success: false, error: "WEBHOOK_URL not configured" };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Printly-Event": args.event,
      "X-Printly-Timestamp": timestamp,
    };

    if (secret) {
      headers["X-Printly-Signature"] = `sha256=${await signPayload(payloadStr, secret)}`;
    } else {
      console.warn(
        "[Webhook] WEBHOOK_SECRET is not set — delivering unsigned. The receiver cannot verify this call."
      );
    }

    let last: { ok: boolean; status?: number; error?: string } = {
      ok: false,
      error: "No attempt made",
    };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      last = await postOnce(webhookUrl, payloadStr, headers);

      if (last.ok) {
        console.log("[Webhook] Delivered", {
          event: args.event,
          status: last.status,
          attempt,
        });
        await recordOutcome({
          status: "sent",
          responseStatus: last.status,
          attempts: attempt,
        });
        return { success: true, responseStatus: last.status };
      }

      // A non-retryable 4xx means the receiver rejected the payload itself —
      // retrying would just repeat the rejection.
      const retryable = last.status === undefined || isRetryableStatus(last.status);
      if (!retryable || attempt === MAX_ATTEMPTS) break;

      console.warn(
        `[Webhook] Attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying:`,
        last.error
      );
      await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 2_000);
    }

    console.error("[Webhook] Delivery failed", {
      event: args.event,
      error: last.error,
    });
    await recordOutcome({
      status: "failed",
      responseStatus: last.status,
      error: last.error,
      attempts: MAX_ATTEMPTS,
    });

    return { success: false, responseStatus: last.status, error: last.error };
  },
});
