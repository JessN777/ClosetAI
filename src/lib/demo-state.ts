export const DEMO_STATE_ID = "closetai-demo-wardrobe-v1";

export const DEMO_UTTERANCES = [
  { id: "shirt-search", transcript: "I'm looking for this shirt.", audio: "/demo/audio/01-shirt-search.wav" },
  { id: "barge-in", transcript: "Actually, show me a navy option.", audio: "/demo/audio/02-barge-in.wav" },
  { id: "style-match", transcript: "Find something that looks good on me.", audio: "/demo/audio/03-style-match.wav" },
  { id: "remember-navy", transcript: "Remember I prefer navy.", audio: "/demo/audio/04-remember-navy.wav" },
  { id: "dress-like", transcript: "Dress like quiet luxury.", audio: "/demo/audio/05-dress-like.wav" },
  { id: "shop-the-look", transcript: "Shop the quiet luxury look.", audio: "/demo/audio/06-shop-the-look.wav" },
] as const;

export const DEMO_PREFERENCES = {
  favoriteColors: [] as string[],
  fit: ["relaxed"],
  occasions: ["everyday"],
  budget: { currency: "USD" as const, max: 120 },
  sizes: { top: "M" },
  version: 0,
  updatedAt: null as number | null,
};

export const DEMO_PRODUCTS = [
  { name: "Navy Cotton Knit Cardigan", retailer: "Northline Studio", price: "$58", tier: "Everyday", imageUrl: "/demo/product-navy-cardigan.svg", href: "#demo-product-cardigan" },
  { name: "Soft Navy Layering Shirt", retailer: "Harbor & Field", price: "$42", tier: "Under budget", imageUrl: "/demo/product-navy-shirt.svg", href: "#demo-product-shirt" },
  { name: "Textured Wool Overshirt", retailer: "Form & Found", price: "$118", tier: "Premium", imageUrl: "/demo/product-navy-overshirt.svg", href: "#demo-product-overshirt" },
] as const;

export const DEMO_SHARE_POST = {
  id: "demo",
  imageUrl: "/demo/tryon-result.png",
  caption: "A softer layer, a little more you.",
  hashtags: ["#ClosetAI", "#VirtualTryOn", "#NavyLayers"],
  crop: "portrait" as const,
  voiceCaption: "This one feels like me.",
  createdAt: Date.UTC(2026, 9, 24, 18, 0, 0),
};
