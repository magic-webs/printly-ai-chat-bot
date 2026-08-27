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

  // Log of outgoing webhook calls (order_created, human_agent, support_request,
  // customer_enquiry). One row per delivery attempt series.
  webhookEvents: defineTable({
    event: v.string(),
    payload: v.string(), // JSON-stringified payload
    status: v.union(v.literal("pending"), v.literal("sent"), v.literal("failed")),
    responseStatus: v.optional(v.number()),
    error: v.optional(v.string()),
    attempts: v.optional(v.number()),      // how many HTTP attempts were made
    orderId: v.optional(v.id("orders")),   // set for order_created events
    createdAt: v.number(),
    deliveredAt: v.optional(v.number()),
  })
    .index("by_event", ["event"])
    .index("by_order", ["orderId"])
    .index("by_status", ["status"]),

  // In-progress enquiry state. The agent writes captured requirement fields here
  // turn by turn via the saveEnquiryDetails tool, so a specification survives
  // even if the model does not repeat it in a later message. The completeness
  // gate (KB section 30) is evaluated against THIS record, not against whatever
  // the model happens to echo back.
  enquiries: defineTable({
    userId: v.id("users"),
    whatsappNumber: v.string(),
    status: v.union(
      v.literal("collecting"), // actively being qualified
      v.literal("submitted"),  // converted into an order
      v.literal("abandoned")
    ),

    // Customer info
    customerName: v.optional(v.string()),
    companyName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),

    // Product / specification
    product: v.optional(v.string()),
    productSlug: v.optional(v.string()),
    quantity: v.optional(v.string()),
    size: v.optional(v.string()),
    material: v.optional(v.string()),
    colour: v.optional(v.string()),
    pages: v.optional(v.string()),
    finish: v.optional(v.string()),
    printing: v.optional(v.string()),
    artwork: v.optional(v.string()),
    additionalDetails: v.optional(v.string()),

    // Delivery
    deliveryAddress: v.optional(v.string()),
    deliveryPostcode: v.optional(v.string()),
    requiredDeliveryDate: v.optional(v.string()),

    orderId: v.optional(v.id("orders")), // set once submitted
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_and_status", ["userId", "status"])
    .index("by_user", ["userId"]),

  // Orders — stored whenever the AI collects a complete printing enquiry (type: "order")
  orders: defineTable({
    // Customer info
    userId: v.optional(v.id("users")),       // linked Convex user if known
    whatsappNumber: v.string(),
    customerName: v.string(),
    companyName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.string(),

    // Product / order details
    product: v.string(),
    productSlug: v.optional(v.string()),
    quantity: v.string(),
    size: v.optional(v.string()),
    material: v.optional(v.string()),
    colour: v.optional(v.string()),
    pages: v.optional(v.string()),
    finish: v.optional(v.string()),
    printing: v.optional(v.string()),
    artwork: v.string(),                     // artwork status
    additionalDetails: v.optional(v.string()),

    // Delivery
    deliveryAddress: v.optional(v.string()),
    deliveryPostcode: v.optional(v.string()),
    requiredDeliveryDate: v.optional(v.string()),

    // Status lifecycle
    status: v.union(
      v.literal("new"),          // just captured, not yet actioned
      v.literal("quoted"),       // quote sent to customer
      v.literal("confirmed"),    // customer confirmed
      v.literal("in_progress"),
      v.literal("completed"),
      v.literal("cancelled")
    ),

    // Traceability
    enquiryId: v.optional(v.id("enquiries")),          // enquiry this was captured from
    webhookEventId: v.optional(v.id("webhookEvents")), // linked webhook log row
    rawPayload: v.optional(v.string()),                 // captured enquiry snapshot
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_whatsappNumber", ["whatsappNumber"])
    .index("by_status", ["status"])
    .index("by_user", ["userId"])
    .index("by_enquiry", ["enquiryId"]),
});
