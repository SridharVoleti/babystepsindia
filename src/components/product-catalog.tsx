import { listProducts } from "@/lib/db/products";
import { productMeta } from "@/lib/products";
import { getSession } from "@/lib/auth/session";
import { getEntitlementsForUser } from "@/lib/db/subscriptions";
import { ProductCard } from "@/components/product-card";

export async function ProductCatalog() {
  const products = await listProducts();
  const metaBySlug = new Map(productMeta.map((m) => [m.slug, m]));

  const session = await getSession();
  const entitlements = session ? await getEntitlementsForUser(session.sub) : null;

  return (
    <section id="products" className="mx-auto max-w-6xl px-6 py-16">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-bold tracking-tight text-chakra-900">
          Every product, one account
        </h2>
        <p className="mt-3 text-chakra-600">
          Subscribe to a single product or unlock the full bundle. New
          products show up here automatically — no app update required.
        </p>
      </div>

      <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {products.map((product) => (
          <ProductCard
            key={product.slug}
            product={product}
            meta={metaBySlug.get(product.slug)}
            isLoggedIn={!!session}
            hasAccess={
              entitlements
                ? entitlements.bundle || entitlements.products.includes(product.slug)
                : false
            }
          />
        ))}
      </div>
    </section>
  );
}
