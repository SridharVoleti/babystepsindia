import Link from "next/link";
import { BabystepsLogo } from "@/components/babysteps-logo";

export function SiteHeader() {
  return (
    <header className="relative z-50 border-b border-blue-100/70 bg-white">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-5 px-5 py-3 sm:px-8 lg:px-14 xl:px-20">
        <Link href="/" className="shrink-0" aria-label="Babysteps home">
          <BabystepsLogo />
        </Link>

        <nav className="hidden items-center gap-9 text-sm font-bold text-slate-600 lg:flex" aria-label="Primary navigation">
          <Link href="/#products" className="transition-colors hover:text-[#1565C0]">
            Learning Apps
          </Link>
          <Link href="/#how-it-works" className="transition-colors hover:text-[#1565C0]">
            How It Works
          </Link>
          <Link href="/#for-parents" className="transition-colors hover:text-[#1565C0]">
            For Parents
          </Link>
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <Link
            href="/login"
            className="hidden min-h-12 items-center rounded-full px-4 py-2 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-100 sm:inline-flex"
          >
            Sign In
          </Link>
          <Link
            href="/signup"
            className="inline-flex min-h-12 items-center justify-center rounded-full bg-[#1565C0] px-4 py-2 text-sm font-extrabold text-white shadow-[0_10px_24px_rgba(21,101,192,.18)] transition hover:bg-[#0D47A1] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1565C0] sm:px-6"
          >
            <span className="sm:hidden">Start Journey</span><span className="hidden sm:inline">Start Your Child&apos;s Journey</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
