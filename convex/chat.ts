"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { createOpenAI } from "@ai-sdk/openai";
import { createGateway } from "@ai-sdk/gateway";
import { generateText, embed } from "ai";
import { z } from "zod";

async function transcribeAudio(base64Audio: string, mimeType: string, apiKey: string): Promise<string> {
  const buffer = Buffer.from(base64Audio, "base64");
  const formData = new FormData();

  const ext = mimeType.split("/")[1]?.split(";")[0] || "webm";
  const blob = new Blob([buffer], { type: mimeType });
  formData.append("file", blob, `audio.${ext}`);
  formData.append("model", "whisper-1");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Whisper transcription failed: ${errorText}`);
  }

  const result = (await response.json()) as { text: string };
  return result.text;
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

    const useGateway = args.aiProvider === "gateway";
    const openai = createOpenAI({ apiKey: openaiApiKey });

    let chatModel: any;
    if (useGateway) {
      const gatewayApiKey = process.env.AI_GATEWAY_API_KEY;
      if (!gatewayApiKey) {
        throw new Error("Missing AI_GATEWAY_API_KEY environment variable.");
      }
      const aiGateway = createGateway({ apiKey: gatewayApiKey });
      chatModel = aiGateway("deepseek/deepseek-v4-flash");
    } else {
      chatModel = openai("gpt-4o-mini");
    }

    // 1. Identify user
    const user = await ctx.runQuery(internal.chat_db.getUserByPhone, {
      whatsappNumber: args.whatsappNumber,
    });

    if (!user) {
      return {
        inbound: { kind: args.kind },
        replies: [
          {
            type: "text",
            text: JSON.stringify({
              type: "message",
              message: "Welcome to Printly! No account was found for your number. Please sign up or sign in on the web interface to get started.",
            }),
          },
        ],
      };
    }

    // 2. Handle File Ingestion Flow
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
        filename: (ingestResult.success && ingestResult.filename ? ingestResult.filename : filename),
      });

      const replyText = ingestResult.success
        ? JSON.stringify({
            type: "message",
            message: `\u{1F4C4} Artwork/document "${ingestResult.filename}" uploaded successfully and attached to your enquiry.`,
          })
        : JSON.stringify({
            type: "message",
            message: `\u26A0\uFE0F Sorry, I was unable to process "${filename}". Please try uploading a valid document, PDF, or image file.`,
          });

      return {
        inbound: { kind: "upload", downloadUrl },
        replies: [{ type: "text", text: replyText }],
      };
    }

    // 3. Handle Voice or Text Queries
    let queryText = args.text || "";
    let transcript: string | undefined;

    if (args.kind === "voice" && args.audio) {
      try {
        transcript = await transcribeAudio(args.audio.base64, args.audio.mimeType, openaiApiKey);
        queryText = transcript;
      } catch (err) {
        console.error("Transcription error", err);
        return {
          inbound: { kind: "voice" },
          replies: [
            {
              type: "text",
              text: JSON.stringify({
                type: "message",
                message: "\u26A0\uFE0F Sorry, I could not transcribe your voice message. Please try again or send a text.",
              }),
            },
          ],
        };
      }
    }

    queryText = queryText.trim();
    if (!queryText) {
      return {
        inbound: { kind: args.kind, transcript },
        replies: [
          {
            type: "text",
            text: JSON.stringify({
              type: "message",
              message: "Please send a valid message or voice note.",
            }),
          },
        ],
      };
    }

    // 4. Retrieve RAG Context from system-user knowledge base
    let contextText = "";
    try {
      const systemUser = await ctx.runQuery(internal.chat_db.getUserByPhone, {
        whatsappNumber: "0000000000",
      });
      const systemUserId = systemUser?._id;

      if (systemUserId) {
        const { embedding } = await embed({
          model: openai.embedding("text-embedding-3-small"),
          value: queryText,
        });

        const matches = await ctx.vectorSearch("chunks", "by_embedding", {
          vector: embedding,
          limit: 8,
          filter: (q) => q.eq("userId", systemUserId),
        });

        if (matches.length > 0) {
          const chunkIds = matches.map((m) => m._id);
          const results = await ctx.runQuery(internal.chat_db.getChunksWithDocs, { chunkIds });
          contextText = results.map((r: any) => r.text).join("\n\n---\n\n");
        }
      }
    } catch (err) {
      console.error("Vector search / embedding retrieval failed", err);
    }

    // 5. Fetch recent chat history
    const historyMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    try {
      const recentMsgs = await ctx.runQuery(internal.chat_db.getRecentMessages, {
        userId: user._id,
        limit: 15,
      });

      const msgsToInclude = recentMsgs.filter((m: any) => {
        if (m.sender === "user" && m.text === queryText) return false;
        // Skip internal info_note messages from history
        if (m.text?.includes('"type":"info_note"')) return false;
        return true;
      });

      for (const m of msgsToInclude) {
        const role: "user" | "assistant" = m.sender === "user" ? "user" : "assistant";
        let content = m.text || "";

        if (content.trim().startsWith("{") && content.trim().endsWith("}")) {
          try {
            const parsed = JSON.parse(content);
            content = parsed.message || content;
          } catch { /* ignore */ }
        }

        historyMessages.push({ role, content });
      }
    } catch (err) {
      console.error("Failed to load chat history", err);
    }

    // 6. Build Printly system prompt (John – AI Sales Consultant for Printwell UK)
    const systemPrompt = `You are John, the Smart AI Sales Consultant for Printwell UK.
Your name is John. You work for Printwell UK. Never say you are an AI unless directly and sincerely asked.

ABOUT PRINTWELL UK:
Printwell UK provides professional printing, packaging, promotional merchandise, stationery, labels, stickers and bespoke print requirements for businesses and brands across the UK.
Printwell has more than 42 years of experience working with brands and businesses.
Website: https://printwell.co.uk/
Primary market: UK only. No international delivery.
Primary customers: Brands, Businesses, Start-ups, Corporate organisations, Retail, Hospitality, Events & Exhibitions, Agencies, E-commerce brands, Packaging brands.

YOUR PERSONALITY:
- Professional, Knowledgeable, Helpful, Clear, Consultative, Confident, Friendly, Business-focused, Emotionally intelligent, Caring
- NEVER sound: Robotic, Pushy, Overly sales-focused, Casual to the point of unprofessional, Overly enthusiastic, Argumentative, Certain when information is unavailable

YOUR CORE OBJECTIVE:
Convert qualified business printing enquiries into structured quotation requests.
The process is: Understand → Qualify → Capture → Validate → Route
NOT: Guess → Quote → Promise

YOUR INSTRUCTIONS:
1. Use UK English spelling (colour, personalised, enquiry, fulfil, organise, etc.)
2. If the customer speaks Hinglish (Hindi + English mix), mirror their language naturally. If English only, reply in English.
3. Keep responses concise (1–3 sentences). Ask only ONE question at a time.
4. NEVER invent product availability, pricing, turnaround times, or delivery commitments.
5. NEVER quote prices — not exact, estimated, or starting prices. Collect requirements for the team to quote.
6. NEVER recommend a product or format unless the customer asks.
7. DO NOT share prices when asked — politely explain that the team will prepare an accurate quotation once you have the full details.
8. Collect product specifications naturally, one question at a time.
9. Identify when a customer needs design help and offer to connect with a printing consultant.
10. Identify complaints and route to support.
11. Identify existing-customer enquiries and route appropriately.
12. Capture a COMPLETE new-business requirement before qualifying as a lead.

PRODUCTS PRINTWELL OFFERS:
Business Stationery, Business Cards, Letterheads, Booklets, Brochures, Flyers, Leaflets, Presentation Folders, Product Catalogues, Posters, Banners, Newsletters, Postcards, Labels, Stickers, Packaging, Promotional Merchandise, Clothing, Bags, Bespoke Corporate Items, Water Bottles, Pens, Coffee/Tea Mugs, Seasonal Cards, and other bespoke print requirements.

MATCHED PRINTWELL GUIDELINES (from knowledge base):
${contextText || "No specific matching guidelines found. Apply general professional UK printing consultancy rules."}

CUSTOMER PROFILE:
- Name: ${user.name || "Customer"}
- Phone: ${user.whatsappNumber}

AVAILABLE TOOLS:
You have three tools available to help you:
1. getProductDetails(productName) — call this to get the required specification fields for any product
2. createProtocol(orderData) — call this when you have collected ALL required information to create a structured quotation protocol
3. storeGeneralInfo(infoType, value) — call this to save any important customer information you discover (e.g. company name, email address)

JSON RESPONSE SCHEMA:
Every response MUST be a single valid JSON object. Choose the appropriate "type":

- Use "message" for normal conversation (asking qualification questions, explaining options).
- Use "agent" when the customer requests a human sales agent, printing consultant, or design help.
- Use "support" for complaints (poor quality, damaged items, late delivery, issues with an existing order).
- Use "customer" for existing order queries ("where is my order?", "change my order").
- Use "order" ONLY when a new printing enquiry is complete and you have collected ALL required information:
  • Customer Info: Name, Company (if available), Email, Phone
  • Product Details: Product, Quantity, Size/Material/Colour/Pages/Finish/Printing (all applicable)
  • Artwork Status (print-ready supplied, or Printwell to supply design)
  • Delivery Info: Full Address, Postcode, Required Delivery Date

SCHEMA FORMATS:

1. "message":
{"type":"message","message":"Your customer-facing response here (1-3 sentences)."}

2. "agent":
{"type":"agent","message":"One of our printing or design consultants will connect with you shortly.","data":{"customer_name":"${user.name || ""}","company_name":"","phone":"${user.whatsappNumber}","email":"","reason":"Design assistance / Special recommendation / Human requested","additional_details":""}}

3. "support":
{"type":"support","message":"I'm sorry to hear that. Our support team will assist you with this shortly.","data":{"customer_name":"${user.name || ""}","company_name":"","phone":"${user.whatsappNumber}","email":"","order_number":"","reason":"","additional_details":""}}

4. "customer":
{"type":"customer","message":"Our customer team will assist you with your existing order or account enquiry shortly.","data":{"customer_name":"${user.name || ""}","company_name":"","phone":"${user.whatsappNumber}","email":"","order_number":"","reason":"","additional_details":""}}

5. "order":
{"type":"order","message":"Thank you. We have all the details required. Our team will review your requirements and prepare a quotation shortly.","data":{"customer":{"full_name":"${user.name || ""}","company_name":"","email":"","phone":"${user.whatsappNumber}"},"order":{"product":"","quantity":"","size":"","material":"","colour":"","pages":"","finish":"","printing":"","artwork":"","delivery":{"postcode":"","address":"","required_delivery_date":""},"additional_details":""}}}

Do NOT wrap the JSON in markdown code blocks. Output raw JSON only, starting with { and ending with }.
Fill all "data" fields from the conversation, or leave as "" if unknown.`;

    // 7. Assemble message history
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      ...historyMessages,
      { role: "user", content: queryText },
    ];

    // 8. Define AI tools for the agent (using plain objects compatible with AI SDK)
    const agentTools = {
      getProductDetails: {
        description: "Get the required specification fields and details for a Printwell product. Call this when the customer mentions a product to know exactly what questions to ask.",
        parameters: z.object({
          productName: z.string().describe("The name of the product, e.g. 'Business Cards', 'Brochures', 'Banners'"),
        }),
        execute: async ({ productName }: { productName: string }) => {
          const result = await ctx.runAction(internal.products.getProductDetails, { productName });
          return result;
        },
      },
      createProtocol: {
        description: "Create a structured quotation protocol once all required information has been collected from the customer. Call this before outputting a type='order' response.",
        parameters: z.object({
          customerName: z.string().describe("Customer's full name"),
          companyName: z.string().optional().describe("Company name if provided"),
          phone: z.string().describe("Customer's phone number"),
          email: z.string().optional().describe("Customer's email address if provided"),
          product: z.string().describe("Product name e.g. Business Cards"),
          quantity: z.string().describe("Quantity required"),
          specifications: z.string().describe("JSON string of all product specs: size, material, colour, finish, pages, printing, embellishments etc."),
          artworkStatus: z.string().describe("Artwork status: print-ready supplied or Printwell to create"),
          deliveryAddress: z.string().describe("Full delivery address"),
          deliveryPostcode: z.string().describe("Delivery postcode"),
          requiredDeliveryDate: z.string().describe("Required delivery date"),
          additionalDetails: z.string().optional().describe("Any other special requirements"),
        }),
        execute: async (params: {
          customerName: string;
          companyName?: string;
          phone: string;
          email?: string;
          product: string;
          quantity: string;
          specifications: string;
          artworkStatus: string;
          deliveryAddress: string;
          deliveryPostcode: string;
          requiredDeliveryDate: string;
          additionalDetails?: string;
        }) => {
          const result = await ctx.runAction(internal.products.createProtocol, {
            customerName: params.customerName,
            companyName: params.companyName,
            phone: params.phone,
            email: params.email,
            product: params.product,
            quantity: params.quantity,
            specifications: params.specifications,
            artworkStatus: params.artworkStatus,
            deliveryAddress: params.deliveryAddress,
            deliveryPostcode: params.deliveryPostcode,
            requiredDeliveryDate: params.requiredDeliveryDate,
            additionalDetails: params.additionalDetails,
          });
          return result;
        },
      },
      storeGeneralInfo: {
        description: "Store important customer information discovered during the conversation (e.g. company name, email address, preferences). Call this as soon as you learn useful customer details.",
        parameters: z.object({
          infoType: z.string().describe("Type of information e.g. 'company_name', 'email', 'industry', 'preference'"),
          value: z.string().describe("The actual value to store"),
        }),
        execute: async ({ infoType, value }: { infoType: string; value: string }) => {
          const result = await ctx.runAction(internal.products.storeGeneralInfo, {
            userId: user._id,
            infoType,
            value,
          });
          return result;
        },
      },
    };

    // 9. Generate text with tools
    let rawResponse = "";
    try {
      const result = await generateText({
        model: chatModel,
        system: systemPrompt,
        messages,
        tools: agentTools,
        maxSteps: 5,
      } as any);
      rawResponse = result.text.trim();
    } catch (err) {
      console.error("AI generation failed:", err);
      rawResponse = JSON.stringify({
        type: "message",
        message: "I apologise, but I encountered an error. Could you please try again?",
      });
    }

    // 10. Parse response and trigger webhooks
    const replies: any[] = [];
    let parsedResponse: any = null;

    try {
      parsedResponse = JSON.parse(rawResponse);
      if (parsedResponse.type && parsedResponse.message) {
        replies.push({
          type: "text",
          text: JSON.stringify(parsedResponse),
        });
      } else {
        replies.push({
          type: "text",
          text: JSON.stringify({
            type: "message",
            message: parsedResponse.message || rawResponse,
          }),
        });
      }
    } catch {
      replies.push({
        type: "text",
        text: JSON.stringify({
          type: "message",
          message: rawResponse || "I'm sorry, I'm having trouble processing that request.",
        }),
      });
    }

    // 11. Trigger webhooks and persist order/agent records
    if (parsedResponse?.type === "order" && parsedResponse?.data) {
      try {
        const orderData = parsedResponse.data;
        const customerData = orderData.customer ?? {};
        const orderDetails = orderData.order ?? {};
        const delivery = orderDetails.delivery ?? {};

        // 11a. Persist order to DB first so we can link the webhook event ID
        const orderId = await ctx.runMutation(internal.orders.createOrder, {
          userId: user._id,
          whatsappNumber: user.whatsappNumber,
          customerName: customerData.full_name || user.name || "",
          companyName: customerData.company_name || undefined,
          email: customerData.email || undefined,
          phone: customerData.phone || user.whatsappNumber,
          product: orderDetails.product || "",
          quantity: orderDetails.quantity || "",
          size: orderDetails.size || undefined,
          material: orderDetails.material || undefined,
          colour: orderDetails.colour || undefined,
          pages: orderDetails.pages || undefined,
          finish: orderDetails.finish || undefined,
          printing: orderDetails.printing || undefined,
          artwork: orderDetails.artwork || "",
          additionalDetails: orderDetails.additional_details || undefined,
          deliveryAddress: delivery.address || undefined,
          deliveryPostcode: delivery.postcode || undefined,
          requiredDeliveryDate: delivery.required_delivery_date || undefined,
          rawPayload: rawResponse,
        });

        console.log("[Order] Saved to DB:", orderId);

        // 11b. Fire webhook
        await ctx.runAction(internal.webhooks.triggerWebhook, {
          event: "order_created",
          data: { ...parsedResponse.data, orderId },
        });
      } catch (orderErr) {
        console.error("Order save / webhook failed for order_created:", orderErr);
      }
    } else if (parsedResponse?.type === "agent" && parsedResponse?.data) {
      try {
        await ctx.runAction(internal.webhooks.triggerWebhook, {
          event: "human_agent",
          data: parsedResponse.data,
        });
      } catch (webhookErr) {
        console.error("Webhook trigger failed for human_agent:", webhookErr);
      }
    }


    return {
      inbound: {
        kind: args.kind,
        transcript,
      },
      replies,
    };
  },
});
