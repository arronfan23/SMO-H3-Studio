import { describe, expect, test } from 'vitest';
import {
  pythonRoundHalfEven,
  resolveH3Resolution,
} from '../../src/shared/resolution';

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
  test('resolves 16:9 widescreen outputs across megapixel tiers', () => {
    expect(resolveH3Resolution('16:9 (Widescreen)', 0.4)).toEqual({
      width: 864,
      height: 480,
    });
    expect(resolveH3Resolution('16:9 (Widescreen)', 0.7)).toEqual({
      width: 1152,
      height: 640,
    });
    expect(resolveH3Resolution('16:9 (Widescreen)', 1)).toEqual({
      width: 1376,
      height: 768,
    });
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
