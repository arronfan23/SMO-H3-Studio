// @vitest-environment node

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { LlmService, type LlmChatMessage } from '../../src/main/llm';
import {
  detectH3Mode,
  parseModeSelection,
  parseSkillSelection,
  PromptPolishError,
  SKILL_NAMES,
  skillInstructions,
  SkillsService,
  systemPrompt,
  type ChatCompletionClient,
  type PolishRequest,
  type SkillName,
} from '../../src/main/skills';
import type { LlmCredentials } from '../../src/shared/types';
import {
  startLlmUpstream,
  type LocalLlmUpstream,
} from '../fixtures/llm-upstream';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const skillsRoot = join(projectRoot, 'resources/skills');
const profile: LlmCredentials = {
  baseUrl: 'http://127.0.0.1:1/v1',
  apiKey: 'fake-key',
  model: 'fake-model',
};

const EXPECTED_REFERENCES: Record<SkillName, readonly string[]> = {
  '3d-animation-short-generator': [
    'references/fallback-policy.md',
    'references/model-selection.md',
    'references/qc-checklist.md',
    'references/shot-table-spec.md',
    'references/storyboard-guidelines.md',
  ],
  'brand-promo-video-generator': [],
  'co-op-game-intro-generator': [
    'references/h3-confirmation-image-template.md',
    'references/h3-video-prompt-template.md',
  ],
  'h3-prompt-writing': ['references/base-en.txt', 'references/ref-en.txt'],
  'handdrawn-live-video-generator': [],
  'minimalist-product-ad-generator': [],
  'music-video-subtitle-generator': [],
  'paper-collage-explainer-generator': [],
  'papercraft-stop-motion-explainer': [],
};

interface RecordedCall {
  messages: LlmChatMessage[];
  maxTokens: number;
}

class FakeChatCompletion implements ChatCompletionClient {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly responses: readonly string[]) {}

  async chatCompletion(
    _profile: LlmCredentials,
    messages: readonly LlmChatMessage[],
    maxTokens: number,
  ): Promise<string> {
    this.calls.push({
      messages: messages.map((message) => ({ ...message })),
      maxTokens,
    });
    const response = this.responses[this.calls.length - 1];
    if (response === undefined) {
      throw new Error(`Unexpected fake LLM call ${this.calls.length}`);
    }
    return response;
  }
}

function basePrompt(description = '[Shot 1] Live-action, a static shot holds on a quiet studio.'): string {
  return [
    `integrated_multimodal_description: ${description}`,
    'overall_soundscape: Soft room tone continues throughout the video.',
    'non_diegetic_music: N/A',
  ].join('\n\n');
}

function refPrompt(): string {
  return [
    'subject_definitions:\n<Subject 1> is the presenter identified by <Picture 1>.',
    'summary:\n[reference generation] The target video shows <Subject 1> in a quiet studio.',
    'retention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - the supplied identity is retained.',
    'detailed_description:\n[Shot 1] Live-action, <Subject 1> sits still in a quiet studio.',
    'overall_soundscape: Soft room tone continues throughout the video.',
    'non_diegetic_music: N/A',
  ].join('\n\n');
}

function readSnapshot(relativePath: string): string {
  return readFileSync(join(skillsRoot, relativePath), 'utf8');
}

const upstreams: LocalLlmUpstream[] = [];
const temporarySkillContainers: string[] = [];

function useTemporarySkillsRoot(): string {
  const container = mkdtempSync(join(tmpdir(), 'smo-h3-skills-'));
  const root = join(container, 'skills');
  cpSync(skillsRoot, root, { recursive: true });
  temporarySkillContainers.push(container);
  return root;
}

afterEach(async () => {
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
  for (const container of temporarySkillContainers.splice(0)) {
    if (
      dirname(container) !== tmpdir() ||
      !basename(container).startsWith('smo-h3-skills-')
    ) {
      throw new Error(`Refusing to clean unexpected test directory: ${container}`);
    }
    rmSync(container, { recursive: true, force: true });
  }
});

