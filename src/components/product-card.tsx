"use client";

import Image from "next/image";
import type { ProductRow } from "@/lib/db/types";
import type { ProductMeta } from "@/lib/products";

const productDesign: Record<string, {
  image: string;
  theme: string;
}> = {
  "magical-math": {
    image: "/brand/homepage-magical-math-card-v2.png",
    theme: "from-[#052ca8] via-[#0952ed] to-[#001a63]",
  },
  chess: {
    image: "/brand/homepage-chess-card-v2.png",
    theme: "from-[#120038] via-[#4310c7] to-[#14002d]",
  },
  "speed-reading": {
    image: "/brand/homepage-speed-reading-card-v2.png",
    theme: "from-[#003a18] via-[#00762e] to-[#003412]",
  },
};

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

  const design = productDesign[product.slug] ?? {
    image: "/brand/magical-math.png",
    theme: "from-[#052ca8] via-[#0952ed] to-[#001a63]",
  };

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
      className={`group relative aspect-[366/420] overflow-hidden rounded-[20px] bg-gradient-to-br ${design.theme} text-white shadow-[0_16px_32px_rgba(3,15,52,0.22)] ring-1 ring-white/15 transition-transform focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-chakra-600 ${available && hasAccess ? "cursor-pointer hover:-translate-y-1" : ""}`}
    >
      <Image
        src={design.image}
        alt=""
        fill
        sizes="(min-width: 768px) 33vw, 100vw"
        className="object-cover opacity-100 transition-transform duration-500 group-hover:scale-[1.02]"
      />
      {available && !hasAccess && (
        <a
          href={isLoggedIn ? `/account/subscriptions/new?product=${encodeURIComponent(product.slug)}` : "/login"}
          onClick={(event) => event.stopPropagation()}
          className="absolute inset-0 z-10 rounded-[20px] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-chakra-600"
          aria-label={`Explore ${product.name}`}
        />
      )}
      {!available && (
        <span className="sr-only">{launchLabel}</span>
      )}
    </div>
  );
}
