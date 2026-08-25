import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// ---------------------------------------------------------------------------
// Helper mutations for reseedKnowledgeBase — kept in a separate file because
// seed.ts uses "use node" (required for PDF parsing / fs access), but Convex
// does not allow mutations in Node.js files.
// ---------------------------------------------------------------------------

export const deleteChunksByDocument = internalMutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const chunks = await ctx.db
      .query("chunks")
      .filter((q) => q.eq(q.field("documentId"), args.documentId))
      .collect();
    for (const chunk of chunks) {
      await ctx.db.delete(chunk._id);
    }
    return { deleted: chunks.length };
  },
});

export const deleteDocument = internalMutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.documentId);
  },
});
