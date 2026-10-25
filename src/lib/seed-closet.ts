export type SeedClosetItem = {
  id: string;
  name: string;
  category: string;
  color: string;
  silhouette: string;
  formality: string;
  fit: string;
  file: string;
};

/** Local transparent cutouts used to seed the signed-in demo account. */
export const seedCloset: SeedClosetItem[] = [
  { id: "demo-navy-jacket", name: "Navy Weekend Jacket", category: "outerwear", color: "navy", silhouette: "relaxed", formality: "everyday", fit: "relaxed", file: "navy-jacket.png" },
  { id: "demo-navy-cardigan", name: "Navy Knit Cardigan", category: "top", color: "navy", silhouette: "soft", formality: "everyday", fit: "relaxed", file: "navy-cardigan.png" },
  { id: "demo-navy-overshirt", name: "Navy Overshirt", category: "top", color: "navy", silhouette: "straight", formality: "casual", fit: "relaxed", file: "navy-overshirt.png" },
  { id: "demo-navy-shirt", name: "Navy Cotton Shirt", category: "top", color: "navy", silhouette: "classic", formality: "smart casual", fit: "regular", file: "navy-shirt.png" },
];
