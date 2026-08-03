import type { Metadata } from "next";
import "./globals.css";

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
