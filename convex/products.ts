import { v } from "convex/values";
import { internalQuery, internalMutation, internalAction, query } from "./_generated/server";
import { internal } from "./_generated/api";

// ---------------------------------------------------------------------------
// Product catalogue – all 25 Printwell products derived from Printly AI Sales.md
// ---------------------------------------------------------------------------
const PRINTWELL_PRODUCTS = [
  {
    slug: "business-cards",
    name: "Business Cards",
    category: "Business Stationery",
    description: "Professional business cards for brands and businesses. Printed on high-quality card stock with optional embellishments.",
    requirementFields: ["quantity", "size", "single_or_double_sided", "material_paper", "embellishments", "artwork_status", "delivery_address", "required_delivery_date"],
    exampleSpec: "55 x 85mm, printed 4 colours on white 450gsm card, trimmed",
    notes: "Standard size is 55 x 85mm. Ask all questions at once giving a typical example.",
  },
  {
    slug: "letterheads",
    name: "Letterheads",
    category: "Business Stationery",
    description: "Professional headed paper for business correspondence, printed on quality paper with optional embellishments.",
    requirementFields: ["quantity", "paper_material", "size", "single_or_double_sided", "embellishments", "artwork_status", "delivery_details", "required_delivery_date"],
    exampleSpec: "A4, printed 4 colour on 100gsm bond paper",
    notes: undefined,
  },
  {
    slug: "brochures",
    name: "Brochures",
    category: "Marketing & Promotional",
    description: "High-quality printed brochures for marketing and sales. Available in various sizes, page counts, and binding options.",
    requirementFields: ["quantity", "size", "number_of_pages", "self_cover_or_separate_cover", "colour", "paper_material", "binding", "embellishments", "artwork_status", "delivery_details", "required_delivery_date"],
    exampleSpec: "28pp A4 self cover, printed 4 colour throughout on 170gsm silk, folded, stapled and trimmed",
    notes: "Above 28pp recommend Perfect Binding ONLY. Separate cover option: cover 350gsm, inner pages 130gsm.",
  },
  {
    slug: "flyers-leaflets",
    name: "Flyers & Leaflets",
    category: "Marketing & Promotional",
    description: "Printed flyers and leaflets for campaigns, events and promotions. Available flat or folded in multiple formats.",
    requirementFields: ["quantity", "size", "single_or_double_sided", "paper_material", "fold_type", "embellishments", "artwork_status", "delivery_postcode", "delivery_address", "required_date"],
    exampleSpec: "A4, printed 4 colour front and reverse on white 130gsm silk, trimmed and folded",
    notes: "Formats: A6, A5, A4, DL, square. Fold options: half-fold, tri-fold, Z-fold, gatefold. Do not recommend a format unless asked.",
  },
  {
    slug: "booklets",
    name: "Booklets",
    category: "Marketing & Promotional",
    description: "Printed booklets for guides, programmes and catalogues. Various page counts and binding options available.",
    requirementFields: ["quantity", "size", "number_of_pages", "self_cover_or_separate_cover", "paper_material", "binding", "finish", "embellishments", "artwork_status", "delivery_details", "required_delivery_date"],
    exampleSpec: "28pp A4 self cover, printed 4 colour throughout on 170gsm silk, folded, stapled and trimmed",
    notes: "Above 28pp recommend Perfect Binding ONLY. If customer unsure about binding, ask if they'd like a printing consultant.",
  },
  {
    slug: "product-catalogues",
    name: "Product Catalogues",
    category: "Marketing & Promotional",
    description: "Professional product catalogues for retail and wholesale. Full colour throughout with flexible binding and cover options.",
    requirementFields: ["quantity", "size", "number_of_pages", "self_cover_or_separate_cover", "paper_material", "binding", "embellishments", "artwork_status", "delivery_details", "required_delivery_date"],
    exampleSpec: "28pp A4, cover 350gsm, inner pages 130gsm, all collated, folded, stapled and trimmed",
    notes: "Above 28pp recommend Perfect Binding ONLY.",
  },
  {
    slug: "presentation-folders",
    name: "Presentation Folders",
    category: "Business Stationery",
    description: "Branded presentation folders for meetings, pitches and proposals. Available with glued or interlocking pockets.",
    requirementFields: ["quantity", "size", "material", "pocket_type", "embellishments", "artwork_status", "delivery_details", "required_date"],
    exampleSpec: "Oversized A4, printed 4 colour on face and reverse on 350gsm card, laminated matt, die cut",
    notes: "Do not assume pocket configuration. Ask: glued pocket or interlocking?",
  },
  {
    slug: "posters",
    name: "Posters",
    category: "Display & Signage",
    description: "Large-format printed posters for indoor and outdoor display. Available from A4 to A0 and custom sizes.",
    requirementFields: ["quantity", "size", "single_or_double_sided", "embellishments", "artwork_status", "indoor_or_outdoor", "delivery_details", "required_date"],
    exampleSpec: "A1 printed on face only on white poster paper, trimmed",
    notes: "Available sizes: A4, A3, A2, A1, A0, custom. For custom size, capture in size/additional_details.",
  },
  {
    slug: "banners",
    name: "Banners",
    category: "Display & Signage",
    description: "Printed PVC or fabric banners for events, exhibitions and retail. With or without eyelets.",
    requirementFields: ["quantity", "dimensions", "eyelets", "artwork_status", "delivery_information", "required_date"],
    exampleSpec: "2M x 1M printed 4 colour on face on white 440gsm PVC",
    notes: "Capture exact dimensions (width x height). Ask about eyelets.",
  },
  {
    slug: "newsletters",
    name: "Newsletters",
    category: "Marketing & Promotional",
    description: "Printed newsletters for internal or external communication. Folded multi-page formats available.",
    requirementFields: ["quantity", "size", "number_of_pages", "paper_material", "embellishments", "artwork_status", "delivery_information", "required_date"],
    exampleSpec: "12pp self cover, printed in colour throughout on white 170gsm silk, folded and trimmed",
    notes: undefined,
  },
  {
    slug: "postcards",
    name: "Postcards",
    category: "Marketing & Promotional",
    description: "Printed postcards for direct mail, promotions and events. Single or double sided on quality card.",
    requirementFields: ["quantity", "size", "single_or_double_sided", "paper_material", "embellishments", "artwork_status", "delivery_details", "required_date"],
    exampleSpec: "A6 printed 4 colour face only on white 250gsm card, trimmed",
    notes: undefined,
  },
  {
    slug: "labels",
    name: "Labels",
    category: "Labels & Stickers",
    description: "Custom printed labels for products, bottles, packaging and promotional uses. Removable or permanent adhesive, sheets or reels.",
    requirementFields: ["quantity", "dimensions", "reels_or_sheets", "removable_or_permanent_adhesive", "artwork_status", "delivery_details", "required_date"],
    exampleSpec: "50mm square labels printed on permanent adhesive, 500 labels per roll",
    notes: "Ask about application when adhesive affects the requirement.",
  },
  {
    slug: "stickers",
    name: "Stickers",
    category: "Labels & Stickers",
    description: "Custom shaped and printed stickers for branding, packaging and promotions. Various shapes, materials and finishes available.",
    requirementFields: ["quantity", "dimensions", "reels_or_sheets", "removable_or_permanent_adhesive", "artwork_status", "delivery_details", "required_date"],
    exampleSpec: "50mm round stickers printed 4 colour on white gloss vinyl, permanent adhesive, 250 per roll",
    notes: "Ask about application when adhesive affects the requirement. Custom shapes supported.",
  },
  {
    slug: "packaging",
    name: "Packaging",
    category: "Packaging",
    description: "Bespoke packaging solutions including cartons, rigid boxes and custom formats for brands and product businesses.",
    requirementFields: ["packaging_type", "product_being_packaged", "quantity", "dimensions", "material", "printing", "colour", "finish", "structural_requirements", "artwork_status", "delivery_details", "required_date", "additional_requirements"],
    exampleSpec: "Custom retail carton box, 4 colour print, matt laminate, 200 x 150 x 50mm",
    notes: "Packaging enquiries require deeper qualification. If customer wants help developing packaging concepts, route to agent.",
  },
  {
    slug: "bespoke-packaging",
    name: "Bespoke Packaging",
    category: "Packaging",
    description: "Fully bespoke packaging development from concept to production, including sampling and prototyping for brands and start-ups.",
    requirementFields: ["product_being_packaged", "packaging_type", "quantity", "approximate_dimensions", "artwork_status", "required_delivery_date", "delivery_address"],
    exampleSpec: "Bespoke rigid box for luxury skincare, custom dimensions, full colour print, soft touch laminate",
    notes: "Do not force customers to know technical packaging terminology. If unsure, offer a consultant. For design/development assistance, route to agent.",
  },
  {
    slug: "packaging-sampling",
    name: "Packaging Sampling / Prototyping",
    category: "Packaging",
    description: "Packaging samples, mock-ups and prototypes for brands developing new packaging before full production.",
    requirementFields: ["product_being_packaged", "packaging_type", "approximate_quantity", "dimensions", "artwork_status", "additional_details"],
    exampleSpec: "Prototype carton box for new cosmetics product, 3 samples required",
    notes: "Do not promise sample availability, timing or cost. Route to specialist agent for consultation.",
  },
  {
    slug: "promotional-merchandise",
    name: "Promotional Merchandise",
    category: "Promotional Merchandise",
    description: "Branded promotional merchandise including clothing, bags and bespoke corporate items for businesses and events.",
    requirementFields: ["product_type", "quantity", "number_of_colours", "delivery_details", "required_date", "additional_details"],
    exampleSpec: "Branded tote bags, printed 1 colour, quantity 500",
    notes: undefined,
  },
  {
    slug: "branded-clothing",
    name: "Branded Clothing",
    category: "Promotional Merchandise",
    description: "Custom branded garments including polo shirts, hoodies, t-shirts and workwear for businesses and events.",
    requirementFields: ["garment_type", "quantity", "sizes_breakdown", "branding_method", "artwork_status", "delivery_address", "required_date"],
    exampleSpec: "Polo shirts, embroidered logo, 50 pieces in assorted sizes",
    notes: "Do not recommend garment types unless asked.",
  },
  {
    slug: "bags",
    name: "Bags",
    category: "Promotional Merchandise",
    description: "Branded bags including tote bags, paper bags, reusable bags and more for retail, events and corporate use.",
    requirementFields: ["bag_type", "quantity", "size", "material", "delivery_details", "required_date"],
    exampleSpec: "Natural cotton tote bags, 1 colour screen print, 200 pieces",
    notes: undefined,
  },
  {
    slug: "water-bottles",
    name: "Water Bottles",
    category: "Promotional Merchandise",
    description: "Branded water bottles for corporate events, promotions and branded merchandise programmes.",
    requirementFields: ["bottle_type", "quantity", "branding_method", "number_of_colours", "artwork_status", "delivery_details", "required_date"],
    exampleSpec: "500ml stainless steel water bottle, engraved logo, quantity 100",
    notes: undefined,
  },
  {
    slug: "pens",
    name: "Pens",
    category: "Promotional Merchandise",
    description: "Branded pens and writing instruments for corporate and promotional use.",
    requirementFields: ["pen_type", "quantity", "branding_method", "number_of_colours", "artwork_status", "delivery_details", "required_date"],
    exampleSpec: "Ballpoint pens, 1 colour print, quantity 500",
    notes: undefined,
  },
  {
    slug: "mugs",
    name: "Coffee / Tea Mugs",
    category: "Promotional Merchandise",
    description: "Branded mugs and cups for office use, events and promotional merchandise.",
    requirementFields: ["mug_type", "quantity", "branding_method", "number_of_colours", "artwork_status", "delivery_details", "required_date"],
    exampleSpec: "Ceramic mug, full colour sublimation print, quantity 50",
    notes: undefined,
  },
  {
    slug: "seasonal-cards",
    name: "Seasonal Cards",
    category: "Business Stationery",
    description: "Printed seasonal greeting cards including Christmas, New Year and other occasions for businesses and brands.",
    requirementFields: ["quantity", "size", "single_or_double_sided", "paper_material", "embellishments", "artwork_status", "delivery_details", "required_date"],
    exampleSpec: "A5 Christmas cards, printed 4 colour on 350gsm silk, single sided, envelope included",
    notes: undefined,
  },
  {
    slug: "bespoke-corporate-items",
    name: "Bespoke Corporate Items",
    category: "Promotional Merchandise",
    description: "Fully bespoke branded corporate merchandise tailored to specific business requirements and events.",
    requirementFields: ["product_description", "quantity", "branding_method", "number_of_colours", "artwork_status", "delivery_details", "required_date", "additional_details"],
    exampleSpec: "Custom branded USB drives, quantity 100, engraved logo",
    notes: undefined,
  },
  {
    slug: "bespoke-print",
    name: "Bespoke / Other Print Requirements",
    category: "Other",
    description: "Any custom or bespoke print requirement not covered by standard product lines. Printwell supports a wide range of specialist print solutions.",
    requirementFields: ["product_description", "quantity", "size_or_dimensions", "material", "colour", "finish", "artwork_status", "delivery_details", "required_date", "additional_details"],
    exampleSpec: "Custom printed event wristbands, 500 pieces, full colour",
    notes: "For specialist or unusual requirements, collect as much detail as possible and route to a printing consultant if needed.",
  },
] as const;

