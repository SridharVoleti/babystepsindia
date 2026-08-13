"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const DESTINATIONS = [
  { href: "/account", label: "Home" },
  { href: "/account/learners", label: "Learners" },
  { href: "/account/attention", label: "Attention" },
  { href: "/account/subscriptions", label: "Billing" },
  { href: "/account/security", label: "Account" },
] as const;

function isActive(pathname: string, href: string) {
  if (href === "/account") return pathname === "/account";
  return pathname.startsWith(href);
}

function Badge({ count, className = "" }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={`inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-600 px-1 text-xs font-semibold text-white ${className}`}
      aria-label={`${count} item${count === 1 ? "" : "s"} need attention`}
    >
      {count}
    </span>
  );
}

// PD-004: presentation only — every destination's own page/route still
// independently reauthorizes. This component never decides access, only
// where the link points.
export function ParentNav({ attentionCount, onSignOut }: {
  attentionCount: number;
  onSignOut: () => void | Promise<void>;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label="Parent navigation">
      <div className="hidden items-center justify-between gap-1 border-b border-chakra-100 bg-white px-6 py-2 sm:flex">
        <div className="flex items-center gap-1">
          {DESTINATIONS.map((destination) => (
            <Link key={destination.href} href={destination.href}
              aria-current={isActive(pathname, destination.href) ? "page" : undefined}
              className={`inline-flex min-h-[44px] items-center gap-2 rounded-lg px-3 text-sm font-medium ${
                isActive(pathname, destination.href) ? "bg-green-50 text-green-800" : "text-chakra-600 hover:text-chakra-900"}`}>
              {destination.label}
              {destination.href === "/account/attention" && <Badge count={attentionCount} />}
            </Link>
          ))}
        </div>
        <form action={onSignOut}>
          <button type="submit" className="min-h-[44px] text-sm font-medium text-chakra-500 hover:text-chakra-900">
            Log out
          </button>
        </form>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-10 flex items-stretch justify-around border-t border-chakra-100 bg-white sm:hidden">
        {DESTINATIONS.slice(0, 3).map((destination) => (
          <Link key={destination.href} href={destination.href}
            aria-current={isActive(pathname, destination.href) ? "page" : undefined}
            className={`flex min-h-[44px] min-w-[44px] flex-1 flex-col items-center justify-center gap-1 py-2 text-xs font-medium ${
              isActive(pathname, destination.href) ? "text-green-800" : "text-chakra-600"}`}>
            <span className="relative">
              {destination.label}
              {destination.href === "/account/attention" && (
                <Badge count={attentionCount} className="absolute -right-4 -top-2 h-4 min-w-[16px] px-1 text-[10px]" />
              )}
            </span>
          </Link>
        ))}
        <details className="relative flex-1">
          <summary className="flex min-h-[44px] list-none flex-col items-center justify-center gap-1 py-2 text-xs font-medium text-chakra-600">
            More
          </summary>
          <div className="absolute bottom-full right-0 mb-2 w-44 rounded-lg border border-chakra-100 bg-white p-2 shadow-lg">
            {DESTINATIONS.slice(3).map((destination) => (
              <Link key={destination.href} href={destination.href}
                className="block min-h-[44px] rounded px-3 py-2 text-sm text-chakra-700 hover:bg-chakra-50">
                {destination.label}
              </Link>
            ))}
            <form action={onSignOut}>
              <button type="submit" className="mt-1 block min-h-[44px] w-full rounded px-3 py-2 text-left text-sm text-chakra-700 hover:bg-chakra-50">
                Log out
              </button>
            </form>
          </div>
        </details>
      </div>
    </nav>
  );
}
