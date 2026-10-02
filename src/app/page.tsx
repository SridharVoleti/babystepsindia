import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { Hero } from "@/components/hero";
import { ProductCatalog } from "@/components/product-catalog";
import { HomepageJourney } from "@/components/homepage-journey";
import { BrandPhilosophy } from "@/components/brand-philosophy";

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <ProductCatalog />
        <BrandPhilosophy />
        <HomepageJourney />
      </main>
      <SiteFooter />
    </div>
  );
}
