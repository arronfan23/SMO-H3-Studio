// @vitest-environment node

import { describe, expect, test } from 'vitest';
import {
  validatePrompt,
  type H3Mode,
} from '../../src/shared/prompt-contract';

function basePrompt(
  description = '[Shot 1] Live-action, a static shot holds on a quiet studio.',
  soundscape = 'Soft room tone continues throughout the video.',
  music = 'N/A',
): string {
  return [
    `integrated_multimodal_description: ${description}`,
    `overall_soundscape: ${soundscape}`,
    `non_diegetic_music: ${music}`,
  ].join('\n\n');
}

function refPrompt(
  description = '[Shot 1] Live-action, <Subject 1> sits still in a quiet studio.',
  soundscape = 'Soft room tone continues throughout the video.',
  music = 'N/A',
): string {
  return [
    'subject_definitions:\n<Subject 1> is the presenter in <Picture 1>.',
    'summary:\n[reference generation] The target video shows <Subject 1> in a studio.',
    'retention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - identity is retained.',
    `detailed_description:\n${description}`,
    `overall_soundscape: ${soundscape}`,
    `non_diegetic_music: ${music}`,
  ].join('\n\n');
}

function joinedIssues(text: string, mode: H3Mode, duration = 12, original = ''): string {
  return validatePrompt(text, mode, duration, original).join('\n');
}

describe('H3 required fields and official starting formats', () => {
  test('accepts Ref2VA fields in their required order', () => {
    expect(validatePrompt(refPrompt(), 'ref2va', 12)).toEqual([]);
  });

  test('accepts base fields in their required order', () => {
    expect(validatePrompt(basePrompt(), 't2va', 12)).toEqual([]);
  });

  test('reports every missing Ref2VA field', () => {
    const issues = joinedIssues('summary: x', 'ref2va');

    expect(issues).toContain('Missing required fields:');
    expect(issues).toContain('subject_definitions:');
    expect(issues).toContain('retention_analysis:');
    expect(issues).toContain('detailed_description:');
    expect(issues).toContain('overall_soundscape:');
    expect(issues).toContain('non_diegetic_music:');
  });

  test('reports a missing base field', () => {
    expect(
      joinedIssues('overall_soundscape: N/A\nnon_diegetic_music: N/A', 't2va'),
    ).toContain('integrated_multimodal_description:');
  });

  test.each([
    {
      mode: 'ref2va' as const,
      text: refPrompt().replace('subject_definitions:', 'summary:').replace('summary:\n[reference', 'subject_definitions:\n[reference'),
    },
    {
      mode: 't2va' as const,
      text: [
        'integrated_multimodal_description: [Shot 1] A static studio shot.',
        'non_diegetic_music: N/A',
        'overall_soundscape: Soft room tone.',
      ].join('\n\n'),
    },
  ])('rejects $mode fields outside the official order', ({ mode, text }) => {
    expect(joinedIssues(text, mode)).toContain('Required fields are not in the official order');
  });

  test.each([
    { mode: 't2va' as const, text: basePrompt() },
    { mode: 'ref2va' as const, text: refPrompt() },
    {
      mode: 'i2va' as const,
      text: `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n${basePrompt()}`,
    },
    {
      mode: 'fl2va' as const,
      text: `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark; Picture 2 (from Shot 1) aligns with the 12.00-second mark.\n\n${basePrompt()}`,
    },
    {
      mode: 'l2va' as const,
      text: `How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the 12.00-second mark.\n\n${basePrompt()}`,
    },
  ])('accepts the official $mode starting format', ({ mode, text }) => {
    expect(validatePrompt(text, mode, 12)).toEqual([]);
  });

  test.each([
    { mode: 't2va' as const, prefix: 'Here is your prompt.\n\n', expected: /T2VA must begin directly/ },
    { mode: 'ref2va' as const, prefix: 'Final prompt:\n\n', expected: /REF2VA must begin directly/ },
    { mode: 'i2va' as const, prefix: '', expected: /I2VA must begin with the official first-frame instruction/ },
    { mode: 'fl2va' as const, prefix: '', expected: /FL2VA must begin with the official alignment instruction/ },
    { mode: 'l2va' as const, prefix: '', expected: /L2VA must begin with the official alignment instruction/ },
  ])('rejects an invalid $mode starting format', ({ mode, prefix, expected }) => {
    const body = mode === 'ref2va' ? refPrompt() : basePrompt();
    expect(joinedIssues(`${prefix}${body}`, mode)).toMatch(expected);
  });
});

