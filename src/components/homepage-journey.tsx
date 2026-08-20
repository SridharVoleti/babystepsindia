import Link from "next/link";

const steps = [
  {
    number: "1",
    title: "Create account",
    detail: "Set up your parent account in a few simple steps.",
    icon: "＋",
    color: "bg-blue-50 text-[#1565C0] ring-blue-100",
    badge: "bg-[#1565C0]",
  },
  {
    number: "2",
    title: "Add learner",
    detail: "Add your child so learning stays personal and organised.",
    icon: "●",
    color: "bg-green-50 text-green-700 ring-green-100",
    badge: "bg-green-600",
  },
  {
    number: "3",
    title: "Choose app",
    detail: "Pick the skill journey that matches what they want to build.",
    icon: "▦",
    color: "bg-orange-50 text-orange-700 ring-orange-100",
    badge: "bg-orange-500",
  },
  {
    number: "4",
    title: "Begin journey",
    detail: "Learn, practise and build visible progress step by step.",
    icon: "↗",
    color: "bg-blue-50 text-[#0D47A1] ring-blue-100",
    badge: "bg-[#0D47A1]",
  },
] as const;

export function HomepageJourney() {
  return (
    <section id="how-it-works" className="bg-white py-16 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-sm font-extrabold uppercase tracking-[0.2em] text-[#1565C0]">
            How Babysteps works
          </p>
          <h2 className="mt-3 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">
            Your 4-step journey to lifelong skills
          </h2>
          <p className="mt-4 text-base leading-7 text-slate-600 sm:text-lg">
            The parent journey stays simple, while each learner gets a focused path built around the app they choose.
          </p>
        </div>

        <div className="relative mt-12 grid gap-8 md:grid-cols-4 md:gap-5">
          <div className="absolute left-[12.5%] right-[12.5%] top-[50px] hidden border-t-2 border-dashed border-slate-200 md:block" />
          {steps.map((step) => (
            <article key={step.title} className="relative text-center">
              <span className={`absolute left-1/2 top-0 z-10 flex h-7 w-7 -translate-x-[58px] -translate-y-1 items-center justify-center rounded-full text-xs font-black text-white shadow-sm ${step.badge}`}>
                {step.number}
              </span>
              <div className={`relative z-10 mx-auto flex h-24 w-24 items-center justify-center rounded-full ring-8 ${step.color}`}>
                <span className="text-3xl font-black" aria-hidden="true">{step.icon}</span>
              </div>
              <h3 className="mt-5 text-lg font-extrabold text-slate-950">{step.title}</h3>
              <p className="mx-auto mt-2 max-w-[15rem] text-sm leading-6 text-slate-600">{step.detail}</p>
            </article>
          ))}
        </div>

        <div id="for-parents" className="mt-14 overflow-hidden rounded-[28px] border border-blue-100 bg-[#E8F2FC] p-6 sm:p-8 lg:flex lg:items-center lg:justify-between lg:gap-10">
          <div className="max-w-3xl">
            <p className="text-sm font-extrabold uppercase tracking-[0.18em] text-[#1565C0]">For parents</p>
            <h3 className="mt-2 text-2xl font-black text-slate-950 sm:text-3xl">
              Learning they enjoy. Progress you can see.
            </h3>
            <p className="mt-3 max-w-2xl text-base leading-7 text-slate-700">
              Babysteps keeps the parent in control of learners and app choices while giving children a clear, motivating path to the next skill.
            </p>
          </div>
          <Link
            href="/signup"
            className="mt-6 inline-flex min-h-12 shrink-0 items-center justify-center rounded-xl bg-[#1565C0] px-6 py-3 text-sm font-extrabold text-white shadow-sm transition hover:bg-[#0D47A1] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1565C0] lg:mt-0"
          >
            Start Your Child&apos;s Journey <span className="ml-2" aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
    </section>
  );
}
