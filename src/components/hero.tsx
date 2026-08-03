import Link from "next/link";

export function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-20 pt-16 sm:pt-24">
      <div className="mx-auto max-w-3xl text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-green-200 bg-green-50 px-3 py-1 text-xs font-semibold text-green-700">
          One account. Every Baby Steps product.
        </span>

        <h1 className="mt-6 text-4xl font-bold tracking-tight text-chakra-900 sm:text-5xl">
          Sign up once,
          <span className="relative mx-2 inline-block text-saffron-600">
            learn everywhere
          </span>
        </h1>

        <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-chakra-600">
          Your Baby Steps account unlocks ChessQuest, Magical Math, and Speed
          Reading — no separate logins, no repeated checkouts. Subscribe to
          one product or the full bundle.
        </p>

        <div className="mt-8 flex items-center justify-center gap-4">
          <Link href="/signup" className="btn-primary px-6 py-3 text-base">
            Create your account
          </Link>
          <Link href="/#products" className="btn-secondary px-6 py-3 text-base">
            Explore products
          </Link>
        </div>
      </div>
    </section>
  );
}
