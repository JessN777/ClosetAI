# Try-on notes

Versions were read from the public Replicate model pages on 2026-10-25 and stored in `tryon.config.json`. Change that file, or set `TRYON_MODEL`, to switch models. The route does not hard-code a version.

| Role | Model | Version |
| --- | --- | --- |
| Default try-on | IDM-VTON (`cuuupid/idm-vton`) | `0513734a452173b8173e907e3a59d19a36266e55b48528559432bd21c7d7e985` |
| Alternate try-on | OOTDiffusion with mask (`viktorfa/oot_diffusion_with_mask`) | `c890e02d8180bde7eeed1a138217ee154d8cdd8769a29f02bd51fea33d268385` |
| Body and clothing masks | Grounded SAM (`schananas/grounded_sam`) | `ee871c19efb1941f55f66a3d7d960428c8a5afcb77449547fe8e5a3ab9ebc21c` |
| Upscale | Real-ESRGAN (`nightmareai/real-esrgan`) | `b3ef194191d13140337468c916c2c5b96dd0cb06dffc032a022a31807f6a5ea8` |

Set `TRYON_MODEL=oot-diffusion` to use the alternate. IDM-VTON is the default. Its API fields are `human_img`, `garm_img`, `mask_img`, and `garment_des`. OOTDiffusion uses `model_image`, `garment_image`, and `person_mask`. Neither model accepts a DensePose image, so the job stores keypoints taken from the clothing-mask bounds instead of a DensePose map.

## What each path does

The high-quality path pads the person to the model size without cropping, rejects garment photos under 512 pixels on the short side, removes the garment background onto a flat gray backdrop, and sends the Grounded SAM clothing mask. After the diffusion result returns, a short-side below 1024 pixels is upscaled with Real-ESRGAN and the color is nudged toward the original garment. Those input URLs and the mask URLs are saved on the Redis job as `prep`.

The live view stays a MediaPipe preview. It is labeled **Live preview**. The diffusion result is labeled **High-quality render**, and only **Take high-quality look** calls `/api/tryon`. The overlay is clipped to a torso outline, warped as a shoulder/torso/hem mesh, smoothed with a One Euro filter, given a soft edge shadow and a slight brightness match, and faded in when the garment changes.

## Demo

With `DEMO_OFFLINE=1`, `/api/tryon` does not call Replicate. It returns a cached image for the demo garment: `/demo/tryon-result.png` for the navy jacket, and matching cached images for the shirt, overshirt, and cardigan. The offline wardrobe photos are `/demo/person.png` and `/demo/navy-jacket.png`.

## Known failures

- Long sleeves on a short-sleeve photo still invent or clip sleeve length. The mask follows the clothes that are already in the photo.
- Crossed arms and side-on poses produce a thin or broken clothing mask, and the live torso clip looks pinched.
- Busy backgrounds and garments close to skin color make Grounded SAM drop the mask. The job fails instead of substituting a box.
- A white garment on the gray backdrop can be flattened by background removal. Use a product photo with a clear edge.
- Real-ESRGAN adds sharpness but does not repair a bad garment alignment.

## What to try next

Pin a try-on model that accepts a DensePose image, and pass that map through instead of mask-bound keypoints. Compare the five-by-five set in `tests/tryon-eval/` after `npx tsx scripts/tryon-eval.ts`. The script saves the live-preview composites and the padded diffusion inputs locally. It does not call Replicate. The server job is the diffusion path.
