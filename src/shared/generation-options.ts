import type { HardwareProfile } from './types';

export const DEFAULT_MODEL_DIRECTORY =
  'G:\\H3Selflift整合包\\模型部分\\diffusion_models';

export type AspectRatio =
  | '1:1 (Square)'
  | '2:3 (Portrait Photo)'
  | '3:2 (Photo)'
  | '3:4 (Portrait Standard)'
  | '4:3 (Standard)'
  | '9:16 (Portrait Widescreen)'
  | '16:9 (Widescreen)'
  | '21:9 (Ultrawide)';

export interface AspectRatioOption {
  value: AspectRatio;
  label: string;
}

export const ASPECT_RATIO_OPTIONS: readonly AspectRatioOption[] = [
  { value: '1:1 (Square)', label: '1:1 方形（Square）' },
  { value: '2:3 (Portrait Photo)', label: '2:3 人像照片（Portrait Photo）' },
  { value: '3:2 (Photo)', label: '3:2 照片（Photo）' },
  { value: '3:4 (Portrait Standard)', label: '3:4 人像标准（Portrait Standard）' },
  { value: '4:3 (Standard)', label: '4:3 标准（Standard）' },
  { value: '9:16 (Portrait Widescreen)', label: '9:16 竖屏宽屏（Portrait Widescreen）' },
  { value: '16:9 (Widescreen)', label: '16:9 宽屏（Widescreen）' },
  { value: '21:9 (Ultrawide)', label: '21:9 超宽（Ultrawide）' },
];

export const DEFAULT_ASPECT_RATIO: AspectRatio = '16:9 (Widescreen)';

export type ResolutionMegapixels = 0.3 | 0.4 | 0.55 | 0.7 | 0.85 | 1 | 1.2;

export interface ResolutionOption {
  value: ResolutionMegapixels;
  label: string;
}

export const RESOLUTION_OPTIONS: readonly ResolutionOption[] = [
  { value: 0.3, label: '0.3MP（轻量）' },
  { value: 0.4, label: '0.4MP（流畅）' },
  { value: 0.55, label: '0.55MP（均衡）' },
  { value: 0.7, label: '0.7MP（标准，默认）' },
  { value: 0.85, label: '0.85MP（高负载，未实测）' },
  { value: 1, label: '1.0MP（高负载，未实测）' },
  { value: 1.2, label: '1.2MP（高负载，未实测）' },
];

export const DEFAULT_RESOLUTION_MP: ResolutionMegapixels = 0.7;

export type H3ModelOption = 'int8' | 'bf16';

export interface H3ModelChoice {
  value: H3ModelOption;
  label: string;
}

export const H3_MODEL_OPTIONS: readonly H3ModelChoice[] = [
  { value: 'int8', label: 'INT8（16GB 推荐）' },
  { value: 'bf16', label: 'BF16 大显存候选，未实测' },
];

export const DEFAULT_H3_MODEL: H3ModelOption = 'int8';

export interface GenerationOptionsValue {
  model: H3ModelOption;
  aspectRatio: AspectRatio;
  megapixels: ResolutionMegapixels;
}

export const DEFAULT_GENERATION_OPTIONS: GenerationOptionsValue = {
  model: DEFAULT_H3_MODEL,
  aspectRatio: DEFAULT_ASPECT_RATIO,
  megapixels: DEFAULT_RESOLUTION_MP,
};

export function buildHardwareProfile(
  options: Pick<GenerationOptionsValue, 'model' | 'aspectRatio' | 'megapixels'>,
): HardwareProfile {
  if (options.model === 'bf16') {
    return {
      preset: 'high-memory-candidate',
      modelPolicy: 'bf16-if-present',
      megapixels: options.megapixels,
      aspectRatio: options.aspectRatio,
      lowvram: false,
      tiling: 'auto',
      requiresConfirmation: true,
    };
  }

  return {
    preset: 'balanced-16gb',
    modelPolicy: 'int8',
    megapixels: options.megapixels,
    aspectRatio: options.aspectRatio,
    lowvram: true,
    tiling: 'auto',
    requiresConfirmation: true,
  };
}
