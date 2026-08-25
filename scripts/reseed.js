#!/usr/bin/env node
/**
 * reseed.js – Run this script locally to reseed the Printly knowledge base
 * from the Printly - AI Sales.md file.
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

// Read the markdown file (filename uses en dash –, not a regular hyphen)
const mdPath = path.join(__dirname, "../Printly – AI Sales.md");
if (!fs.existsSync(mdPath)) {
  console.error("\u274C Printly \u2013 AI Sales.md not found at:", mdPath);
  process.exit(1);
}

const markdownContent = fs.readFileSync(mdPath, "utf-8").trim();
console.log(`\u2705 Read ${markdownContent.length} characters from Printly \u2013 AI Sales.md`);

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
