import { describe, expect, test } from 'vitest';
import {
  DEFAULT_GENERATION_OPTIONS,
  DEFAULT_RESOLUTION_MP,
  RESOLUTION_OPTIONS,
} from '../../src/shared/generation-options';
import {
  pythonRoundHalfEven,
  resolveH3Resolution,
} from '../../src/shared/resolution';

describe('resolution options', () => {
  test('offers seven megapixel tiers with 0.7 MP as the default', () => {
    expect(RESOLUTION_OPTIONS.map((option) => option.value)).toEqual([
      0.3, 0.4, 0.55, 0.7, 0.85, 1, 1.2,
    ]);
    expect(DEFAULT_RESOLUTION_MP).toBe(0.7);
    expect(DEFAULT_GENERATION_OPTIONS).toEqual({
      model: 'int8',
      aspectRatio: '16:9 (Widescreen)',
      megapixels: 0.7,
    });
  });

  test('does not claim high-load tiers are verified', () => {
    const highLoadOptions = RESOLUTION_OPTIONS.filter((option) => option.value > 0.7);

    expect(highLoadOptions.map((option) => option.value)).toEqual([0.85, 1, 1.2]);
    for (const option of highLoadOptions) {
      expect(option.label).toContain('未实测');
      expect(option.label).not.toMatch(/已验证|已实测/);
    }
  });
});

describe('pythonRoundHalfEven', () => {
  test.each([
    [0.4, 0],
    [0.5, 0],
    [1.5, 2],
    [2.5, 2],
    [3.5, 4],
    [-0.5, 0],
    [-1.5, -2],
    [-2.5, -2],
    [20.08, 20],
    [35.7, 36],
  ])('rounds %s to %s with ties to even', (value, expected) => {
    expect(pythonRoundHalfEven(value)).toBe(expected);
  });
});

describe('resolveH3Resolution', () => {
  test.each([
    [0.3, { width: 736, height: 416 }],
    [0.4, { width: 864, height: 480 }],
    [0.55, { width: 1024, height: 576 }],
    [0.7, { width: 1152, height: 640 }],
    [0.85, { width: 1248, height: 704 }],
    [1, { width: 1376, height: 768 }],
    [1.2, { width: 1504, height: 832 }],
  ])('resolves 16:9 widescreen output at %s MP', (megapixels, expected) => {
    expect(resolveH3Resolution('16:9 (Widescreen)', megapixels)).toEqual(expected);
  });

  test('mirrors the resolution for portrait widescreen', () => {
    expect(resolveH3Resolution('9:16 (Portrait Widescreen)', 0.7)).toEqual({
      width: 640,
      height: 1152,
    });
  });

  test('aligns square output to a custom multiple', () => {
    expect(resolveH3Resolution('1:1 (Square)', 0.5, 16)).toEqual({
      width: 720,
      height: 720,
    });
  });

  test.each([0, -0.7, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid megapixels %s',
    (megapixels) => {
      expect(() =>
        resolveH3Resolution('16:9 (Widescreen)', megapixels),
      ).toThrow(RangeError);
    },
  );

  test.each([0, -32, 2.5, Number.NaN])(
    'rejects invalid multiple %s',
    (multiple) => {
      expect(() =>
        resolveH3Resolution('16:9 (Widescreen)', 0.7, multiple),
      ).toThrow(RangeError);
    },
  );
});
