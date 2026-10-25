# Garment cleanup evaluation inputs

The six generated photos in `tests/fixtures/garments/` are a runnable fixture set covering hanger, busy flat lay, mannequin, hands, intentional edge cutoff, and patterned garment cases. Run `npm run eval:garment-fixtures` with `REPLICATE_API_TOKEN` set. It writes full-frame masks to `masks/`, transparent cutouts to `cutouts/`, plus `fixture-contact-sheet.png` and `fixture-report.json` in this directory. Rejected inputs appear as errors in the report and as blank mask/cutout tiles in the contact sheet.

The ten-photo manifest below remains a separate expanded evaluation set for user-owned or licensed photos.

Put ten owned or properly licensed JPEG, PNG, or WebP garment photos at the file paths in `manifest.json`. The set should cover hangers, flat lays, worn garments, mirror selfies, busy rooms, and patterned pieces. Keep each source below 8 MB, no larger than 4096 pixels per side, and at least 512 pixels on its short side. Include one intentionally cropped image if you want to verify the edge rejection.

Run `npx tsx scripts/evaluate-garments.ts` with `REPLICATE_API_TOKEN` set in the server environment. The runner calls the pinned BiRefNet version from Node, then writes full masks, alpha cutouts, overlays on `public/demo/person.png`, a before/after contact sheet, and a JSON report into `results/`.

The repository does not include private wardrobe photos, and the current workspace has no Replicate token. The existing try-on fixtures are generated illustrations and are not a substitute for real upload photos, so they are not counted as a segmentation pass-rate set.
