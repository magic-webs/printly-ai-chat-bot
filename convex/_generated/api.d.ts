/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as chat from "../chat.js";
import type * as chat_db from "../chat_db.js";
import type * as debug from "../debug.js";
import type * as documents from "../documents.js";
import type * as ingest from "../ingest.js";
import type * as messages from "../messages.js";
import type * as products from "../products.js";
import type * as r2 from "../r2.js";
import type * as seed from "../seed.js";
import type * as seed_helpers from "../seed_helpers.js";
import type * as users from "../users.js";
import type * as webhooks from "../webhooks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  chat: typeof chat;
  chat_db: typeof chat_db;
  debug: typeof debug;
  documents: typeof documents;
  ingest: typeof ingest;
  messages: typeof messages;
  products: typeof products;
  r2: typeof r2;
  seed: typeof seed;
  seed_helpers: typeof seed_helpers;
  users: typeof users;
  webhooks: typeof webhooks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
