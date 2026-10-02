import Image from "next/image";
import Link from "next/link";

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden bg-[#f7fbff] text-slate-950">
      <div className="absolute inset-x-0 top-0 -z-10 h-full bg-[radial-gradient(circle_at_82%_35%,rgba(30,136,229,0.16),transparent_34%),radial-gradient(circle_at_18%_12%,rgba(255,176,0,0.10),transparent_22%)]" />
      <div className="absolute -right-20 top-16 -z-10 h-80 w-80 rounded-full bg-[#dceeff] blur-3xl" />

      <div className="relative mx-auto grid min-h-[calc(100svh-76px)] max-w-[1440px] items-center gap-10 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-[.92fr_1.08fr] lg:px-14 lg:py-12 xl:px-20">
        <div className="max-w-[690px]">
          <p className="mb-6 text-sm font-extrabold uppercase tracking-[0.22em] text-[#1565C0]">
            Small steps. Remarkable growth.
          </p>

          <h1 className="text-[3.35rem] font-black leading-[0.96] tracking-[-0.055em] text-[#082452] sm:text-6xl lg:text-[4.4rem] xl:text-[5rem]">
            Turn <span className="text-[#FFB000]">Screen Time</span>
            <br />
            into <span className="text-[#FFB000]">Skill Time</span>
          </h1>

          <p className="mt-7 max-w-[610px] text-lg leading-8 text-slate-600 sm:text-xl sm:leading-9">
            Babysteps turns everyday screen time into focused learning journeys that build real skills, confidence and curiosity.
          </p>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link
              href="/signup"
              className="inline-flex min-h-14 items-center justify-center rounded-full bg-[#1565C0] px-7 py-4 text-base font-extrabold text-white shadow-[0_16px_34px_rgba(21,101,192,0.24)] transition hover:-translate-y-0.5 hover:bg-[#0D47A1] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1565C0]"
            >
              Start Your Child&apos;s Journey <span className="ml-2" aria-hidden="true">→</span>
            </Link>
            <Link
              href="/#products"
              className="inline-flex min-h-14 items-center justify-center rounded-full px-6 py-4 text-base font-bold text-[#0D47A1] transition hover:bg-[#E8F2FC] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1565C0]"
            >
              Explore Learning Apps
            </Link>
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-[720px] lg:mx-0 lg:justify-self-end">
          <span className="absolute left-0 top-[12%] z-10 flex h-16 w-16 -rotate-6 items-center justify-center rounded-2xl bg-white text-3xl font-black text-[#1565C0] shadow-[0_16px_35px_rgba(13,71,161,.16)]" aria-hidden="true">∑</span>
          <span className="absolute right-[4%] top-[3%] z-10 flex h-14 w-14 rotate-6 items-center justify-center rounded-full bg-[#FFB000] text-2xl text-white shadow-lg" aria-hidden="true">♞</span>
          <span className="absolute bottom-[9%] right-[1%] z-10 flex h-14 w-14 -rotate-6 items-center justify-center rounded-2xl bg-white text-2xl shadow-lg" aria-hidden="true">🚀</span>
          <Image
            src="/babysteps-hero-learner.svg"
            width={640}
            height={520}
            priority
            alt="A child enjoying a focused Babysteps learning session on a tablet"
            className="h-auto w-full scale-[1.04] drop-shadow-[0_28px_45px_rgba(13,71,161,0.20)]"
          />
        </div>
      </div>
    </section>
  );
}
