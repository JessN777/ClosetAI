import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This repository has another lockfile in its parent directory; keep Next's
  // dev resolver scoped to this app so it doesn't serve the parent's route tree.
  turbopack: { root: process.cwd() },
  serverExternalPackages: ["sharp"],
};

export default nextConfig;
