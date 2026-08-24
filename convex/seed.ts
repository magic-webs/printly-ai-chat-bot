"use node";

import { action, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";
import * as fs from "fs";
// @ts-ignore
import pdf from "pdf-parse-fork";

function chunkText(text: string, chunkSize = 1000, overlap = 200): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + chunkSize));
    i += chunkSize - overlap;
    if (chunkSize - overlap <= 0) break;
  }
  return chunks;
}

export const seedKnowledgeBase = action({
  args: {
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      throw new Error("Missing OPENAI_API_KEY environment variable.");
    }

    // 1. Create or get system user
    const systemUserId = await ctx.runMutation(api.users.createSystemUser);

    // 2. Check if already seeded (unless force = true)
    const existingDocs = await ctx.runQuery(internal.chat_db.listDocumentsInternal, {
      userId: systemUserId,
    });

    const isAlreadySeeded = existingDocs.some(d => d.filename === "Printly – AI Sales Consultant.pdf");
    if (isAlreadySeeded && !args.force) {
      console.log("Printly – AI Sales Consultant.pdf guidelines already seeded under system user.");
      return { success: true, message: "Already seeded" };
    }

    // 3. Read PDF from local disk
    const pdfPath = "Printly – AI Sales Consultant.pdf";
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`Knowledge base PDF not found at path: ${pdfPath}`);
    }

    console.log("Reading PDF file:", pdfPath);
    const fileBuffer = fs.readFileSync(pdfPath);

    // 4. Extract text from PDF
    console.log("Extracting text from PDF...");
    const parsed = await pdf(fileBuffer);
    const extractedText = (parsed.text || "").trim();

    if (!extractedText) {
      throw new Error("No text content could be extracted from the PDF.");
    }

    console.log(`Extracted ${extractedText.length} characters of text.`);

    // 5. Chunk text
    const chunks = chunkText(extractedText);
    console.log(`Split text into ${chunks.length} chunks.`);

    // 6. Generate embeddings
    console.log("Generating embeddings via OpenAI...");
    const openai = createOpenAI({ apiKey: openaiApiKey });
    const { embeddings } = await embedMany({
      model: openai.embedding("text-embedding-3-small"),
      values: chunks,
    });

    // 7. Create document record
    console.log("Creating document entry in database...");
    const documentId = await ctx.runMutation(internal.documents.createDocumentInternal, {
      userId: systemUserId,
      filename: "Printly – AI Sales Consultant.pdf",
      mimeType: "application/pdf",
      size: fileBuffer.length,
      r2Key: "system-seeded-knowledge-base",
    });

    // 8. Insert chunks
    console.log("Inserting chunks into database...");
    const chunkRecords = chunks.map((text, idx) => ({
      text,
      embedding: embeddings[idx],
    }));

    await ctx.runMutation(internal.documents.insertChunks, {
      documentId,
      userId: systemUserId,
      chunks: chunkRecords,
    });

    // Update document status to ready
    await ctx.runMutation(internal.documents.updateDocumentDetails, {
      documentId,
      title: "Printly AI Sales Consultant Guidelines",
      filename: "Printly – AI Sales Consultant.pdf",
      category: "Guidelines",
      summary: "Master prompt and rules for Printly, the AI Sales Consultant.",
      tags: ["printly", "guidelines", "rules"],
      status: "ready",
    });

    console.log("Seeding complete. Printly guidelines loaded successfully.");
    return {
      success: true,
      message: `Successfully seeded Printly knowledge base. Chunks loaded: ${chunks.length}`,
    };
  },
});


