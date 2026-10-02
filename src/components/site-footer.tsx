import Link from "next/link";
import { BabystepsLogo } from "@/components/babysteps-logo";

export function SiteFooter() {
  return (
    <footer id="about" className="mt-16 bg-[#082452] text-white">
      <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8 lg:px-14">
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
            <Link href="/#products" className="hover:text-white">Learning Apps</Link>
            <Link href="/#how-it-works" className="hover:text-white">How It Works</Link>
            <Link href="/#for-parents" className="hover:text-white">For Parents</Link>
            <Link href="/login" className="hover:text-white">Sign In</Link>
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
