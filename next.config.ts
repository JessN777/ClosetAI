import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This repository has another lockfile in its parent directory; keep Next's
  // dev resolver scoped to this app so it doesn't serve the parent's route tree.
  turbopack: { root: process.cwd() },
  // The background-removal package loads a platform-native Sharp binary at runtime.
  // Keep it and its native dependency outside the server webpack bundle.
  serverExternalPackages: ["@imgly/background-removal-node", "sharp"],
};

export default nextConfig;
