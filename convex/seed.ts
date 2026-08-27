"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";
import * as fs from "fs";
import * as path from "path";
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

// ---------------------------------------------------------------------------
// reseedKnowledgeBase – wipes old system-user embeddings and re-seeds from
// `PrintWell  – Knowledge Base.md` (the authoritative source of truth).
// Run this after updating the markdown to refresh the vector knowledge base.
// ---------------------------------------------------------------------------
export const reseedKnowledgeBase = action({
  args: {
    // Optional: pass the markdown content directly (when calling from CLI/script).
    // If omitted, the action will attempt to read from disk (works only in local dev Node context).
    markdownContent: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{
    success: boolean;
    message: string;
    chunks: number;
    productsInserted: number;
  }> => {
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      throw new Error("Missing OPENAI_API_KEY environment variable.");
    }

    // 1. Create or get system user
    const systemUserId = await ctx.runMutation(api.users.createSystemUser);

    // 2. Delete ALL existing documents + chunks owned by system user
    console.log("Deleting old system-user documents and embeddings...");
    const existingDocs = await ctx.runQuery(internal.chat_db.listDocumentsInternal, {
      userId: systemUserId,
    });

    for (const doc of existingDocs) {
      await ctx.runMutation(internal.seed_helpers.deleteChunksByDocument, {
        documentId: doc._id,
      });
      await ctx.runMutation(internal.seed_helpers.deleteDocument, {
        documentId: doc._id,
      });
    }

    console.log(`Deleted ${existingDocs.length} old document(s) and their embeddings.`);

    // 3. Use provided content or try to read from disk
    let markdownContent = args.markdownContent || "";

    if (!markdownContent) {
      // Try to read from disk (works in local Node.js context)
      // The knowledge base filename contains an en dash and a double space.
      const KNOWLEDGE_BASE_FILE = "PrintWell  – Knowledge Base.md";
      const possiblePaths = [
        KNOWLEDGE_BASE_FILE,
        path.join(process.cwd(), KNOWLEDGE_BASE_FILE),
      ];

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          console.log("Reading markdown file:", p);
          markdownContent = fs.readFileSync(p, "utf-8").trim();
          break;
        }
      }
    }

    if (!markdownContent) {
      throw new Error(
        "No markdown content provided and the knowledge base markdown was not found on disk. Pass the file content via the markdownContent argument."
      );
    }

    console.log(`Read ${markdownContent.length} characters from markdown.`);

    // 4. Chunk and embed
    const chunks = chunkText(markdownContent, 1000, 200);
    console.log(`Split into ${chunks.length} chunks.`);

    const openai = createOpenAI({ apiKey: openaiApiKey });
    const { embeddings } = await embedMany({
      model: openai.embedding("text-embedding-3-small"),
      values: chunks,
    });

    // 5. Create document record
    const documentId = await ctx.runMutation(internal.documents.createDocumentInternal, {
      userId: systemUserId,
      filename: "PrintWell – Knowledge Base.md",
      mimeType: "text/markdown",
      size: Buffer.byteLength(markdownContent, "utf-8"),
      r2Key: "system-seeded-knowledge-base-md",
    });

    // 6. Insert chunks
    const chunkRecords = chunks.map((text, idx) => ({
      text,
      embedding: embeddings[idx],
    }));

    await ctx.runMutation(internal.documents.insertChunks, {
      documentId,
      userId: systemUserId,
      chunks: chunkRecords,
    });

    // 7. Update document status
    await ctx.runMutation(internal.documents.updateDocumentDetails, {
      documentId,
      title: "Printwell UK AI Sales Knowledge Base",
      filename: "PrintWell – Knowledge Base.md",
      category: "Guidelines",
      summary: "Persona, conversation rules, product requirements, routing map and FAQs for John, the Printwell UK AI sales consultant.",
      tags: ["printwell", "guidelines", "rules", "products", "faq"],
      status: "ready",
    });

    // 8. Also seed products table (idempotent)
    const productResult: { inserted: number; total: number } = await ctx.runMutation(internal.products.seedProducts);
    console.log(`Products seeded: ${productResult.inserted} new, ${productResult.total} total.`);

    console.log("Reseed complete. Fresh embeddings loaded from the Printwell knowledge base.");
    return {
      success: true,
      message: `Reseed complete. ${chunks.length} chunks embedded from the Printwell knowledge base. Products: ${productResult.inserted} new inserted.`,
      chunks: chunks.length,
      productsInserted: productResult.inserted,
    };
  },
});

// ---------------------------------------------------------------------------
// seedKnowledgeBase – legacy PDF-based seed (kept for backward compatibility)
// Use reseedKnowledgeBase instead for fresh embeds from the markdown file.
// ---------------------------------------------------------------------------
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

    const isAlreadySeeded = existingDocs.some(
      (d: { filename: string }) => d.filename === "Printly - AI Sales Consultant.pdf"
    );
    if (isAlreadySeeded && !args.force) {
      console.log("Printly \u2013 AI Sales Consultant.pdf guidelines already seeded under system user.");
      return { success: true, message: "Already seeded" };
    }

    // 3. Read PDF from local disk
    const pdfPath = "Printly - AI Sales Consultant.pdf";
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
      filename: "Printly - AI Sales Consultant.pdf",
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
      filename: "Printly - AI Sales Consultant.pdf",
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
