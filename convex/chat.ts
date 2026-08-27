"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { createOpenAI } from "@ai-sdk/openai";
import { createGateway } from "@ai-sdk/gateway";
import { generateText, embed, tool, stepCountIs } from "ai";
import { z } from "zod";
import { buildSystemPrompt } from "./agent/prompt";
import {
  evaluateCompleteness,
  formatOrderConfirmation,
  formatRoutedMessage,
  toSnapshot,
  type EnquirySnapshot,
} from "./agent/enquiry";

/** Every turn is capped at this many model steps (tool call + follow-up). */
const MAX_AGENT_STEPS = 8;
/** Turns of prior conversation replayed as context. */
const HISTORY_LIMIT = 15;

async function transcribeAudio(
  base64Audio: string,
  mimeType: string,
  apiKey: string
): Promise<string> {
  const buffer = Buffer.from(base64Audio, "base64");
  const formData = new FormData();

  const ext = mimeType.split("/")[1]?.split(";")[0] || "webm";
  const blob = new Blob([buffer], { type: mimeType });
  formData.append("file", blob, `audio.${ext}`);
  formData.append("model", "whisper-1");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Whisper transcription failed: ${errorText}`);
  }

  const result = (await response.json()) as { text: string };
  return result.text;
}

/** Wrap a plain string as the single display-ready reply the transports expect. */
function textReply(kind: string, text: string, extra?: Record<string, unknown>) {
  return {
    inbound: { kind, ...(extra ?? {}) },
    replies: [{ type: "text", text }],
  };
}

export const simulate = action({
  args: {
    kind: v.union(v.literal("text"), v.literal("voice"), v.literal("upload")),
    whatsappNumber: v.string(),
    text: v.optional(v.string()),
    audio: v.optional(
      v.object({
        base64: v.string(),
        mimeType: v.string(),
      })
    ),
    file: v.optional(
      v.object({
        base64: v.string(),
        mimeType: v.string(),
        filename: v.optional(v.string()),
      })
    ),
    aiProvider: v.optional(v.union(v.literal("openai"), v.literal("gateway"))),
  },
  handler: async (ctx, args): Promise<any> => {
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      throw new Error("Missing OPENAI_API_KEY environment variable.");
    }

    const openai = createOpenAI({ apiKey: openaiApiKey });

    let chatModel: any;
    if (args.aiProvider === "gateway") {
      const gatewayApiKey = process.env.AI_GATEWAY_API_KEY;
      if (!gatewayApiKey) {
        throw new Error("Missing AI_GATEWAY_API_KEY environment variable.");
      }
      chatModel = createGateway({ apiKey: gatewayApiKey })("deepseek/deepseek-v4-flash");
    } else {
      chatModel = openai("gpt-4o-mini");
    }

    // ---- 1. Identify the customer ----------------------------------------
    const user = await ctx.runQuery(internal.chat_db.getUserByPhone, {
      whatsappNumber: args.whatsappNumber,
    });

    if (!user) {
      return textReply(
        args.kind,
        "Welcome to Printwell! No account was found for your number. Please sign up or sign in on the web interface to get started."
      );
    }

    // ---- 2. File ingestion ------------------------------------------------
    if (args.kind === "upload" && args.file) {
      const filename = args.file.filename || "Uploaded_Document";

      const uploadResult = await ctx.runAction(internal.r2.uploadFile, {
        base64Data: args.file.base64,
        mimeType: args.file.mimeType,
        filename,
      });

      const docId = await ctx.runMutation(internal.documents.createDocumentInternal, {
        userId: user._id,
        filename,
        mimeType: args.file.mimeType,
        size: uploadResult.size,
        r2Key: uploadResult.r2Key,
      });

      const ingestResult = await ctx.runAction(internal.ingest.processDocument, {
        documentId: docId,
        userId: user._id,
        r2Key: uploadResult.r2Key,
        mimeType: args.file.mimeType,
        filename,
      });

      const downloadUrl: string = await ctx.runAction(api.r2.getDownloadUrl, {
        r2Key: uploadResult.r2Key,
        filename:
          ingestResult.success && ingestResult.filename
            ? ingestResult.filename
            : filename,
      });

      if (ingestResult.success) {
        // Record the artwork against the open enquiry so the team receives it
        // alongside the specification.
        await ctx.runMutation(internal.enquiries.saveEnquiryDetails, {
          userId: user._id,
          whatsappNumber: user.whatsappNumber,
          artwork: `Customer supplied file: ${ingestResult.filename}`,
        });
      }

      return textReply(
        "upload",
        ingestResult.success
          ? `\u{1F4C4} Artwork/document "${ingestResult.filename}" uploaded successfully and attached to your enquiry.`
          : `⚠️ Sorry, I was unable to process "${filename}". Please try uploading a valid document, PDF, or image file.`,
        { downloadUrl }
      );
    }

    // ---- 3. Voice / text --------------------------------------------------
    let queryText = args.text || "";
    let transcript: string | undefined;

    if (args.kind === "voice" && args.audio) {
      try {
        transcript = await transcribeAudio(
          args.audio.base64,
          args.audio.mimeType,
          openaiApiKey
        );
        queryText = transcript;
      } catch (err) {
        console.error("Transcription error", err);
        return textReply(
          "voice",
          "⚠️ Sorry, I could not transcribe your voice message. Please try again or send a text."
        );
      }
    }

    queryText = queryText.trim();
    if (!queryText) {
      return textReply(args.kind, "Please send a valid message or voice note.", {
        transcript,
      });
    }

    // ---- 4. Retrieve knowledge-base context -------------------------------
    let contextText = "";
    try {
      const systemUser = await ctx.runQuery(internal.chat_db.getUserByPhone, {
        whatsappNumber: "0000000000",
      });

      if (systemUser?._id) {
        const { embedding } = await embed({
          model: openai.embedding("text-embedding-3-small"),
          value: queryText,
        });

        const matches = await ctx.vectorSearch("chunks", "by_embedding", {
          vector: embedding,
          limit: 8,
          filter: (q) => q.eq("userId", systemUser._id),
        });

        if (matches.length > 0) {
          const results = await ctx.runQuery(internal.chat_db.getChunksWithDocs, {
            chunkIds: matches.map((m) => m._id),
          });
          contextText = results.map((r: any) => r.text).join("\n\n---\n\n");
        }
      }
    } catch (err) {
      console.error("Vector search / embedding retrieval failed", err);
    }

    // ---- 5. Load the open enquiry so the agent knows what it already has ---
    let enquirySnapshot: EnquirySnapshot = {};
    try {
      const activeEnquiry = await ctx.runQuery(internal.enquiries.getActiveEnquiry, {
        userId: user._id,
      });
      if (activeEnquiry) {
        enquirySnapshot = toSnapshot(activeEnquiry as Record<string, unknown>);
      }
    } catch (err) {
      console.error("Failed to load active enquiry", err);
    }
    const { missing } = evaluateCompleteness(enquirySnapshot);

    // ---- 6. Conversation history -----------------------------------------
    const historyMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    try {
      const recentMsgs = await ctx.runQuery(internal.chat_db.getRecentMessages, {
        userId: user._id,
        limit: HISTORY_LIMIT,
      });

      for (const m of recentMsgs) {
        // The inbound message is appended separately below.
        if (m.sender === "user" && m.text === queryText) continue;
        const content = (m.text || "").trim();
        if (!content) continue;
        // Legacy rows written by the retired storeGeneralInfo tool. Replaying
        // them would feed raw JSON back into the conversation.
        if (content.includes('"type":"info_note"')) continue;
        historyMessages.push({
          role: m.sender === "user" ? "user" : "assistant",
          content,
        });
      }
    } catch (err) {
      console.error("Failed to load chat history", err);
    }

    // ---- 7. Tools ---------------------------------------------------------
    // Outcomes recorded by the tools, used to shape the customer-facing reply.
    let submission: { captured: EnquirySnapshot } | null = null;
    let routed: { kind: "agent" | "support" | "customer" } | null = null;

    const agentTools = {
      getProductDetails: tool({
        description:
          "Look up the specification fields Printwell needs for a product. Call this as soon as you know which product the customer wants, and let the returned fields drive your questions.",
        inputSchema: z.object({
          productName: z
            .string()
            .describe("Product name, e.g. 'Business Cards', 'Brochures', 'Banners'"),
        }),
        execute: async ({ productName }) => {
          const product = await ctx.runQuery(internal.products.getProductByName, {
            name: productName,
          });

          if (!product) {
            return {
              found: false,
              hint: "No exact match. Ask the customer to describe what they want to print, then try again with a closer product name.",
            };
          }

          return {
            found: true,
            name: product.name,
            slug: product.slug,
            category: product.category,
            requirementFields: product.requirementFields,
            exampleSpec: product.exampleSpec,
            notes: product.notes,
          };
        },
      }),

      saveEnquiryDetails: tool({
        description:
          "Save details the customer has given you. Call this every time you learn something new. Pass only the fields you actually learned — omit the rest. Returns what is still outstanding.",
        inputSchema: z.object({
          customerName: z.string().optional().describe("Customer's full name"),
          companyName: z.string().optional(),
          email: z.string().optional(),
          phone: z.string().optional(),
          product: z.string().optional().describe("Product name, e.g. Business Cards"),
          productSlug: z
            .string()
            .optional()
            .describe("Slug returned by getProductDetails"),
          quantity: z.string().optional(),
          size: z.string().optional().describe("Size or dimensions"),
          material: z.string().optional().describe("Paper, card or material"),
          colour: z.string().optional().describe("Colour / printing colours"),
          pages: z.string().optional().describe("Page count for multi-page products"),
          finish: z.string().optional().describe("Finish, binding or embellishments"),
          printing: z.string().optional().describe("Single or double sided, print method"),
          artwork: z
            .string()
            .optional()
            .describe("Artwork status: print-ready supplied, or Printwell to design"),
          deliveryAddress: z.string().optional(),
          deliveryPostcode: z.string().optional(),
          requiredDeliveryDate: z.string().optional(),
          additionalDetails: z.string().optional(),
        }),
        execute: async (fields) => {
          const result = await ctx.runMutation(
            internal.enquiries.saveEnquiryDetails,
            {
              userId: user._id,
              whatsappNumber: user.whatsappNumber,
              ...fields,
            }
          );
          return {
            saved: result.saved,
            stillRequired: result.missing,
            readyToSubmit: result.complete,
          };
        },
      }),

      submitQuotationRequest: tool({
        description:
          "Raise the structured quotation request. Only call this once every mandatory field is captured AND the customer has explicitly confirmed the summary you showed them. The server re-checks completeness and will refuse if anything is missing.",
        inputSchema: z.object({
          customerConfirmed: z
            .boolean()
            .describe("True only if the customer explicitly confirmed the summary."),
        }),
        execute: async ({ customerConfirmed }) => {
          if (!customerConfirmed) {
            return {
              submitted: false,
              reason:
                "Summarise the captured requirements and ask the customer to confirm before submitting.",
            };
          }

          const result = await ctx.runMutation(
            internal.enquiries.submitQuotationRequest,
            {
              userId: user._id,
              whatsappNumber: user.whatsappNumber,
            }
          );

          if (!result.submitted) {
            return {
              submitted: false,
              stillRequired: result.missing,
              reason:
                "Cannot submit yet — ask the customer for the outstanding fields listed in stillRequired.",
            };
          }

          submission = { captured: result.captured };
          return {
            submitted: true,
            note: "The customer has been sent a full confirmation summary automatically. Keep your reply brief and do not repeat the details.",
          };
        },
      }),

      routeToTeam: tool({
        description:
          "Hand the conversation to a human team. Use for consultant/design/contact requests (agent), complaints (support), or existing order and account queries (customer).",
        inputSchema: z.object({
          kind: z
            .enum(["agent", "support", "customer"])
            .describe(
              "agent = wants a human/consultant/design help/contact details; support = complaint; customer = existing order or account query"
            ),
          reason: z.string().describe("Short description of what the customer needs"),
          orderNumber: z.string().optional().describe("Order reference, if mentioned"),
          customerName: z.string().optional(),
          companyName: z.string().optional(),
          email: z.string().optional(),
          additionalDetails: z.string().optional(),
        }),
        execute: async (params) => {
          await ctx.runMutation(internal.enquiries.routeToTeam, {
            userId: user._id,
            whatsappNumber: user.whatsappNumber,
            ...params,
          });
          routed = { kind: params.kind };
          return {
            routed: true,
            note: "The team has been notified. Reassure the customer briefly that someone will be in touch.",
          };
        },
      }),
    };

    // ---- 8. Generate ------------------------------------------------------
    let assistantText = "";
    try {
      const result = await generateText({
        model: chatModel,
        system: buildSystemPrompt({
          customerName: user.name,
          whatsappNumber: user.whatsappNumber,
          knowledgeBaseContext: contextText,
          enquiry: enquirySnapshot,
          missingFields: missing,
        }),
        messages: [...historyMessages, { role: "user", content: queryText }],
        tools: agentTools,
        // Without this the run stops at the first tool call and returns no text.
        stopWhen: stepCountIs(MAX_AGENT_STEPS),
      });

      assistantText = result.text?.trim() ?? "";
    } catch (err) {
      console.error("AI generation failed:", err);
      return textReply(
        args.kind,
        "I do apologise — something went wrong on my side. Could you please send that again?",
        { transcript }
      );
    }

    // ---- 9. Shape the customer-facing reply -------------------------------
    let displayText: string;

    if (submission) {
      displayText = formatOrderConfirmation(
        (submission as { captured: EnquirySnapshot }).captured,
        assistantText
      );
    } else if (routed) {
      const kind = (routed as { kind: "agent" | "support" | "customer" }).kind;
      const fallback =
        kind === "agent"
          ? "One of our printing consultants will be in touch with you shortly."
          : kind === "support"
            ? "I'm sorry about that. Our support team will pick this up and get back to you shortly."
            : "Our customer team will look into this and come back to you shortly.";
      displayText = formatRoutedMessage(kind, assistantText || fallback);
    } else {
      displayText =
        assistantText ||
        "Thank you for your message. Could you tell me a little more about what you're looking to print?";
    }

    return textReply(args.kind, displayText, { transcript });
  },
});
