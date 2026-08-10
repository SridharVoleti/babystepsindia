"use client";

import type { ProductRow } from "@/lib/db/types";
import type { ProductMeta } from "@/lib/products";

export function ProductCard({ product, meta, isLoggedIn, hasAccess }: {
  product: ProductRow;
  meta?: ProductMeta;
  isLoggedIn: boolean;
  hasAccess: boolean;
}) {
  const available = product.status === "active";
  const isDev = process.env.NODE_ENV === "development";
  const launchHref = isDev && meta?.localDevPort
    ? `http://localhost:${meta.localDevPort}`
    : `https://${product.subdomain}`;
  const launchLabel = isDev && meta?.localDevPort ? `localhost:${meta.localDevPort}` : product.subdomain;

  function launch() {
    if (available && hasAccess) window.open(launchHref, "_blank", "noreferrer");
  }

  return (
    <div
      onClick={launch}
      role={available && hasAccess ? "button" : undefined}
      tabIndex={available && hasAccess ? 0 : undefined}
      onKeyDown={(event) => {
        if (available && hasAccess && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          launch();
        }
      }}
      className={`card flex flex-col gap-4 p-6 transition-shadow ${available && hasAccess ? "cursor-pointer hover:shadow-md" : ""}`}
    >
      <div className="flex items-start justify-between">
        <h3 className="text-lg font-semibold text-chakra-900">{product.name}</h3>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${available
          ? "bg-green-50 text-green-700" : "bg-saffron-50 text-saffron-700"}`}>
          {available ? "Available" : "Coming soon"}
        </span>
      </div>
      <p className="text-sm leading-relaxed text-chakra-600">{meta?.tagline}</p>
      <div className="mt-auto flex items-center justify-between gap-3 pt-2">
        <span className="text-sm font-medium text-chakra-500">
          {product.price_inr > 0 ? `₹${product.price_inr}/mo` : "Included in bundle"}
        </span>
        {available ? hasAccess ? (
          <span className="text-sm font-medium text-green-700">Launch →</span>
        ) : isLoggedIn ? (
          <a href={`/account/subscriptions/new?product=${encodeURIComponent(product.slug)}`}
            onClick={(event) => event.stopPropagation()} className="btn-primary py-1.5 text-xs">
            Subscribe
          </a>
        ) : (
          <a href="/login" onClick={(event) => event.stopPropagation()}
            className="text-sm font-medium text-green-700 hover:text-green-800">Log in to subscribe</a>
        ) : <span className="text-sm font-medium text-chakra-400">{launchLabel}</span>}
      </div>
    </div>
  );
}
