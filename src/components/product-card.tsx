"use client";

import { useTransition } from "react";
import { subscribeAction } from "@/app/actions/subscribe";
import type { ProductRow } from "@/lib/db/types";
import type { ProductMeta } from "@/lib/products";

export function ProductCard({
  product,
  meta,
  isLoggedIn,
  hasAccess,
}: {
  product: ProductRow;
  meta?: ProductMeta;
  isLoggedIn: boolean;
  hasAccess: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const available = product.status === "active";

  const isDev = process.env.NODE_ENV === "development";
  const launchHref =
    isDev && meta?.localDevPort
      ? `http://localhost:${meta.localDevPort}`
      : `https://${product.subdomain}`;
  const launchLabel =
    isDev && meta?.localDevPort ? `localhost:${meta.localDevPort}` : product.subdomain;

  function launch() {
    if (!available) return;
    window.open(launchHref, "_blank", "noreferrer");
  }

  function handleSubscribe(e: React.MouseEvent) {
    e.stopPropagation();
    startTransition(() => subscribeAction(product.slug));
  }

  return (
    <div
      onClick={launch}
      role={available ? "button" : undefined}
      tabIndex={available ? 0 : undefined}
      onKeyDown={(e) => {
        if (available && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          launch();
        }
      }}
      className={`card flex flex-col gap-4 p-6 transition-shadow ${
        available ? "cursor-pointer hover:shadow-md" : ""
      }`}
    >
      <div className="flex items-start justify-between">
        <h3 className="text-lg font-semibold text-chakra-900">{product.name}</h3>
        {available ? (
          <span className="rounded-full bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700">
            Available
          </span>
        ) : (
          <span className="rounded-full bg-saffron-50 px-2.5 py-1 text-xs font-semibold text-saffron-700">
            Coming soon
          </span>
        )}
      </div>

      <p className="text-sm leading-relaxed text-chakra-600">{meta?.tagline}</p>

      <div className="mt-auto flex items-center justify-between gap-3 pt-2">
        <span className="text-sm font-medium text-chakra-500">
          {product.price_inr > 0 ? `₹${product.price_inr}/mo` : "Included in bundle"}
        </span>

        {available ? (
          hasAccess ? (
            <span className="text-sm font-medium text-green-700">Launch →</span>
          ) : isLoggedIn ? (
            <button
              type="button"
              onClick={handleSubscribe}
              disabled={isPending}
              className="btn-primary py-1.5 text-xs"
            >
              {isPending ? "Subscribing…" : "Subscribe"}
            </button>
          ) : (
            <a
              href="/login"
              onClick={(e) => e.stopPropagation()}
              className="text-sm font-medium text-green-700 hover:text-green-800"
            >
              Log in to subscribe
            </a>
          )
        ) : (
          <span className="text-sm font-medium text-chakra-400">{launchLabel}</span>
        )}
      </div>
    </div>
  );
}
