import Link from "next/link";
import { listProducts } from "@/lib/db/products";
import { getSession } from "@/lib/auth/session";
import { getEntitlementsForUser } from "@/lib/db/subscriptions";

const featureOrder = ["magical-math", "chess", "speed-reading"] as const;
const featureConfig = {
  "magical-math": { name: "Magical Math", outcome: "Make numbers your superpower.", icon: "∑", accent: "#FFD45A", cardClass: "from-[#0B4CB8] via-[#1565C0] to-[#1E88E5]" },
  chess: { name: "Chess Master", outcome: "Learn to think ahead.", icon: "♞", accent: "#C8B5FF", cardClass: "from-[#28105E] via-[#4B22A8] to-[#6C45C7]" },
  "speed-reading": { name: "Speed Reading", outcome: "Read faster. Understand more.", icon: "Aa", accent: "#8EE8BD", cardClass: "from-[#075B46] via-[#07865D] to-[#16A273]" },
} as const;

const ecosystemApps = [
  { name: "Magical Math", detail: "Numbers & confidence", icon: "∑", tone: "bg-blue-50 text-blue-800" },
  { name: "Chess Master", detail: "Strategy & focus", icon: "♞", tone: "bg-violet-50 text-violet-800" },
  { name: "Speed Reading", detail: "Fluency & comprehension", icon: "Aa", tone: "bg-emerald-50 text-emerald-800" },
  { name: "Olympiad Math", detail: "Problem solving", icon: "√x", tone: "bg-purple-50 text-purple-800" },
  { name: "Olympiad Science", detail: "Curiosity & concepts", icon: "⚗", tone: "bg-teal-50 text-teal-800" },
  { name: "Olympiad Social", detail: "World & society", icon: "◎", tone: "bg-orange-50 text-orange-800" },
  { name: "Olympiad Space", detail: "Astronomy & discovery", icon: "✦", tone: "bg-indigo-50 text-indigo-800" },
  { name: "General Knowledge", detail: "Awareness & facts", icon: "◉", tone: "bg-sky-50 text-sky-800" },
  { name: "Financial Literacy", detail: "Money basics", icon: "₹", tone: "bg-green-50 text-green-800" },
  { name: "Vocab Champ", detail: "Word power", icon: "Aᶻ", tone: "bg-fuchsia-50 text-fuchsia-800" },
  { name: "Spell Bee", detail: "Spelling mastery", icon: "Bee", tone: "bg-amber-50 text-amber-900" },
] as const;

export async function ProductCatalog() {
  const products = await listProducts();
  const session = await getSession();
  const entitlements = session ? getEntitlementsForUser(session.sub) : null;

  return (
    <section id="products" className="overflow-hidden bg-white py-24 sm:py-28 lg:py-32">
      <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-14">
        <div className="max-w-4xl">
          <p className="text-sm font-extrabold uppercase tracking-[0.2em] text-[#1565C0]">Explore their next possibility</p>
          <h2 className="mt-4 text-4xl font-black leading-tight tracking-[-0.045em] text-[#082452] sm:text-5xl lg:text-[3.5rem]">Discover what your child can master next</h2>
        </div>

        <div className="mt-14 grid gap-6 lg:grid-cols-3">
          {featureOrder.map((slug) => {
            const config = featureConfig[slug];
            const product = products.find((candidate) => candidate.slug === slug);
            const hasAccess = Boolean(product && entitlements && (entitlements.bundle || entitlements.products.includes(product.slug)));
            let ctaLabel = "Explore";
            let ctaHref = session ? "/account" : "/signup";
            let opensNewTab = false;
            if (product && hasAccess) {
              ctaLabel = "Launch App";
              ctaHref = `https://${product.subdomain}`;
              opensNewTab = true;
            } else if (product && session) {
              ctaHref = `/account/subscriptions/new?product=${encodeURIComponent(product.slug)}`;
            }
            const actionClass = "inline-flex min-h-12 items-center gap-2 self-start rounded-full bg-white px-5 py-3 text-sm font-extrabold text-slate-900 shadow-lg transition hover:-translate-y-0.5 hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white";
            return (
              <article key={slug} className={`group relative min-h-[500px] overflow-hidden rounded-[2rem] bg-gradient-to-br ${config.cardClass} p-7 text-white shadow-[0_28px_65px_rgba(15,23,42,0.16)] sm:p-9`}>
                <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-white/15 blur-2xl transition-transform duration-500 group-hover:scale-110" />
                <div className="relative flex h-full flex-col">
                  <h3 className="text-3xl font-black tracking-[-0.03em] sm:text-4xl">{config.name}</h3>
                  <p className="mt-3 text-lg font-semibold text-white/85">{config.outcome}</p>
                  <div className="relative my-8 flex flex-1 items-center justify-center" aria-hidden="true">
                    <div className="absolute h-56 w-56 rounded-full border border-white/20 bg-white/10" />
                    <div className="absolute h-40 w-40 rotate-6 rounded-[2.5rem] bg-white/10 shadow-inner" />
                    <span className="relative text-[7rem] font-black leading-none drop-shadow-2xl" style={{ color: config.accent }}>{config.icon}</span>
                  </div>
                  {opensNewTab ? <a href={ctaHref} target="_blank" rel="noreferrer" className={actionClass}>{ctaLabel}<span aria-hidden="true">→</span></a> : <Link href={ctaHref} className={actionClass}>{ctaLabel}<span aria-hidden="true">→</span></Link>}
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <div className="mt-20">
        <div className="mx-auto mb-7 flex max-w-7xl items-end justify-between gap-5 px-5 sm:px-8 lg:px-14">
          <div>
            <p className="text-sm font-extrabold uppercase tracking-[0.18em] text-[#1565C0]">The Babysteps ecosystem</p>
            <h3 className="mt-2 text-2xl font-black text-[#082452] sm:text-3xl">A new skill is always within reach.</h3>
          </div>
          <p className="hidden max-w-xs text-right text-sm leading-6 text-slate-500 sm:block">Swipe or hover to explore. More journeys are on the way.</p>
        </div>
        <div className="app-marquee" aria-label="Babysteps learning app ecosystem">
          <div className="app-marquee-track">
            {[...ecosystemApps, ...ecosystemApps].map((app, index) => (
              <article key={`${app.name}-${index}`} aria-hidden={index >= ecosystemApps.length ? true : undefined} className={`mx-2 flex h-[148px] w-[250px] shrink-0 flex-col justify-between rounded-[1.5rem] p-5 shadow-[0_10px_28px_rgba(15,23,42,.08)] ${app.tone}`}>
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/90 text-lg font-black shadow-sm" aria-hidden="true">{app.icon}</span>
                <span><span className="block text-base font-black">{app.name}</span><span className="mt-1 block text-sm opacity-70">{app.detail}</span></span>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
