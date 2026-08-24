const ideas = [
  { icon: "✦", title: "Build Confidence", detail: "Celebrate real progress so every new challenge feels possible." },
  { icon: "◎", title: "Practice with Purpose", detail: "Focused activities turn time on a screen into time well spent." },
  { icon: "↗", title: "Grow One Skill at a Time", detail: "Clear journeys make meaningful growth feel calm and achievable." },
] as const;

export function BrandPhilosophy() {
  return (
    <section className="bg-[#E8F2FC] py-24 sm:py-28 lg:py-32">
      <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-14">
        <div className="max-w-3xl">
          <p className="text-sm font-extrabold uppercase tracking-[0.2em] text-[#1565C0]">The Babysteps way</p>
          <h2 className="mt-4 text-4xl font-black leading-tight tracking-[-0.04em] text-[#082452] sm:text-5xl">
            Learning should feel like progress — not pressure.
          </h2>
        </div>
        <div className="mt-14 grid gap-10 md:grid-cols-3 md:gap-12">
          {ideas.map((idea) => (
            <article key={idea.title} className="max-w-sm">
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white text-3xl font-black text-[#1565C0] shadow-[0_14px_30px_rgba(13,71,161,.10)]" aria-hidden="true">{idea.icon}</span>
              <h3 className="mt-7 text-2xl font-black text-[#082452]">{idea.title}</h3>
              <p className="mt-3 text-base leading-7 text-slate-600">{idea.detail}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
