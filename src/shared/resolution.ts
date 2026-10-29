import type { AspectRatio } from './generation-options';

export interface H3Resolution {
  width: number;
  height: number;
}

const ASPECT_RATIO_DIMENSIONS: Record<
  AspectRatio,
  { widthRatio: number; heightRatio: number }
> = {
  '1:1 (Square)': { widthRatio: 1, heightRatio: 1 },
  '2:3 (Portrait Photo)': { widthRatio: 2, heightRatio: 3 },
  '3:2 (Photo)': { widthRatio: 3, heightRatio: 2 },
  '3:4 (Portrait Standard)': { widthRatio: 3, heightRatio: 4 },
  '4:3 (Standard)': { widthRatio: 4, heightRatio: 3 },
  '9:16 (Portrait Widescreen)': { widthRatio: 9, heightRatio: 16 },
  '16:9 (Widescreen)': { widthRatio: 16, heightRatio: 9 },
  '21:9 (Ultrawide)': { widthRatio: 21, heightRatio: 9 },
};

/** Mirrors Python's round(): halves go to the nearest even integer. */
export function pythonRoundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Matches the H3 ResolutionSelector node's pixel math (multiple-of-32 grid). */
export function resolveH3Resolution(
  aspectRatio: AspectRatio,
  megapixels: number,
  multiple = 32,
): H3Resolution {
  if (!Number.isFinite(megapixels) || megapixels <= 0) {
    throw new RangeError('megapixels must be a finite positive number');
  }
  if (!Number.isInteger(multiple) || multiple <= 0) {
    throw new RangeError('multiple must be a positive integer');
  }

  const { widthRatio, heightRatio } = ASPECT_RATIO_DIMENSIONS[aspectRatio];
  const totalPixels = megapixels * 1024 * 1024;
  const scale = Math.sqrt(totalPixels / (widthRatio * heightRatio));

  return {
    width: pythonRoundHalfEven((widthRatio * scale) / multiple) * multiple,
    height: pythonRoundHalfEven((heightRatio * scale) / multiple) * multiple,
  };
}
