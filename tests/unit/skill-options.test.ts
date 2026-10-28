import { describe, expect, test } from 'vitest';
import { SKILL_NAMES } from '../../src/shared/skills';
import {
  AUTO_SKILL_OPTION,
  SKILL_OPTIONS,
} from '../../src/renderer/skill-options';

describe('skill options', () => {
  test('covers every skill exactly once', () => {
    expect(Object.keys(SKILL_OPTIONS).sort()).toEqual([...SKILL_NAMES].sort());
  });

  test.each(SKILL_NAMES)('%s has a Chinese title and description', (name) => {
    const option = SKILL_OPTIONS[name];
    expect(option).toBeDefined();
    expect(option.title.length).toBeGreaterThan(0);
    expect(option.description.length).toBeGreaterThan(0);
    expect(option.title).not.toMatch(/[a-z]+-[a-z]+/);
    expect(option.description).not.toContain(name);
  });

  test('auto option recommends itself in Chinese with a one-line note', () => {
    expect(AUTO_SKILL_OPTION.title).toBe('自动选择（推荐）');
    expect(AUTO_SKILL_OPTION.description.length).toBeGreaterThan(0);
  });
});
