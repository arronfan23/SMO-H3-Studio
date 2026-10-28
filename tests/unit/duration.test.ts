import { describe, expect, test } from 'vitest';
import { estimateNarrationDuration } from '../../src/shared/duration';

describe('estimateNarrationDuration', () => {
  test.each([
    ['你好世界', 4],
    ['这是九个汉字呀测试', 4.5],
    ['one two three four five six seven eight nine ten', 6],
    ['!!!! ....', 8],
    ['汉'.repeat(100), 15],
  ])('estimates %s as %s seconds', (text, expected) => {
    expect(estimateNarrationDuration(text)).toBe(expected);
  });

  test('adds Chinese and English speaking time together', () => {
    expect(estimateNarrationDuration('你好 one two')).toBe(4);
  });
});
