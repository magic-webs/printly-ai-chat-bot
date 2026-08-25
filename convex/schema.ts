import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    whatsappNumber: v.string(),
    passwordHash: v.string(),
    name: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_whatsappNumber", ["whatsappNumber"]),

  sessions: defineTable({
    userId: v.id("users"),
    token: v.string(),
    expiry: v.number(),
  }).index("by_token", ["token"]),

  documents: defineTable({
    userId: v.id("users"),
    title: v.string(),
    filename: v.string(),
    documentType: v.string(),
    category: v.string(),
    summary: v.string(),
    tags: v.array(v.string()),
    mimeType: v.string(),
    size: v.number(),
    r2Key: v.string(),
    status: v.union(v.literal("processing"), v.literal("ready"), v.literal("failed")),
    failureReason: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),

  chunks: defineTable({
    documentId: v.id("documents"),
    userId: v.id("users"),
    text: v.string(),
    embedding: v.array(v.float64()),
  })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["userId"],
    }),

  messages: defineTable({
    userId: v.id("users"),
    sender: v.union(v.literal("user"), v.literal("assistant")),
    kind: v.union(v.literal("text"), v.literal("voice"), v.literal("upload"), v.literal("document"), v.literal("transcript"), v.literal("error")),
    text: v.optional(v.string()),
    audioUrl: v.optional(v.string()),
    durationSec: v.optional(v.number()),
    filename: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    downloadUrl: v.optional(v.string()),
    previewUrl: v.optional(v.string()),
    status: v.optional(v.union(v.literal("sending"), v.literal("sent"), v.literal("error"))),
    timestamp: v.number(),
  }).index("by_user", ["userId"]),

  // Printwell product catalogue — 25 products with structured requirement fields
  products: defineTable({
    slug: v.string(),
    name: v.string(),
    category: v.string(),
    description: v.string(),
    requirementFields: v.array(v.string()),
    exampleSpec: v.optional(v.string()),
    notes: v.optional(v.string()),
  }).index("by_slug", ["slug"]),

  // Log of outgoing webhook calls (order_created, human_agent)
  webhookEvents: defineTable({
    event: v.string(),
    payload: v.string(), // JSON-stringified payload
    status: v.union(v.literal("sent"), v.literal("failed")),
    responseStatus: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_event", ["event"]),
});
