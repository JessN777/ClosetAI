import config from "../../tryon.config.json";

export type TryOnModelConfig = {
  label: string;
  version: string;
  checkedOn: string;
  source: string;
  personWidth: number;
  personHeight: number;
  expectsDensePose: boolean;
  personField: string;
  garmentField: string;
  maskField: string;
  descriptionField?: string;
  extra: Record<string, string | number | boolean>;
};

type TryOnConfig = {
  defaultModel: string;
  displayMinSide: number;
  garmentMinShortSide: number;
  models: Record<string, TryOnModelConfig>;
  parsing: {
    label: string;
    version: string;
    imageField: string;
    promptField: string;
    bodyPrompt: string;
    clothingPrompt: string;
  };
  upscale: {
    label: string;
    version: string;
    imageField: string;
    scaleField: string;
    scale: number;
    faceEnhanceField: string;
    faceEnhance: boolean;
  };
};

const tryOnConfig = config as TryOnConfig;

export function tryOnSettings() {
  const selected = process.env.TRYON_MODEL?.trim() || tryOnConfig.defaultModel;
  const model = tryOnConfig.models[selected];
  if (!model) {
    throw new Error(`Unknown try-on model "${selected}". Set TRYON_MODEL to one of: ${Object.keys(tryOnConfig.models).join(", ")}.`);
  }
  return { ...tryOnConfig, selected, model };
}
