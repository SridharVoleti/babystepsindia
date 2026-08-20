import Image from "next/image";
import Link from "next/link";

const benefits = [
  { icon: "✦", title: "Stronger Skills", detail: "built step by step" },
  { icon: "↗", title: "Visible Progress", detail: "parents can follow" },
  { icon: "◎", title: "Focused Learning", detail: "purposeful app journeys" },
] as const;

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-[#082452] text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_68%_25%,rgba(30,136,229,0.55),transparent_38%),linear-gradient(115deg,#061B43_0%,#0B3D91_55%,#1565C0_100%)]" />
      <div className="absolute -left-24 top-16 h-72 w-72 rounded-full bg-[#1E88E5]/15 blur-3xl" />
      <div className="absolute right-1/3 top-20 h-56 w-56 rounded-full bg-[#FFB000]/10 blur-3xl" />

      <div className="relative mx-auto grid max-w-7xl items-center gap-8 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[1.03fr_.97fr] lg:px-8 lg:py-20">
        <div className="max-w-2xl">
          <p className="mb-4 inline-flex items-center rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-blue-100">
            Learn • Practice • Master • Progress
          </p>

          <h1 className="text-5xl font-black leading-[0.98] tracking-tight sm:text-6xl lg:text-7xl">
            Turn <span className="text-[#FFB000]">Screen Time</span>
            <br />
            into <span className="text-[#FFB000]">Skill Time</span>
          </h1>

          <p className="mt-6 max-w-xl text-lg leading-8 text-blue-50/95 sm:text-xl">
            Babysteps learning apps turn focused screen time into real progress in
            maths, chess, reading, science, vocabulary, money skills and more.
          </p>

          <div className="mt-7 grid max-w-2xl gap-3 sm:grid-cols-3">
            {benefits.map((benefit) => (
              <div key={benefit.title} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/8 p-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/12 text-xl font-black text-[#FFB000]">
                  {benefit.icon}
                </span>
                <div>
                  <p className="text-sm font-bold text-white">{benefit.title}</p>
                  <p className="text-xs text-blue-100/80">{benefit.detail}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link
              href="/signup"
              className="inline-flex min-h-12 items-center justify-center rounded-lg bg-[#1565C0] px-6 py-3 text-base font-extrabold text-white shadow-[0_14px_30px_rgba(0,0,0,0.22)] ring-1 ring-white/15 transition hover:bg-[#1E88E5] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              Start Your Child&apos;s Journey <span className="ml-2" aria-hidden="true">→</span>
            </Link>
            <Link
              href="/#products"
              className="inline-flex min-h-12 items-center justify-center rounded-lg border border-white/25 bg-white/10 px-5 py-3 text-sm font-bold text-white transition hover:bg-white/15"
            >
              Explore Learning Apps
            </Link>
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-[600px] lg:mx-0 lg:justify-self-end">
          <div className="absolute -left-5 top-10 z-10 rounded-2xl border border-white/15 bg-white/95 px-4 py-3 text-[#0D47A1] shadow-xl">
            <p className="text-xs font-semibold text-slate-500">Learning path</p>
            <p className="mt-1 text-sm font-extrabold">One step at a time ↗</p>
          </div>
          <div className="absolute -right-2 bottom-12 z-10 rounded-2xl border border-white/15 bg-white/95 px-4 py-3 text-[#0D47A1] shadow-xl">
            <p className="text-xs font-semibold text-slate-500">Progress</p>
            <p className="mt-1 text-sm font-extrabold">Practice → Master</p>
          </div>
          <Image
            src="/babysteps-hero-learner.svg"
            width={640}
            height={520}
            priority
            alt="A child enjoying a focused Babysteps learning session on a tablet"
            className="h-auto w-full drop-shadow-[0_24px_34px_rgba(0,0,0,0.25)]"
          />
        </div>
      </div>
    </section>
  );
}
