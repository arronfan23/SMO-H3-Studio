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

  test('insets the main-content scrollbar clear of the east resize hot zone', async () => {
    const css = await readFile(stylesUrl, 'utf8');

    const frameRule = css.match(/\.app-frame\s*\{([^}]*)\}/)?.[1];
    expect(frameRule).toBeDefined();
    expect(frameRule).toContain('overflow: hidden');

    const eastRule = css.match(/\.window-resize-e\s*\{([^}]*)\}/)?.[1];
    expect(eastRule).toBeDefined();
    expect(eastRule).toContain('right: 0');
    const eastWidth = Number(eastRule!.match(/width:\s*(\d+)px/)?.[1]);
    expect(eastWidth).toBeGreaterThanOrEqual(8);

    // The main-content right edge (where its scrollbar lives) must sit at
    // least the hot-zone width inside the app frame, so an east/west resize
    // drag never covers scrolling and no horizontal overflow appears.
    const mainRule = css.match(/\.main-content\s*\{([^}]*)\}/)?.[1];
    expect(mainRule).toBeDefined();
    const inset = Number(mainRule!.match(/margin-right:\s*(\d+)px/)?.[1]);
    expect(inset).toBeGreaterThanOrEqual(eastWidth);
  });
});