describe('official H3 skill snapshot', () => {
  test('contains exactly the general skill and eight style skills', () => {
    expect(SKILL_NAMES).toEqual([
      '3d-animation-short-generator',
      'brand-promo-video-generator',
      'co-op-game-intro-generator',
      'h3-prompt-writing',
      'handdrawn-live-video-generator',
      'minimalist-product-ad-generator',
      'music-video-subtitle-generator',
      'paper-collage-explainer-generator',
      'papercraft-stop-motion-explainer',
    ]);
  });

  test.each(SKILL_NAMES)('loads %s and its real reference files', (skill) => {
    const mode = skill === 'h3-prompt-writing' ? 'ref2va' : 't2va';
    const instructions = skillInstructions(skill, mode);
    const document = readSnapshot(`${skill}/SKILL.md`);

    expect(instructions).toContain(`# Official MiniMax Skill: ${skill}`);
    expect(instructions).toContain(document);
    for (const reference of EXPECTED_REFERENCES[skill]) {
      const path = join(skillsRoot, skill, reference);
      expect(existsSync(path), `${skill}/${reference} should exist`).toBe(true);
      if (skill !== 'h3-prompt-writing') {
        expect(instructions).toContain(readFileSync(path, 'utf8'));
      }
    }
  });

  test('selects the Ref2VA or base guide for the general skill', () => {
    const refInstructions = skillInstructions('h3-prompt-writing', 'ref2va');
    const baseInstructions = skillInstructions('h3-prompt-writing', 't2va');

    expect(refInstructions).toContain(readSnapshot('h3-prompt-writing/references/ref-en.txt'));
    expect(refInstructions).not.toContain('# Required reference: base-en.txt');
    expect(baseInstructions).toContain(readSnapshot('h3-prompt-writing/references/base-en.txt'));
    expect(baseInstructions).not.toContain('# Required reference: ref-en.txt');
  });

  test('rejects required content that exceeds the character budget', () => {
    expect(() => skillInstructions('h3-prompt-writing', 'ref2va', 100)).toThrow(
      /required content.*100 characters/i,
    );
  });

  test('caps both instructions and the complete Ref2VA system prompt at 72000 characters', () => {
    const instructions = skillInstructions('3d-animation-short-generator', 'ref2va');
    const prompt = systemPrompt('3d-animation-short-generator', 'ref2va', 8);

    expect(instructions.length).toBeLessThanOrEqual(72_000);
    expect(prompt.length).toBeLessThanOrEqual(72_000);
    expect(prompt).toContain('# Binding SMO single-pass output contract');
    for (const reference of EXPECTED_REFERENCES['3d-animation-short-generator']) {
      const heading = `# Official reference: ${reference}`;
      if (prompt.includes(heading)) {
        expect(prompt).toContain(
          readSnapshot(`3d-animation-short-generator/${reference}`),
        );
      }
    }
  });

  test.each([
    '3d-animation-short-generator/SKILL.md',
    '3d-animation-short-generator/references/qc-checklist.md',
  ])('falls back to the general Skill when %s cannot be read', (missingDocument) => {
    const root = useTemporarySkillsRoot();
    rmSync(join(root, missingDocument));

    const instructions = skillInstructions(
      '3d-animation-short-generator',
      'ref2va',
      72_000,
      root,
    );
    const prompt = systemPrompt('3d-animation-short-generator', 'ref2va', 8, root);

    for (const content of [instructions, prompt]) {
      expect(content).toContain('# Official MiniMax Skill: h3-prompt-writing');
      expect(content).not.toContain('# Official MiniMax Skill: 3d-animation-short-generator');
    }
  });

  test('throws when the general Skill itself cannot be read', () => {
    const root = useTemporarySkillsRoot();
    rmSync(join(root, 'h3-prompt-writing/SKILL.md'));

    expect(() =>
      skillInstructions('h3-prompt-writing', 'ref2va', 72_000, root),
    ).toThrow(/h3-prompt-writing/);
  });

  test('adds the required final H3 guide and single-pass SMO contract for styles', () => {
    const prompt = systemPrompt('brand-promo-video-generator', 'ref2va', 8);

    expect(prompt).toContain(readSnapshot('brand-promo-video-generator/SKILL.md'));
    expect(prompt).toContain('# Required final H3 prompt format: ref-en.txt');
    expect(prompt).toContain(readSnapshot('h3-prompt-writing/references/ref-en.txt'));
    expect(prompt).toContain('Never ask the user a question.');
    expect(prompt).toContain('Return the final prompt only');
    expect(prompt).toMatch(/final 2 seconds/i);
    expect(prompt).toMatch(/shorten/i);
    expect(prompt).not.toContain(skillsRoot);
    expect(prompt).not.toContain('H3Selflift整合包');
  });
});

