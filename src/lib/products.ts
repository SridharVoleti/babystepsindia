// Presentation-only metadata, keyed by slug. Name/subdomain/price/status
// live in the `products` table (src/lib/db/client.ts's CATALOG is the
// canonical source, synced into SQLite on boot) — this file only holds
// copy and local-dev routing that don't belong in that transactional
// schema.
export type ProductMeta = {
  slug: string;
  tagline: string;
  // Where this product's own dev server runs locally. Each product app is
  // its own Vercel+Supabase project (REQ-08 §2), so on localhost — where
  // subdomain routing doesn't apply — they're reached by port instead.
  localDevPort?: number;
};

export const productMeta: ProductMeta[] = [
  {
    slug: "chess",
    tagline: "Guided chess lessons and puzzles for young players.",
    localDevPort: 3002,
  },
  {
    slug: "magical-math",
    tagline: "Make arithmetic and number sense click, one mission at a time.",
    localDevPort: 8763,
  },
  {
    slug: "speed-reading",
    tagline: "Build reading speed and comprehension with daily drills.",
    localDevPort: 3003,
  },
];
