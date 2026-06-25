/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produces a minimal, self-contained server bundle in .next/standalone.
  // Used by the Dockerfile; also works fine with Railway Nixpacks.
  output: "standalone",
  reactStrictMode: true,
};

export default nextConfig;
