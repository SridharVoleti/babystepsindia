import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { Hero } from "@/components/hero";
import { ProductCatalog } from "@/components/product-catalog";

// ProductCatalog renders per-session entitlements and reads the live
// product catalog from Postgres — it must never be prerendered at build
// time (no DB connectivity guaranteed during `next build`, and a static
// snapshot would be wrong per-user anyway).
export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <ProductCatalog />
      </main>
      <SiteFooter />
    </div>
  );
}
