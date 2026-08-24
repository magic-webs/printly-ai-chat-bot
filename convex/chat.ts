"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { createOpenAI } from "@ai-sdk/openai";
import { createGateway } from "@ai-sdk/gateway";
import { generateText, embed } from "ai";

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
              message: "Welcome to Printly AI Bot! No account was found for your phone number. Please sign up or sign in on the web interface to get started.",
            }),
          },
        ],
      };
    }

    // 2. Handle File Ingestion Flow
    if (args.kind === "upload" && args.file) {
      const filename = args.file.filename || "Uploaded_Document";

      // Upload file to R2
      const uploadResult = await ctx.runAction(internal.r2.uploadFile, {
        base64Data: args.file.base64,
        mimeType: args.file.mimeType,
        filename,
      });

      // Create document entry in Convex
      const docId = await ctx.runMutation(internal.documents.createDocumentInternal, {
        userId: user._id,
        filename,
        mimeType: args.file.mimeType,
        size: uploadResult.size,
        r2Key: uploadResult.r2Key,
      });

      // Run the ingestion task (which runs without metadata generation now)
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
            message: `📄 Artwork/document "${ingestResult.filename}" uploaded successfully and attached to your inquiry.`,
          })
        : JSON.stringify({
            type: "message",
            message: `⚠️ Sorry, I was unable to process "${filename}". Please try uploading a valid document, PDF, or image file.`,
          });

      return {
        inbound: { kind: "upload", downloadUrl },
        replies: [
          {
            type: "text",
            text: replyText,
          },
        ],
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
                message: "⚠️ Sorry, I could not transcribe your voice message. Please try again or send a text.",
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

    // 4. Retrieve RAG Context from the Seeding Guidelines PDF owned by the system user (0000000000)
    let contextText = "";
    try {
      // Lookup the system user
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

      // Filter out duplicate user text
      const msgsToInclude = recentMsgs.filter((m) => {
        if (m.sender === "user" && m.text === queryText) return false;
        return true;
      });

      for (const m of msgsToInclude) {
        const role: "user" | "assistant" = m.sender === "user" ? "user" : "assistant";
        let content = m.text || "";

        // If it is a stored JSON, try to extract the user message or clean representation
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

    // 6. Build Printly system prompt
    const systemPrompt = `You are Printly, the Smart AI Sales Consultant for Printwell UK.
Printwell UK provides professional printing, packaging, and promotional merchandise for business customers across the UK.

YOUR CORE INSTRUCTIONS:
1. ALWAYS output your response as a valid JSON object matching the schema below. NEVER output plain text or conversational greetings outside of this JSON.
2. Use UK English spelling and terminology (e.g. colour, personalised, enquiry).
3. If the user speaks Hinglish (Hindi + English), mirror their Hinglish naturally. If they speak English, reply in English.
4. Keep normal responses concise (1-3 sentences).
5. NEVER invent product availability, pricing, turnaround times, or delivery commitments.
6. NEVER quote prices (exact, estimated, or starting prices). Your job is to collect requirements and arrange for the team to provide a quote.
7. Focus on collecting product specifications (product, quantity, size, material, finish, colour, binding, pages, artwork status) and delivery info (address, postcode, required delivery date) naturally, asking one question at a time.

MATCHED PRINTWELL GUIDELINES (RAG context):
${contextText || "No matching guidelines found on the matching query. Adhere to general professional printing rules."}

CUSTOMER PROFILE:
- Name: ${user.name || "Customer"}
- Phone: ${user.whatsappNumber}

JSON RESPONSE SCHEMA:
Every response must be a single JSON object. Choose the appropriate "type" based on the status of the conversation:

- Use "message" for normal conversation (e.g. asking qualification questions).
- Use "agent" when the user requests a human sales agent, printing consultant, design help, or complex custom recommendation.
- Use "support" for complaints (poor quality, damaged items, late delivery).
- Use "customer" for existing order queries ("where is my order?", "change my existing order").
- Use "order" ONLY when a new printing inquiry is complete and you have collected all required information:
  - Customer Info: Name, Company (if available), Email, Phone
  - Product Details: Product, Quantity, Size/Material/Colour/Pages/Finish/Printing (if applicable), Artwork Status
  - Delivery Info: Full Address, Postcode, Required Delivery Date

SCHEMA FORMATS:

1. Type "message":
{
  "type": "message",
  "message": "Write your customer-facing response here (1-3 sentences, asking for 1 requirement at a time)."
}

2. Type "agent":
{
  "type": "agent",
  "message": "One of our printing or design consultants will connect with you shortly.",
  "data": {
    "customer_name": "${user.name || ""}",
    "company_name": "",
    "phone": "${user.whatsappNumber}",
    "email": "",
    "reason": "Design assistance / Special recommendation / Human requested",
    "additional_details": ""
  }
}

3. Type "support":
{
  "type": "support",
  "message": "I'm sorry to hear that. Our support team will assist you with this shortly.",
  "data": {
    "customer_name": "${user.name || ""}",
    "company_name": "",
    "phone": "${user.whatsappNumber}",
    "email": "",
    "order_number": "",
    "reason": "Customer complaint details",
    "additional_details": ""
  }
}

4. Type "customer":
{
  "type": "customer",
  "message": "Our customer team will assist you with your existing order or account enquiry shortly.",
  "data": {
    "customer_name": "${user.name || ""}",
    "company_name": "",
    "phone": "${user.whatsappNumber}",
    "email": "",
    "order_number": "",
    "reason": "Existing order enquiry details",
    "additional_details": ""
  }
}

5. Type "order":
{
  "type": "order",
  "message": "Thank you. We have all the details required for your enquiry. Our team will review the requirements and prepare a quotation.",
  "data": {
    "customer": {
      "full_name": "${user.name || ""}",
      "company_name": "",
      "email": "",
      "phone": "${user.whatsappNumber}"
    },
    "order": {
      "product": "Name of product, e.g. Business Cards",
      "quantity": "Quantity requested",
      "size": "Size, e.g. A4",
      "material": "Material, e.g. 170gsm Silk",
      "colour": "e.g. Full colour",
      "pages": "e.g. 8 pages",
      "finish": "e.g. Matt laminate",
      "printing": "e.g. Double sided",
      "artwork": "Artwork status (e.g. Print-ready artwork available)",
      "delivery": {
        "postcode": "Delivery postcode",
        "address": "Full delivery address",
        "required_delivery_date": "Required delivery date"
      },
      "additional_details": "Any special requirements or notes"
    }
  }
}

Do not include markdown blocks like \`\`\`json ... \`\`\` around the JSON response. Output raw JSON starting with { and ending with } directly. Ensure all variables in "data" are filled in from the conversation, or left as empty strings "" if unknown.`;

    // 7. Assemble message history
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      ...historyMessages,
      { role: "user", content: queryText },
    ];

    // 8. Generate text
    let rawResponse = "";
    try {
      const result = await generateText({
        model: chatModel,
        system: systemPrompt,
        messages,
      });
      rawResponse = result.text.trim();
    } catch (err) {
      console.error("OpenAI generation failed:", err);
      rawResponse = JSON.stringify({
        type: "message",
        message: "I apologize, but I encountered an error. Could you please try again?",
      });
    }

    // 9. Format response to return
    const replies: any[] = [];
    try {
      const parsed = JSON.parse(rawResponse);
      if (parsed.type && parsed.message) {
        replies.push({
          type: "text",
          text: JSON.stringify(parsed),
        });
      } else {
        replies.push({
          type: "text",
          text: JSON.stringify({
            type: "message",
            message: parsed.message || rawResponse,
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

    return {
      inbound: {
        kind: args.kind,
        transcript,
      },
      replies,
    };
  },
});
