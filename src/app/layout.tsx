import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Babysteps | Turn Screen Time into Skill Time",
  description:
    "Focused learning apps for maths, chess, reading and more — designed to help children turn screen time into real skill time.",
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
