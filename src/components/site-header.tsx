import Link from "next/link";
import Image from "next/image";
import { getSession } from "@/lib/auth/session";
import { signOutAction } from "@/app/(auth)/actions";

export async function SiteHeader() {
  const session = await getSession();

  return (
    <header className="sticky top-0 z-40 rounded-b-[22px] bg-white/95 shadow-sm backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-5 py-4 sm:px-8 lg:px-10">
        <Link href="/" className="flex shrink-0 items-center">
          <Image
            src="/brand/homepage-logo-v2.png"
            alt="Babysteps"
            width={285}
            height={72}
            priority
            className="h-16 w-auto object-contain"
          />
        </Link>

        <nav className="hidden items-center gap-8 text-sm font-bold text-[#0a1648] md:flex">
          <Link href="/#products" className="transition-colors hover:text-chakra-900">
            Apps
          </Link>
          <Link href="/#journey" className="transition-colors hover:text-chakra-900">
            How It Works
          </Link>
          <Link href="/account" className="transition-colors hover:text-chakra-900">
            For Parents
          </Link>
          <Link href="/account/subscriptions/new" className="transition-colors hover:text-chakra-900">
            Pricing
          </Link>
          <Link href="/#about" className="transition-colors hover:text-chakra-900">
            About Us
          </Link>
        </nav>

        <div className="flex items-center gap-3">
          {session ? (
            <>
              <Link href="/account" className="btn-secondary">
                My account
              </Link>
              <form action={signOutAction}>
                <button type="submit" className="btn-primary">
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <>
              <Link href="/login" className="hidden text-sm font-bold text-[#0a1648] transition-colors hover:text-chakra-700 sm:inline-flex">
                Log in
              </Link>
              <Link href="/signup" className="btn-primary gap-2 rounded-xl px-5 py-3">
                Create Account
                <span aria-hidden="true">›</span>
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
