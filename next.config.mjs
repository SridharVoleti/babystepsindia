/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Parallel local development sessions can otherwise contend for .next/trace.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
