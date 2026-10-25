const DEMO_TRYON_RESULTS = {
  "00000000-0000-4000-8000-000000000001": "/demo/tryon-result.png",
  "00000000-0000-4000-8000-000000000002": "/demo/tryon-navy-shirt.png",
  "00000000-0000-4000-8000-000000000003": "/demo/tryon-navy-overshirt.png",
  "00000000-0000-4000-8000-000000000004": "/demo/tryon-navy-cardigan.png",
} as const;

export function demoTryOnResultUrl(jobId: string) {
  return DEMO_TRYON_RESULTS[jobId as keyof typeof DEMO_TRYON_RESULTS] ?? null;
}

export function demoTryOnForGarment(name: string) {
  const lower = name.toLowerCase();
  const jobId = lower.includes("cardigan")
    ? "00000000-0000-4000-8000-000000000004"
    : lower.includes("overshirt")
      ? "00000000-0000-4000-8000-000000000003"
      : lower.includes("shirt")
        ? "00000000-0000-4000-8000-000000000002"
        : "00000000-0000-4000-8000-000000000001";
  return { jobId, resultUrl: DEMO_TRYON_RESULTS[jobId] };
}