describe('H3 timeline validation', () => {
  test.each([
    {
      scenario: 'equal timestamps',
      description: '[Shot 1] Wide shot. [Shot 2] At 00:03.000, cut closer. [Shot 3] At 00:03.000, cut to hands.',
    },
    {
      scenario: 'decreasing timestamps',
      description: '[Shot 1] Wide shot. [Shot 2] At 00:04.000, cut closer. [Shot 3] At 00:02.000, cut to hands.',
    },
  ])('rejects $scenario', ({ description }) => {
    expect(joinedIssues(basePrompt(description), 't2va')).toContain(
      'Shot timestamps must be strictly increasing',
    );
  });

  test.each(['00:12.000', '00:12.001'])('rejects timestamp %s at or beyond the duration', (timestamp) => {
    const text = basePrompt(`[Shot 1] Wide shot. [Shot 2] At ${timestamp}, cut closer.`);
    expect(joinedIssues(text, 't2va', 12)).toMatch(/must be earlier than 12\.00s/);
  });

  test('accepts strictly increasing timestamps within the duration', () => {
    const text = basePrompt(
      '[Shot 1] Wide shot. [Shot 2] At 00:03.000, cut closer. [Shot 3] At 00:07.250, cut to hands.',
    );
    expect(validatePrompt(text, 't2va', 12)).toEqual([]);
  });
});

describe('H3 dialogue, wrappers, and narration tail', () => {
  const dialogue = '<d>[Chinese]  你好，世界！\n第二行  </d>';
  const original = `Presenter narration: ${dialogue}`;
  const tail = 'The final 2 seconds contain no narration or dialogue; only ambient sound and picture remain.';

  test('preserves original dialogue blocks byte for byte', () => {
    const text = basePrompt(`[Shot 1] The presenter (S1) says: ${dialogue} ${tail}`);
    expect(validatePrompt(text, 't2va', 12, original)).toEqual([]);
  });

  test('reports any change inside an original dialogue block', () => {
    const changed = dialogue.replace('你好，世界！', '你好世界!');
    const text = basePrompt(`[Shot 1] The presenter (S1) says: ${changed} ${tail}`);
    expect(joinedIssues(text, 't2va', 12, original)).toContain('Dialogue was modified');
  });

  test('reports a missing narration tail when dialogue is present', () => {
    const text = basePrompt(`[Shot 1] The presenter (S1) says: ${dialogue}`);
    expect(joinedIssues(text, 't2va', 12, original)).toContain('Missing narration tail');
  });

  test('requires the final two seconds to be explicitly non-narrated', () => {
    const text = basePrompt(
      `[Shot 1] The presenter (S1) says: ${dialogue} The final 2 seconds are shown.`,
    );
    expect(joinedIssues(text, 't2va', 12, original)).toContain('Missing narration tail');
  });

  test('accepts a last-two-seconds narration tail', () => {
    const text = basePrompt(
      `[Shot 1] The presenter (S1) says: ${dialogue} All speech stops before the last two seconds, which retain only music and visuals.`,
    );
    expect(validatePrompt(text, 't2va', 12, original)).toEqual([]);
  });

  test('rejects Markdown fences', () => {
    expect(joinedIssues(`\`\`\`text\n${basePrompt()}\n\`\`\``, 't2va')).toContain(
      'Remove Markdown code fences',
    );
  });

  test.each([
    'Please confirm before generation.',
    'Would you like a different ending?',
    '请确认后继续生成。',
    '## Next steps\nUpload a reference image.',
  ])('rejects interactive output: %s', (interaction) => {
    expect(joinedIssues(basePrompt(`[Shot 1] A studio shot. ${interaction}`), 't2va')).toContain(
      'Remove all questions, clarifications, confirmations, approval gates, and next-step requests',
    );
  });

  test('rejects an open question appended after an otherwise valid prompt', () => {
    const text = `${basePrompt()}\n\nWhat is the preferred ending?`;
    expect(joinedIssues(text, 't2va')).toContain(
      'Remove all questions, clarifications, confirmations, approval gates, and next-step requests',
    );
  });

  test.each([
    'Explanation: This prompt uses a static camera.',
    'Analysis: The shot is intentionally restrained.',
    'Notes: This is an explanatory note.',
    'Preface: This is extra context.',
    'Epilogue: This is extra commentary.',
  ])('rejects an explanatory section appended after a valid prompt: %s', (suffix) => {
    expect(joinedIssues(`${basePrompt()}\n\n${suffix}`, 't2va')).toContain(
      'Remove explanations',
    );
  });

  test('ignores questions inside preserved dialogue and visible scene text', () => {
    const originalDialogue = '<d>[English] Why?</d>';
    const text = basePrompt(
      `[Shot 1] A sign reads "Can you hear me?" The presenter (S1) says: ${originalDialogue} ${tail}`,
    );
    expect(validatePrompt(text, 't2va', 12, originalDialogue)).toEqual([]);
  });
});

