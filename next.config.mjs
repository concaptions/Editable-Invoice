/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produces a minimal, self-contained server bundle in .next/standalone.
  // Used by the Dockerfile; also works fine with Railway Nixpacks.
  output: "standalone",
  reactStrictMode: true,
  // @react-pdf/renderer pulls in Node-native deps (fontkit, yoga wasm). Keep it
  // out of the webpack bundle so it's required from node_modules at runtime;
  // this also lets nft trace it into the standalone server output correctly.
  serverExternalPackages: ["@react-pdf/renderer"],
};

export default nextConfig;