// ---------------------------------------------------------------------------
// Seed – insert all products (idempotent: skip if slug already exists)
// ---------------------------------------------------------------------------
export const seedProducts = internalMutation({
  args: {},
  handler: async (ctx) => {
    let inserted = 0;
    for (const product of PRINTWELL_PRODUCTS) {
      const existing = await ctx.db
        .query("products")
        .withIndex("by_slug", (q) => q.eq("slug", product.slug))
        .unique();

      if (!existing) {
        await ctx.db.insert("products", {
          slug: product.slug,
          name: product.name,
          category: product.category,
          description: product.description,
          requirementFields: [...product.requirementFields],
          exampleSpec: product.exampleSpec,
          notes: product.notes,
        });
        inserted++;
      }
    }
    return { inserted, total: PRINTWELL_PRODUCTS.length };
  },
});

// Public action to trigger seeding from dashboard or script
export const runSeedProducts = internalAction({
  args: {},
  handler: async (ctx): Promise<{ inserted: number; total: number }> => {
    const result: { inserted: number; total: number } = await ctx.runMutation(internal.products.seedProducts);
    return result;
  },
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
export const listProducts = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("products").collect();
  },
});

export const getProductBySlug = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("products")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
  },
});

export const getProductByName = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    // Fuzzy-ish match: lowercase includes check in JS after collecting
    const all = await ctx.db.query("products").collect();
    const lower = args.name.toLowerCase();
    return all.find(
      (p) =>
        p.name.toLowerCase().includes(lower) ||
        p.slug.includes(lower.replace(/\s+/g, "-"))
    ) ?? null;
  },
});

