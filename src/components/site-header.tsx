import Link from "next/link";
import { BabystepsLogo } from "@/components/babysteps-logo";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-slate-200/80 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-4 py-3 sm:px-6 lg:px-8">
        <Link href="/" className="shrink-0" aria-label="Babysteps home">
          <BabystepsLogo />
        </Link>

        <nav className="hidden items-center gap-7 text-sm font-semibold text-slate-700 lg:flex" aria-label="Primary navigation">
          <Link href="/#products" className="transition-colors hover:text-[#1565C0]">
            Apps
          </Link>
          <Link href="/#how-it-works" className="transition-colors hover:text-[#1565C0]">
            How It Works
          </Link>
          <Link href="/#for-parents" className="transition-colors hover:text-[#1565C0]">
            For Parents
          </Link>
          <Link href="/#pricing" className="transition-colors hover:text-[#1565C0]">
            Pricing
          </Link>
          <Link href="/#about" className="transition-colors hover:text-[#1565C0]">
            About Us
          </Link>
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <Link
            href="/login"
            className="hidden rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 sm:inline-flex"
          >
            Log in
          </Link>
          <Link
            href="/signup"
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-[#1565C0] px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-[#0D47A1] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1565C0] sm:px-5"
          >
            Create Account <span className="ml-2" aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
