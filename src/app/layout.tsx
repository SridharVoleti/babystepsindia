import type { Metadata } from "next";
import "./globals.css";

// Vercel Hobby's default Function execution timeout (10s) was racing
// postgres-adapter.ts's connectionTimeoutMillis (25s, itself raised after
// verifying live that the cross-region Vercel<->Supabase handshake
// reliably takes just over 10s) — without headroom here the platform
// would kill the function before the handshake, let alone the query
// sequence after it, could finish. 60 is Hobby's allowed max; inherited
// by every route below this layout.
export const maxDuration = 60;

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
