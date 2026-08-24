import type { Metadata } from "next";
import "./globals.css";

// Vercel Hobby's default Function execution timeout (10s) was racing
// postgres-adapter.ts's connectionTimeoutMillis (also 10s) — the platform
// killed the function before/while the cross-region (Vercel US <->
// Supabase ap-southeast-1) TLS handshake completed, which surfaced from
// `pg` as "Connection terminated unexpectedly" rather than a clean
// timeout. Raising this (inherited by every route below this layout,
// Hobby allows up to 60s) gives the handshake room to actually finish.
export const maxDuration = 30;

export const metadata: Metadata = {
  title: "Baby Steps",
  description:
    "One account, every Baby Steps product — ChessQuest, Magical Math, and Speed Reading.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
