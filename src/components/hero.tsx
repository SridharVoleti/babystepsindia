import Link from "next/link";
import Image from "next/image";

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-chakra-900 text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_62%_30%,rgba(21,101,192,0.72),transparent_34%),linear-gradient(105deg,#010937_0%,#1565C0_53%,#0D47A1_100%)]" />
      <div className="absolute inset-x-0 bottom-0 h-20 origin-bottom-left -skew-y-2 bg-cream" />

      <div className="relative mx-auto grid min-h-[560px] max-w-7xl items-center gap-8 px-6 pb-24 pt-14 lg:grid-cols-[0.9fr_1.1fr] lg:px-10 lg:pb-20 lg:pt-12">
        <div className="z-10 max-w-3xl">
          <h1 className="text-[clamp(3.25rem,8vw,6.55rem)] font-extrabold leading-[0.93] tracking-normal">
            <span className="block">Turn</span>
            <span className="block text-saffron-500">Screen Time</span>
            <span className="block">
              into <span className="text-saffron-500">Skill Time</span>
            </span>
          </h1>

          <p className="mt-6 max-w-2xl text-xl font-medium leading-relaxed text-white/92 sm:text-2xl">
            Expert-designed learning apps that make kids smarter, faster and
            more confident every day.
          </p>

          <div className="mt-7 grid max-w-2xl gap-4 sm:grid-cols-3">
            {[
              ["B", "Stronger Skills", "for school & life"],
              ["P", "Visible Progress", "you can track"],
              ["S", "Safe, Ad-free", "learning space"],
            ].map(([icon, title, body]) => (
              <div key={title} className="flex items-center gap-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/14 text-lg font-black text-saffron-500 shadow-[0_0_24px_rgba(21,101,192,0.45)] ring-1 ring-white/15">
                  {icon}
                </span>
                <span className="text-sm font-bold leading-tight text-white">
                  {title}
                  <span className="block font-semibold text-white/82">{body}</span>
                </span>
              </div>
            ))}
          </div>

          <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <Link href="/signup" className="btn-primary gap-3 rounded-xl px-7 py-4 text-lg font-extrabold shadow-[0_18px_32px_rgba(13,71,161,0.35)] focus-visible:outline-white">
              Create Account Now
              <span aria-hidden="true" className="text-3xl leading-none">›</span>
            </Link>
            <p className="text-sm font-semibold text-white/86">Free to start. Cancel anytime.</p>
          </div>
        </div>

        <div className="relative min-h-[330px] lg:min-h-[520px]">
          <Image
            src="/brand/homepage-hero-child-v2.png"
            alt="Child learning with a Babysteps tablet"
            fill
            priority
            sizes="(min-width: 1024px) 54vw, 100vw"
            className="object-contain object-bottom"
          />
        </div>
      </div>
    </section>
  );
}