describe('H3 complete-silence requests', () => {
  const silenceRequest = '完全静音，不要任何声音。';

  test('accepts N/A for both audio sections and no audible events', () => {
    const text = basePrompt(
      '[Shot 1] A static shot holds on an empty room with no audible activity.',
      'N/A',
      'N/A',
    );
    expect(validatePrompt(text, 't2va', 12, silenceRequest)).toEqual([]);
  });

  test.each([
    { soundscape: 'Soft room tone.', music: 'N/A' },
    { soundscape: 'N/A', music: 'Sparse piano.' },
  ])('requires both audio sections to be N/A', ({ soundscape, music }) => {
    const text = basePrompt('[Shot 1] A static empty room.', soundscape, music);
    expect(joinedIssues(text, 't2va', 12, silenceRequest)).toContain(
      'Complete silence was requested: set both overall_soundscape and non_diegetic_music exactly to N/A',
    );
  });

  test.each([
    '[Shot 1] A door slams loudly.',
    '[Shot 1] The presenter (S1) says: <d>[English] Hello.</d>',
    '[Shot 1] Footsteps echo across the room.',
  ])('rejects audible events elsewhere under complete silence', (description) => {
    const text = basePrompt(description, 'N/A', 'N/A');
    expect(joinedIssues(text, 't2va', 12, silenceRequest)).toContain(
      'Complete silence was requested: remove all audible events',
    );
  });

  test('does not treat a no-background-music request as complete silence', () => {
    expect(validatePrompt(basePrompt(), 't2va', 12, 'No background music.')).toEqual([]);
  });

  test('treats No sound. as complete silence and rejects wind and music', () => {
    const text = basePrompt(
      '[Shot 1] Wind howls loudly while soft music plays.',
      'N/A',
      'N/A',
    );
    expect(joinedIssues(text, 't2va', 12, 'No sound.')).toContain(
      'Complete silence was requested: remove all audible events',
    );
  });

  test.each([
    '[Shot 1] Wind howls loudly across the field.',
    '[Shot 1] The singer performs a song.',
    '[Shot 1] Ambient room tone fills the studio.',
    '[Shot 1] Soft piano music.',
  ])('rejects additional audible expression under complete silence: %s', (description) => {
    const text = basePrompt(description, 'N/A', 'N/A');
    expect(joinedIssues(text, 't2va', 12, silenceRequest)).toContain(
      'Complete silence was requested: remove all audible events',
    );
  });
});
