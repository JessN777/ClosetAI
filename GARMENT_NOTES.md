# Garment cleanup notes

## Model

The upload cleanup uses server-side Replicate **sprited/birefnet**, `general` variant, pinned to `21f2c4a9159af128ab9b9126401eebe7f8c5310841ed628b74a4c462df00da67` in `tryon.config.json`. It returns the raw mask, which the server cleans and applies to the original RGB pixels. This keeps segmentation on the server and avoids color-threshold removal.

Closet uploads use the same `/api/tryon/preprocess` route before they can be saved. Only a network or server-side failure activates the browser’s border-connected white flood-fill fallback, which is explicitly labeled **Approximate fallback** in the review. Input and mask validation failures keep their specific rejection message instead of falling back.

## Evaluation status

**Pass rate: N/A; live evaluation has not run.** The repository now includes six generated photo fixtures under `tests/fixtures/garments/` and a live runner, `npm run eval:garment-fixtures`, that writes masks, cutouts, a contact sheet, and a report into `tests/garment-eval/`. It still requires `REPLICATE_API_TOKEN`, so the model pass rate has not been measured. `tests/garment-eval/manifest.json` remains the separate expanded set of ten user-owned or licensed images; `scripts/evaluate-garments.ts` writes masks, transparent cutouts, person overlays, a contact sheet, and a JSON report under `tests/garment-eval/results/` when those images and the token are provided.

To run it, add the ten images listed in `tests/garment-eval/manifest.json` to `tests/garment-eval/inputs/`, set `REPLICATE_API_TOKEN` in the server environment, then run:

```sh
npx tsx scripts/evaluate-garments.ts
```

The report counts a pass only when cleanup succeeds without a multiple-object warning. A warning is reported separately as `review`; a rejected mask is a failure. This is an automated mask/input check and still needs a human review of the contact sheet.

## Known failure cases

- A hand, hanger, or mannequin connected to the clothing in the model mask can remain part of the largest component. The review lets the user erase visible leftovers; otherwise retake against a simpler background.
- Multiple disconnected large objects are reduced to the largest component and flagged. A garment whose useful part is split into disconnected sections can need a retake.
- A garment touching the image boundary is rejected as potentially cropped. Small garments and masks covering most of the image are also rejected.
- Fine lace, transparent fabric, fringes, and low-contrast edges can be softened or lost by a one-pixel erosion. Review the edge before accepting.
- The live demo uses cached transparent PNG cutouts from `public/demo/cutouts/`, so it does not depend on Replicate during the stage demo.
