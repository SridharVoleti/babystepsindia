import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-chakra-100/80 bg-cream/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2">
          <span className="relative flex h-8 w-8 items-center justify-center rounded-full border-2 border-chakra-600">
            <span className="h-2 w-2 rounded-full bg-chakra-600" />
          </span>
          <span className="text-lg font-bold tracking-tight text-chakra-900">
            Baby Steps
          </span>
        </Link>

        <nav className="hidden items-center gap-8 text-sm font-medium text-chakra-700 sm:flex">
          <Link href="/#products" className="transition-colors hover:text-chakra-900">
            Products
          </Link>
          <Link href="/#pricing" className="transition-colors hover:text-chakra-900">
            Pricing
          </Link>
        </nav>

        <div className="flex items-center gap-3">
          <Link href="/login" className="btn-secondary">
            Log in
          </Link>
          <Link href="/signup" className="btn-primary">
            Get started
          </Link>
        </div>
      </div>
      <div className="tricolor-rule" />
    </header>
  );
}