describe('H3 mode and Skill routing', () => {
  test.each([
    { images: 0, videos: 0, expected: 't2va' },
    { images: 0, videos: 1, expected: 'ref2va' },
    { images: 3, videos: 0, expected: 'ref2va' },
    { images: 1, videos: 0, expected: null },
    { images: 2, videos: 0, expected: null },
  ])('detects $images images and $videos videos as $expected', ({ images, videos, expected }) => {
    expect(detectH3Mode(images, videos)).toBe(expected);
  });

  test('parses only image-appropriate modes and falls back to Ref2VA', () => {
    expect(parseModeSelection('I2VA.', 1)).toBe('i2va');
    expect(parseModeSelection('"fl2va"', 2)).toBe('fl2va');
    expect(parseModeSelection('i2va', 2)).toBe('ref2va');
    expect(parseModeSelection('unintelligible', 1)).toBe('ref2va');
  });

  test.each(['Do not use i2va', 'Use I2VA.', 'i2va please', 'The mode is i2va'])(
    'rejects a non-exact mode router response: %s',
    (response) => {
      expect(parseModeSelection(response, 1)).toBe('ref2va');
    },
  );

  test('falls back to the general Skill when automatic selection cannot be parsed', () => {
    expect(parseSkillSelection('not-a-skill')).toBe('h3-prompt-writing');
    expect(parseSkillSelection('Use h3-prompt-writing or brand-promo-video-generator')).toBe(
      'h3-prompt-writing',
    );
    expect(parseSkillSelection('`BRAND-PROMO-VIDEO-GENERATOR`')).toBe(
      'brand-promo-video-generator',
    );
  });

  test.each([
    'Do not use brand-promo-video-generator',
    'brand-promo-video-generator please',
    'Use brand-promo-video-generator.',
  ])('rejects a non-exact Skill router response: %s', (response) => {
    expect(parseSkillSelection(response)).toBe('h3-prompt-writing');
  });

  test('routes one or two images through the LLM only when auto mode is requested', async () => {
    const validI2va = `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n${basePrompt()}`;
    const llm = new FakeChatCompletion(['i2va', validI2va]);
    const service = new SkillsService(llm);

    const result = await service.polish(profile, {
      text: 'Start from this photo and slowly push in.',
      duration: 8,
      imageCount: 1,
      mode: 'auto',
      skill: 'h3-prompt-writing',
    });

    expect(result.mode).toBe('i2va');
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0].maxTokens).toBe(16);
    expect(llm.calls[0].messages[0].content).toContain('i2va, l2va, ref2va');
  });

  test('defaults the current one-photo digital human path to Ref2VA', async () => {
    const llm = new FakeChatCompletion([refPrompt()]);
    const service = new SkillsService(llm);

    const result = await service.polish(profile, {
      text: 'Animate this presenter photo.',
      duration: 8,
      imageCount: 1,
      skill: 'h3-prompt-writing',
    });

    expect(result.mode).toBe('ref2va');
    expect(llm.calls).toHaveLength(1);
  });

  test('uses the automatically selected Skill before generation', async () => {
    const llm = new FakeChatCompletion(['brand-promo-video-generator', basePrompt()]);
    const service = new SkillsService(llm);

    const result = await service.polish(profile, {
      text: 'Create a restrained launch film for the supplied product facts.',
      duration: 8,
      skill: 'auto',
    });

    expect(result.skill).toBe('brand-promo-video-generator');
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0].maxTokens).toBe(48);
    expect(llm.calls[1].messages[0].content).toContain(
      '# Official MiniMax Skill: brand-promo-video-generator',
    );
  });

  test('uses a manual Skill without a routing request', async () => {
    const llm = new FakeChatCompletion([basePrompt()]);
    const service = new SkillsService(llm);

    const result = await service.polish(profile, {
      text: 'Create a lyric typography short.',
      duration: 8,
      skill: 'music-video-subtitle-generator',
    });

    expect(result.skill).toBe('music-video-subtitle-generator');
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].messages[0].content).toContain(
      '# Official MiniMax Skill: music-video-subtitle-generator',
    );
  });

  test('uses the general Skill when the automatic router returns an invalid selection', async () => {
    const llm = new FakeChatCompletion(['invalid-selection', basePrompt()]);
    const service = new SkillsService(llm);

    const result = await service.polish(profile, {
      text: 'Rewrite this as a direct H3 prompt.',
      duration: 8,
      skill: 'auto',
    });

    expect(result.skill).toBe('h3-prompt-writing');
    expect(llm.calls).toHaveLength(2);
  });

  test('reports the general Skill actually used after a style loading failure', async () => {
    const root = useTemporarySkillsRoot();
    rmSync(join(root, 'brand-promo-video-generator/SKILL.md'));
    const llm = new FakeChatCompletion([refPrompt()]);
    const service = new SkillsService(llm, root);

    const result = await service.polish(profile, {
      text: 'Animate this presenter photo.',
      duration: 8,
      imageCount: 1,
      skill: 'brand-promo-video-generator',
    });

    expect(result.skill).toBe('h3-prompt-writing');
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].messages[0].content).toContain(
      '# Official MiniMax Skill: h3-prompt-writing',
    );
  });
});

