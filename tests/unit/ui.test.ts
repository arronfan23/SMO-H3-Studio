// @vitest-environment node

import { describe, expect, test } from 'vitest';
import { parentPath } from '../../src/renderer/ui';

describe('parentPath', () => {
  test('returns the parent of a file path', () => {
    expect(parentPath('G:\\output\\video.mp4')).toBe('G:\\output');
    expect(parentPath('C:/Users/test/video.mp4')).toBe('C:/Users/test');
  });

  test('returns the same directory path unchanged', () => {
    expect(parentPath('G:\\output')).toBe('G:\\output');
    expect(parentPath('C:/Users/test')).toBe('C:/Users/test');
  });

  test('returns an empty path unchanged', () => {
    expect(parentPath('')).toBe('');
  });

  test('returns a path without separators unchanged', () => {
    expect(parentPath('filename.mp4')).toBe('filename.mp4');
  });

  test('returns a root directory unchanged', () => {
    expect(parentPath('G:\\')).toBe('G:\\');
    expect(parentPath('G:\\file.mp4')).toBe('G:\\');
  });

  test('handles mixed separators', () => {
    expect(parentPath('G:/output\\sub\\video.mp4')).toBe('G:/output\\sub');
  });
});
