import { listProducts } from "@/lib/db/products";
import { productMeta } from "@/lib/products";
import { getSession } from "@/lib/auth/session";
import { getEntitlementsForUser } from "@/lib/db/subscriptions";
import { ProductCard } from "@/components/product-card";
import Link from "next/link";

export async function ProductCatalog() {
  const products = await listProducts();
  const metaBySlug = new Map(productMeta.map((m) => [m.slug, m]));
  const productOrder = ["magical-math", "chess", "speed-reading"];
  const orderedProducts = [...products].sort((a, b) => {
    const aIndex = productOrder.indexOf(a.slug);
    const bIndex = productOrder.indexOf(b.slug);
    return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex);
  });

  const session = await getSession();
  const entitlements = session ? await getEntitlementsForUser(session.sub) : null;

  return (
    <>
      <section id="products" className="relative mx-auto -mt-10 max-w-7xl px-6 pb-14 lg:px-10">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {orderedProducts.map((product) => (
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

        <div className="mt-7 flex justify-center gap-3" aria-hidden="true">
          <span className="h-2.5 w-8 rounded-full bg-[#0757dc]" />
          <span className="h-2.5 w-2.5 rounded-full bg-chakra-200" />
          <span className="h-2.5 w-2.5 rounded-full bg-chakra-200" />
          <span className="h-2.5 w-2.5 rounded-full bg-chakra-200" />
        </div>
      </section>

      <section id="journey" className="mx-auto max-w-7xl px-6 pb-16 pt-4 lg:px-10">
        <div className="text-center">
          <h2 className="text-3xl font-black tracking-normal text-[#090f3f] sm:text-4xl">
            Your 4-step journey to lifelong skills
          </h2>
          <div className="mx-auto mt-3 h-1.5 w-20 rounded-full bg-[#ffc400]" />
        </div>

        <div className="relative mt-9 grid gap-8 md:grid-cols-4">
          <div className="absolute left-[12%] right-[12%] top-14 hidden border-t-2 border-dashed border-chakra-200 md:block" />
          {[
            ["1", "+", "Create account", "Sign up in seconds. It's free to start.", "blue"],
            ["2", "U", "Add learner", "Add your child's details in just a few taps.", "green"],
            ["3", "▦", "Choose app", "Pick the right app for their growth.", "gold"],
            ["4", "R", "Begin journey", "Start learning and track progress together.", "blue"],
          ].map(([step, icon, title, body, tone]) => (
            <div key={step} className="relative text-center">
              <span className={`absolute left-1/2 top-0 z-20 flex h-9 w-9 -translate-x-1/2 -translate-y-3 items-center justify-center rounded-full text-lg font-black text-white shadow-md ${
                tone === "green" ? "bg-green-600" : tone === "gold" ? "bg-saffron-500" : "bg-[#0757dc]"
              }`}>
                {step}
              </span>
              <div className={`mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-white text-5xl font-black shadow-lg ring-1 ${
                tone === "green" ? "text-green-600 ring-green-100" : tone === "gold" ? "text-saffron-500 ring-saffron-100" : "text-[#0757dc] ring-chakra-100"
              }`}>
                {icon}
              </div>
              <h3 className="mt-5 text-lg font-black text-[#090f3f]">{title}</h3>
              <p className="mx-auto mt-2 max-w-[210px] text-sm leading-relaxed text-slate-700">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="about" className="bg-[#0044d8] text-white">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-5 px-6 py-5 text-center sm:flex-row sm:text-left lg:px-10">
          <p className="text-xl font-semibold sm:text-2xl">
            Give your child the advantage they deserve.
            <span className="block text-[#ffc400]">Start your Babysteps journey today.</span>
          </p>
          <Link href="/signup" className="inline-flex min-w-[280px] items-center justify-center gap-3 rounded-xl bg-white px-7 py-4 text-lg font-black text-[#0757dc] shadow-lg transition-colors hover:bg-chakra-50">
            Create Account Now
            <span aria-hidden="true" className="text-3xl leading-none">›</span>
          </Link>
        </div>
      </section>
    </>
  );
}
