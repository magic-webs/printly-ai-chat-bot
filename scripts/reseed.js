#!/usr/bin/env node
/**
 * reseed.js – Reseed the Printwell knowledge base from
 * `PrintWell  – Knowledge Base.md`.
 *
 * Usage:
 *   node scripts/reseed.js
 *
 * This reads the markdown file and passes its content to the Convex
 * reseedKnowledgeBase action, which wipes old embeddings and re-seeds.
 */

const fs = require("fs");
const path = require("path");
const { ConvexHttpClient } = require("convex/browser");
require("dotenv").config({ path: path.join(__dirname, "../.env.local") });

const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL;

if (!CONVEX_URL) {
  console.error("❌ NEXT_PUBLIC_CONVEX_URL is not set in .env.local");
  process.exit(1);
}

// Filename contains a double space and an en dash –, not a regular hyphen.
const KNOWLEDGE_BASE_FILE = "PrintWell  – Knowledge Base.md";
const mdPath = path.join(__dirname, "..", KNOWLEDGE_BASE_FILE);
if (!fs.existsSync(mdPath)) {
  console.error(`❌ ${KNOWLEDGE_BASE_FILE} not found at:`, mdPath);
  process.exit(1);
}

const markdownContent = fs.readFileSync(mdPath, "utf-8").trim();
console.log(`✅ Read ${markdownContent.length} characters from ${KNOWLEDGE_BASE_FILE}`);

async function main() {
  const client = new ConvexHttpClient(CONVEX_URL);

  console.log("🚀 Starting knowledge base reseed...");
  try {
    const result = await client.action("seed:reseedKnowledgeBase", {
      markdownContent,
    });
    console.log("✅ Reseed complete!");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("❌ Reseed failed:", err.message || err);
    process.exit(1);
  }
}

main();