// ---------------------------------------------------------------------------
// AI Tool: getProductDetails
// Called by the agent to get structured requirement fields for a named product
// ---------------------------------------------------------------------------
export const getProductDetails = internalAction({
  args: {
    productName: v.string(),
  },
  handler: async (ctx, args): Promise<{
    found: boolean;
    product: {
      slug: string;
      name: string;
      category: string;
      description: string;
      requirementFields: string[];
      exampleSpec?: string;
      notes?: string;
    } | null;
  }> => {
    const product = await ctx.runQuery(internal.products.getProductByName, {
      name: args.productName,
    });

    if (!product) {
      return { found: false, product: null };
    }

    return {
      found: true,
      product: {
        slug: product.slug,
        name: product.name,
        category: product.category,
        description: product.description,
        requirementFields: product.requirementFields,
        exampleSpec: product.exampleSpec,
        notes: product.notes,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// AI Tool: createProtocol
// Called by the agent to store a structured quotation protocol once all info collected
// ---------------------------------------------------------------------------
export const createProtocol = internalAction({
  args: {
    customerName: v.string(),
    companyName: v.optional(v.string()),
    phone: v.string(),
    email: v.optional(v.string()),
    product: v.string(),
    quantity: v.string(),
    specifications: v.string(), // JSON string of key-value spec pairs
    artworkStatus: v.string(),
    deliveryAddress: v.string(),
    deliveryPostcode: v.string(),
    requiredDeliveryDate: v.string(),
    additionalDetails: v.optional(v.string()),
  },
  handler: async (_ctx, args): Promise<{
    protocol: {
      customer: {
        full_name: string;
        company_name: string;
        phone: string;
        email: string;
      };
      order: {
        product: string;
        quantity: string;
        specifications: string;
        artwork: string;
        delivery: {
          address: string;
          postcode: string;
          required_delivery_date: string;
        };
        additional_details: string;
      };
      created_at: string;
    };
  }> => {
    const protocol = {
      customer: {
        full_name: args.customerName,
        company_name: args.companyName ?? "",
        phone: args.phone,
        email: args.email ?? "",
      },
      order: {
        product: args.product,
        quantity: args.quantity,
        specifications: args.specifications,
        artwork: args.artworkStatus,
        delivery: {
          address: args.deliveryAddress,
          postcode: args.deliveryPostcode,
          required_delivery_date: args.requiredDeliveryDate,
        },
        additional_details: args.additionalDetails ?? "",
      },
      created_at: new Date().toISOString(),
    };

    return { protocol };
  },
});

// ---------------------------------------------------------------------------
// AI Tool: storeGeneralInfo
// Called by the agent to persist miscellaneous customer information snippets
// (e.g. company name, email, preferences) discovered mid-conversation
// This stores information by appending to the user's message log as a structured
// system note, keeping it retrievable via chat history.
// ---------------------------------------------------------------------------
export const storeGeneralInfo = internalAction({
  args: {
    userId: v.id("users"),
    infoType: v.string(), // e.g. "company_name", "email", "preference"
    value: v.string(),
  },
  handler: async (ctx, args): Promise<{ stored: boolean }> => {
    // Store as a system message in the user's conversation for retrieval
    await ctx.runMutation(internal.products.insertInfoNote, {
      userId: args.userId,
      infoType: args.infoType,
      value: args.value,
    });
    return { stored: true };
  },
});

export const insertInfoNote = internalMutation({
  args: {
    userId: v.id("users"),
    infoType: v.string(),
    value: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("messages", {
      userId: args.userId,
      sender: "assistant",
      kind: "text",
      text: JSON.stringify({
        type: "info_note",
        infoType: args.infoType,
        value: args.value,
      }),
      timestamp: Date.now(),
    });
  },
});