describe('SkillsService polish validation and repair', () => {
  test('returns the final text, Skill, mode, and attempt count', async () => {
    const valid = basePrompt();
    const llm = new FakeChatCompletion([valid]);

    const result = await new SkillsService(llm).polish(profile, {
      text: 'A quiet studio shot.',
      duration: 8,
      skill: 'h3-prompt-writing',
    });

    expect(result).toEqual({
      text: valid,
      skill: 'h3-prompt-writing',
      mode: 't2va',
      attempts: 1,
    });
    expect(llm.calls[0].maxTokens).toBe(8192);
  });

  test('requests exactly one correction after an invalid draft', async () => {
    const llm = new FakeChatCompletion(['summary: invalid', basePrompt()]);
    const service = new SkillsService(llm);

    const result = await service.polish(profile, {
      text: 'A quiet studio shot.',
      duration: 8,
      skill: 'h3-prompt-writing',
    });

    expect(result.attempts).toBe(2);
    expect(result.text).toBe(basePrompt());
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].messages.at(-1)?.content).toContain('Missing required fields:');
    expect(llm.calls[1].messages.some((message) => message.role === 'assistant')).toBe(false);
  });

  test('throws after a second invalid result and preserves the original text', async () => {
    const original = 'A quiet studio shot with the original wording preserved.';
    const llm = new FakeChatCompletion(['invalid draft one', 'invalid draft two']);
    const service = new SkillsService(llm);

    const error = await service
      .polish(profile, { text: original, duration: 8, skill: 'h3-prompt-writing' })
      .then(
        () => null,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(PromptPolishError);
    if (!(error instanceof PromptPolishError)) {
      throw new Error('Expected PromptPolishError');
    }
    expect(error.originalText).toBe(original);
    expect(error.attempts).toBe(2);
    expect(error.issues.length).toBeGreaterThan(0);
    expect(llm.calls).toHaveLength(2);
  });

  test('rejects a local path supplied as a reference label before any request', async () => {
    const llm = new FakeChatCompletion([]);
    const service = new SkillsService(llm);

    await expect(
      service.polish(profile, {
        text: 'A presenter clip.',
        duration: 8,
        referenceLabels: ['G:\\private\\avatar.png'],
        skill: 'h3-prompt-writing',
      }),
    ).rejects.toThrow(/reference labels/i);
    expect(llm.calls).toHaveLength(0);
  });

  test('keeps media, local paths, and the invalid draft out of the second request', async () => {
    const privateImagePath = 'G:\\private\\avatar.png';
    const privateAudioPath = 'D:\\private\\voice.mp3';
    const privateWorkPath = 'C:\\private\\work.mp4';
    const imageData = 'data:image/png;base64,PRIVATE_IMAGE_BYTES';
    const audioData = 'data:audio/mpeg;base64,PRIVATE_AUDIO_BYTES';
    const invalidDraft = `Invalid draft ${privateImagePath} ${imageData}`;
    let responseCount = 0;
    const upstream = await startLlmUpstream((_request, response) => {
      responseCount += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: responseCount === 1 ? invalidDraft : refPrompt(),
              },
            },
          ],
        }),
      );
    });
    upstreams.push(upstream);

    const original = 'Create a restrained presenter clip from the supplied reference labels.';
    const request = {
      text: original,
      duration: 8,
      imageCount: 1,
      videoCount: 0,
      referenceLabels: ['<Picture 1>', '<Audio 1>'],
      skill: 'h3-prompt-writing',
      imagePath: privateImagePath,
      audioPath: privateAudioPath,
      work: { outputPath: privateWorkPath },
      imageData,
      audioData,
    } as PolishRequest;

    const result = await new SkillsService(new LlmService()).polish(
      {
        baseUrl: `${upstream.baseUrl}/v1`,
        apiKey: 'local-test-key',
        model: 'local-model',
      },
      request,
    );

    expect(result.attempts).toBe(2);
    expect(upstream.requests).toHaveLength(2);
    const secondBody = upstream.requests[1].body;
    expect(secondBody).toContain(original);
    expect(secondBody).toContain('8.00');
    expect(secondBody).toContain('REF2VA');
    expect(secondBody).toContain('<Picture 1>');
    expect(secondBody).toContain('<Audio 1>');
    expect(secondBody).toContain('# Official MiniMax Skill: h3-prompt-writing');
    for (const forbidden of [
      privateImagePath,
      privateAudioPath,
      privateWorkPath,
      imageData,
      audioData,
      invalidDraft,
    ]) {
      expect(upstream.requests[0].body).not.toContain(forbidden);
      expect(secondBody).not.toContain(forbidden);
    }
    const secondPayload = JSON.parse(secondBody) as {
      messages: LlmChatMessage[];
    };
    expect(secondPayload.messages.some((message) => message.role === 'assistant')).toBe(false);
  });
});
