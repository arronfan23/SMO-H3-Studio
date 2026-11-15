import {
  RESOLUTION_OPTIONS,
  type ResolutionMegapixels,
} from './generation-options';

export type ImageResolutionMegapixels = ResolutionMegapixels | 2 | 4;

export interface ImageResolutionOption {
  value: ImageResolutionMegapixels;
  label: string;
}

export const IMAGE_RESOLUTION_OPTIONS: readonly ImageResolutionOption[] = [
  ...RESOLUTION_OPTIONS,
  { value: 2, label: '2.0MP（高负载，未实测）' },
  { value: 4, label: '4.0MP（高负载，未实测）' },
];

export const DEFAULT_IMAGE_RESOLUTION_MP: ImageResolutionMegapixels = 1;

export const DEFAULT_IMAGE_OPTIONS = {
  width: 1024,
  height: 1024,
  seed: 42,
  steps: 25,
} as const;
