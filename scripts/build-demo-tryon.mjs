import { readFile } from "node:fs/promises";
import sharp from "sharp";

const personSvg = await readFile("public/demo/person.svg");
const person = await sharp(personSvg).png().toBuffer();
await sharp(person).toFile("public/demo/person.png");
await sharp(await readFile("public/demo/navy-jacket.svg")).resize(640, 800).png().toFile("public/demo/navy-jacket.png");

const shirt = "M323 267q61-36 122 0l61 41 64 167-68 24-37-97 10 205H293l10-205-37 97-68-24 64-167Z";
const looks = [
  ["public/demo/tryon-result.png", "#334b58"],
  ["public/demo/tryon-navy-shirt.png", "#53697a"],
  ["public/demo/tryon-navy-overshirt.png", "#243f4e"],
  ["public/demo/tryon-navy-cardigan.png", "#2c4552"],
];

for (const [file, color] of looks) {
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024"><path d="${shirt}" fill="${color}"/></svg>`);
  await sharp(person).composite([{ input: await sharp(overlay).png().toBuffer() }]).png().toFile(file);
}
console.log("Wrote demo person, jacket, and cached try-on images.");
