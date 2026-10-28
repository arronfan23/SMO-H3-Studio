// @vitest-environment node

import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const stylesUrl = new URL('../../src/renderer/styles.css', import.meta.url);

describe('responsive studio CSS contracts', () => {
  test('keeps the application scrollable below 640px viewport height', async () => {
    const css = await readFile(stylesUrl, 'utf8');
    const mediaIndex = css.indexOf('@media (max-height: 639px)');

    expect(mediaIndex).toBeGreaterThanOrEqual(0);
    const smallHeightRules = css.slice(mediaIndex);
    expect(smallHeightRules).toMatch(/body\s*\{[^}]*overflow:\s*auto/);
    expect(smallHeightRules).toMatch(
      /\.app-shell\s*\{[^}]*height:\s*auto;[^}]*overflow:\s*visible/,
    );
    expect(smallHeightRules).toMatch(/\.main-content\s*\{[^}]*overflow:\s*visible/);
  });

  test('allows long button labels to wrap inside their containers', async () => {
    const css = await readFile(stylesUrl, 'utf8');
    const buttonRule = css.match(/\.button\s*\{([^}]*)\}/)?.[1];

    expect(buttonRule).toBeDefined();
    expect(buttonRule).toContain('min-width: 0');
    expect(buttonRule).toContain('max-width: 100%');
    expect(buttonRule).toContain('white-space: normal');
    expect(buttonRule).toContain('overflow-wrap: anywhere');
  });

  test('keeps large media previews on the panel radius token', async () => {
    const css = await readFile(stylesUrl, 'utf8');
    const mediaRule = css.match(
      /\.work-item video,\s*\.video-placeholder\s*\{([^}]*)\}/,
    )?.[1];

    expect(mediaRule).toBeDefined();
    expect(mediaRule).toContain('border-radius: var(--radius-panel)');
    expect(mediaRule).not.toContain('var(--radius-control)');
  });
});
