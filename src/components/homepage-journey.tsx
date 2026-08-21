import Link from "next/link";

const steps = [
  { number: "01", title: "Create account", detail: "Your parent space starts here.", icon: "＋" },
  { number: "02", title: "Add learner", detail: "Make the journey personal.", icon: "●" },
  { number: "03", title: "Choose app", detail: "Pick the skill to grow next.", icon: "▦" },
  { number: "04", title: "Begin journey", detail: "Learn and progress step by step.", icon: "↗" },
] as const;

export function HomepageJourney() {
  return (
    <>
      <section id="how-it-works" className="bg-white py-24 sm:py-28 lg:py-32">
        <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-14">
          <div className="max-w-4xl">
            <p className="text-sm font-extrabold uppercase tracking-[0.2em] text-[#1565C0]">Four simple steps</p>
            <h2 className="mt-4 text-4xl font-black leading-tight tracking-[-0.045em] text-[#082452] sm:text-5xl">Getting started takes just a few minutes.</h2>
          </div>

          <div className="relative mt-16 grid gap-5 md:grid-cols-4">
            <div className="absolute left-[9%] right-[9%] top-20 hidden border-t-2 border-dashed border-blue-200 md:block" />
            {steps.map((step, index) => (
              <article key={step.title} className={`relative z-10 min-h-[280px] rounded-[2rem] p-7 shadow-[0_18px_45px_rgba(13,71,161,.10)] ${index % 2 === 0 ? "bg-[#F5FAFF]" : "bg-[#E8F2FC] md:translate-y-7"}`}>
                <div className="flex items-start justify-between">
                  <span className="text-sm font-black tracking-[0.16em] text-[#1565C0]">STEP {step.number}</span>
                  <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-2xl font-black text-[#1565C0] shadow-sm" aria-hidden="true">{step.icon}</span>
                </div>
                <h3 className="mt-20 text-2xl font-black text-[#082452]">{step.title}</h3>
                <p className="mt-3 text-base leading-7 text-slate-600">{step.detail}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="for-parents" className="px-5 pb-8 sm:px-8 lg:px-14">
        <div className="relative mx-auto max-w-7xl overflow-hidden rounded-[2.5rem] bg-[#0D47A1] px-6 py-20 text-center text-white shadow-[0_30px_80px_rgba(13,71,161,.22)] sm:px-12 sm:py-24">
          <div className="absolute -left-16 -top-20 h-64 w-64 rounded-full bg-[#1E88E5]/60 blur-3xl" />
          <div className="absolute -bottom-24 -right-16 h-72 w-72 rounded-full bg-[#FFB000]/20 blur-3xl" />
          <div className="relative mx-auto max-w-4xl">
            <p className="text-sm font-extrabold uppercase tracking-[0.22em] text-blue-200">Ready when they are</p>
            <h2 className="mt-5 text-4xl font-black leading-tight tracking-[-0.045em] sm:text-5xl lg:text-6xl">Turn today&apos;s screen time into tomorrow&apos;s skills.</h2>
            <div className="mt-9 flex flex-col items-center justify-center gap-5 sm:flex-row">
              <Link href="/signup" className="inline-flex min-h-14 items-center justify-center rounded-full bg-white px-7 py-4 text-base font-extrabold text-[#0D47A1] shadow-xl transition hover:-translate-y-0.5 hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white">Start Your Child&apos;s Journey <span className="ml-2" aria-hidden="true">→</span></Link>
              <p className="text-sm font-semibold text-blue-100">Already have an account? <Link href="/login" className="underline decoration-blue-300 underline-offset-4 hover:text-white">Sign in</Link></p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
