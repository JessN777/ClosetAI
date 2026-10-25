import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const demoState = "closetai-demo-wardrobe-v1";
const entries = [
  {
    utterance: "I'm looking for this shirt.",
    reply: "I found navy layers that fit your everyday style and budget.",
    toolCalls: [{ id: "demo-search-shirt", name: "search_shopping", arguments: JSON.stringify({ query: "navy shirt" }) }],
  },
  {
    utterance: "Actually, show me a navy option.",
    reply: "Here are three cached navy pieces that work with your closet.",
    toolCalls: [{ id: "demo-search-navy", name: "search_shopping", arguments: JSON.stringify({ query: "navy casual layer" }) }],
    thinkingDelayMs: 1400,
  },
  {
    utterance: "Find something that looks good on me.",
    reply: "Your reference style points to relaxed navy layers. Here is a look using pieces from your closet.",
    toolCalls: [{ id: "demo-style-match", name: "suggest_outfit", arguments: JSON.stringify({ occasion: "everyday", styleNotes: "relaxed navy layers, clean minimal style" }) }],
  },
  {
    utterance: "Remember I prefer navy.",
    reply: "Got it. I saved navy as your favorite color.",
    toolCalls: [{ id: "demo-remember-navy", name: "remember_preference", arguments: JSON.stringify({ category: "favoriteColors", value: "navy" }) }],
  },
  {
    utterance: "Dress like quiet luxury.",
    reply: "Quiet luxury is relaxed, understated tailoring with a restrained neutral palette. I found one piece you own and three opportunities to complete the look.",
    toolCalls: [{ id: "demo-dress-like", name: "dress_like", arguments: JSON.stringify({ lookName: "Quiet luxury" }) }],
  },
  {
    utterance: "Shop the quiet luxury look.",
    reply: "I found four pieces, your closet has a close jacket match, and three pieces have retailer options. The value estimate is about $136. Nothing was purchased.",
    toolCalls: [{ id: "demo-shop-the-look", name: "shop_the_look", arguments: JSON.stringify({ lookName: "Quiet luxury", occasion: "everyday" }) }],
  },
];

const cache = Object.fromEntries(entries.map((entry) => {
  const normalized = entry.utterance.trim().toLowerCase().replace(/\s+/g, " ");
  const key = createHash("sha256").update(`${normalized}\n${demoState}`).digest("hex");
  const response = { ...entry };
  delete response.utterance;
  return [key, response];
}));

await mkdir("public/demo", { recursive: true });
await writeFile("public/demo/voice-cache.json", `${JSON.stringify(cache, null, 2)}\n`, "utf8");
