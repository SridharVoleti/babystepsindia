import Link from "next/link";
import { listProducts } from "@/lib/db/products";
import { getSession } from "@/lib/auth/session";
import { getEntitlementsForUser } from "@/lib/db/subscriptions";

const featureOrder = ["magical-math", "chess", "speed-reading"] as const;

const featureConfig: Record<
  string,
  {
    name: string;
    eyebrow: string;
    promise: string;
    icon: string;
    benefits: readonly string[];
    cardClass: string;
    glowClass: string;
  }
> = {
  "magical-math": {
    name: "Magical Math",
    eyebrow: "Numbers become effortless.",
    promise: "Mental maths, number sense and confidence through deliberate practice.",
    icon: "∑",
    benefits: ["Strong basics", "Speed & accuracy", "Problem solving"],
    cardClass: "from-[#082E84] via-[#0B4DC7] to-[#102C73]",
    glowClass: "bg-cyan-300/35",
  },
  chess: {
    name: "Chess Master",
    eyebrow: "Learn to think ahead.",
    promise: "Strategy, focus, pattern recognition and stronger decision-making.",
    icon: "♛",
    benefits: ["Strategic thinking", "Focus & patience", "Smart decisions"],
    cardClass: "from-[#2B0D6B] via-[#4B18A8] to-[#190946]",
    glowClass: "bg-violet-300/35",
  },
  "speed-reading": {
    name: "Speed Reading",
    eyebrow: "Read faster. Understand more.",
    promise: "Build reading speed while protecting comprehension and retention.",
    icon: "Aa",
    benefits: ["Vocabulary", "Comprehension", "Reading fluency"],
    cardClass: "from-[#075B37] via-[#0A7D48] to-[#03482C]",
    glowClass: "bg-emerald-300/30",
  },
};

const upcomingApps = [
  { name: "Olympiad Math", detail: "Problem solving", icon: "√x", classes: "border-violet-200 bg-violet-50 text-violet-800" },
  { name: "Olympiad Science", detail: "Curiosity & concepts", icon: "⚗", classes: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  { name: "Olympiad Social", detail: "World & society", icon: "◎", classes: "border-orange-200 bg-orange-50 text-orange-800" },
  { name: "Olympiad Space", detail: "Astronomy & discovery", icon: "✦", classes: "border-indigo-200 bg-indigo-50 text-indigo-800" },
  { name: "General Knowledge", detail: "Awareness & facts", icon: "◉", classes: "border-sky-200 bg-sky-50 text-sky-800" },
  { name: "Financial Literacy", detail: "Money basics", icon: "₹", classes: "border-green-200 bg-green-50 text-green-800" },
  { name: "Vocab Champ", detail: "Word power", icon: "Aᶻ", classes: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-800" },
  { name: "Spell Bee", detail: "Spelling mastery", icon: "Bee", classes: "border-amber-200 bg-amber-50 text-amber-900" },
] as const;

export async function ProductCatalog() {
  const products = await listProducts();
  const session = await getSession();
  const entitlements = session ? getEntitlementsForUser(session.sub) : null;

  const featuredProducts = featureOrder
    .map((slug) => products.find((product) => product.slug === slug))
    .filter((product): product is NonNullable<typeof product> => Boolean(product));

  return (
    <section id="products" className="overflow-hidden bg-white py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-sm font-extrabold uppercase tracking-[0.2em] text-[#1565C0]">
            Learning apps with a purpose
          </p>
          <h2 className="mt-3 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">
            Skills children can carry for life
          </h2>
          <p className="mt-4 text-base leading-7 text-slate-600 sm:text-lg">
            Start with one focused learning journey today, with a growing Babysteps ecosystem ready for what comes next.
          </p>
        </div>

        <div className="mt-10 grid gap-5 lg:grid-cols-3">
          {featuredProducts.map((product) => {
            const config = featureConfig[product.slug];
            if (!config) return null;

            const hasAccess = entitlements
              ? entitlements.bundle || entitlements.products.includes(product.slug)
              : false;
            const launchHref = `https://${product.subdomain}`;
            const subscribeHref = `/account/subscriptions/new?product=${encodeURIComponent(product.slug)}`;
            const ctaLabel = hasAccess ? "Launch App" : session ? "Choose for Learner" : "Explore & Sign In";
            const ctaHref = hasAccess ? launchHref : session ? subscribeHref : "/login";

            return (
              <article
                key={product.slug}
                className={`group relative min-h-[430px] overflow-hidden rounded-[28px] bg-gradient-to-br ${config.cardClass} p-6 text-white shadow-[0_20px_50px_rgba(15,23,42,0.18)] sm:p-7`}
              >
                <div className={`absolute -right-12 -top-12 h-52 w-52 rounded-full ${config.glowClass} blur-3xl transition-transform duration-500 group-hover:scale-125`} />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_30%,rgba(255,255,255,0.16),transparent_28%)]" />

                <div className="relative flex h-full flex-col">
                  <div>
                    <p className="text-sm font-bold text-white/75">{config.eyebrow}</p>
                    <h3 className="mt-2 text-4xl font-black tracking-tight sm:text-[2.7rem]">{config.name}</h3>
                    <p className="mt-4 max-w-[28rem] text-sm leading-6 text-white/85">{config.promise}</p>
                  </div>

                  <div className="relative my-7 flex min-h-[130px] items-center justify-center">
                    <div className="absolute h-36 w-36 rounded-full border border-white/15 bg-white/10 shadow-inner" />
                    <div className="absolute h-24 w-24 rounded-full bg-white/10 blur-xl" />
                    <span className="relative text-7xl font-black drop-shadow-2xl" aria-hidden="true">
                      {config.icon}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center text-[11px] font-semibold text-white/80">
                    {config.benefits.map((benefit) => (
                      <span key={benefit} className="rounded-xl border border-white/10 bg-white/10 px-2 py-2.5">
                        {benefit}
                      </span>
                    ))}
                  </div>

                  <div className="mt-auto pt-5">
                    {hasAccess ? (
                      <a
                        href={ctaHref}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-white px-4 py-3 text-sm font-extrabold text-slate-900 transition hover:bg-blue-50"
                      >
                        {ctaLabel} <span className="ml-2" aria-hidden="true">→</span>
                      </a>
                    ) : (
                      <Link
                        href={ctaHref}
                        className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-white px-4 py-3 text-sm font-extrabold text-slate-900 transition hover:bg-blue-50"
                      >
                        {ctaLabel} <span className="ml-2" aria-hidden="true">→</span>
                      </Link>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <div className="mt-10 border-y border-slate-200 bg-slate-50/75 py-5">
        <div className="mx-auto mb-3 flex max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <p className="text-sm font-extrabold text-slate-800">More Babysteps journeys in the pipeline</p>
          <span className="rounded-full bg-[#E8F2FC] px-3 py-1 text-xs font-bold text-[#0D47A1]">Coming soon</span>
        </div>

        <div className="app-marquee" aria-label="Upcoming Babysteps learning apps">
          <div className="app-marquee-track">
            {[...upcomingApps, ...upcomingApps].map((app, index) => (
              <div
                key={`${app.name}-${index}`}
                aria-hidden={index >= upcomingApps.length ? true : undefined}
                className={`mx-2 flex w-[190px] shrink-0 items-center gap-3 rounded-2xl border px-4 py-3 shadow-sm ${app.classes}`}
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/80 text-base font-black shadow-sm" aria-hidden="true">
                  {app.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-extrabold leading-4">{app.name}</span>
                  <span className="mt-1 block text-xs leading-4 opacity-75">{app.detail}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
