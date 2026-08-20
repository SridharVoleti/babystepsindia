import Link from "next/link";
import { BabystepsLogo } from "@/components/babysteps-logo";

export function SiteFooter() {
  return (
    <footer className="bg-[#082452] text-white">
      <section id="pricing" className="border-b border-white/10 bg-[#0B3D91]">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-8 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div>
            <p className="text-sm font-extrabold uppercase tracking-[0.18em] text-blue-200">Subscriptions</p>
            <h2 className="mt-1 text-2xl font-black">Choose the learner. Choose the app. See the price before you subscribe.</h2>
          </div>
          <Link
            href="/#products"
            className="inline-flex min-h-12 shrink-0 items-center justify-center rounded-xl bg-white px-6 py-3 text-sm font-extrabold text-[#0D47A1] transition hover:bg-blue-50"
          >
            Explore Learning Apps <span className="ml-2" aria-hidden="true">→</span>
          </Link>
        </div>
      </section>

      <div id="about" className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid gap-8 md:grid-cols-[1.2fr_.8fr] md:items-end">
          <div>
            <div className="flex items-center gap-2.5">
              <BabystepsLogo showWordmark={false} />
              <span className="text-xl font-extrabold tracking-tight text-white">babysteps</span>
            </div>
            <p className="mt-4 max-w-xl text-sm leading-6 text-blue-100/80">
              Focused learning journeys designed to help children build useful skills, one Babystep at a time.
            </p>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm font-semibold text-blue-100 md:justify-end">
            <Link href="/#products" className="hover:text-white">Apps</Link>
            <Link href="/#how-it-works" className="hover:text-white">How It Works</Link>
            <Link href="/#for-parents" className="hover:text-white">For Parents</Link>
            <Link href="/login" className="hover:text-white">Log in</Link>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-2 border-t border-white/10 pt-6 text-xs text-blue-200/80 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Babysteps India.</p>
          <p>Turn Screen Time into Skill Time.</p>
        </div>
      </div>
    </footer>
  );
}
