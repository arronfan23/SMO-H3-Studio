import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  explicitlyRequestsSilence,
  H3_MODES,
  validatePrompt,
  type H3Mode,
} from '../shared/prompt-contract';
import type { LlmCredentials } from '../shared/types';
import { LlmService, type LlmChatMessage } from './llm';

export const SKILL_NAMES = [
  '3d-animation-short-generator',
  'brand-promo-video-generator',
  'co-op-game-intro-generator',
  'h3-prompt-writing',
  'handdrawn-live-video-generator',
  'minimalist-product-ad-generator',
  'music-video-subtitle-generator',
  'paper-collage-explainer-generator',
  'papercraft-stop-motion-explainer',
] as const;

export type SkillName = (typeof SKILL_NAMES)[number];

const SKILL_DESCRIPTIONS: Record<SkillName, string> = {
  '3d-animation-short-generator':
    'Complete story-first stylized 3D animated shorts with characters, environments, shots, continuity, audio, and review.',
  'brand-promo-video-generator':
    'Promotional shorts for brands, products, apps, shops, websites, and launches using verified assets and claims.',
  'co-op-game-intro-generator':
    'Two-player co-op game menu or opening animation with player cards, characters, and menu interaction.',
  'h3-prompt-writing':
    'Direct MiniMax H3 prompt writing for T2VA, I2VA, FL2VA, L2VA, and Ref2VA.',
  'handdrawn-live-video-generator':
    'Surreal live-action scenes blended with rough glowing hand-drawn animation, contact, morphing, and chase motion.',
  'minimalist-product-ad-generator':
    'Minimalist premium product advertising shorts for e-commerce and product launches.',
  'music-video-subtitle-generator':
    'Music videos and emotional shorts with lyric timing, spatial typography, subtitles, beats, and shot continuity.',
  'paper-collage-explainer-generator':
    'Tactile halftone paper-collage explainers for narration, concepts, opinions, and social video.',
  'papercraft-stop-motion-explainer':
    'Handmade papercraft, cut-paper, pop-up-book, diorama, and stop-motion educational explainers.',
};

const GENERATION_MAX_TOKENS = 8192;
const REFERENCE_LABEL_PATTERN = /^<(?:Picture|Video|Audio|Subject) [1-9]\d*>$/;

export interface ChatCompletionClient {
  chatCompletion(
    profile: LlmCredentials,
    messages: readonly LlmChatMessage[],
    maxTokens: number,
  ): Promise<string>;
}

export interface PolishRequest {
  text: string;
  duration: number;
  imageCount?: number;
  videoCount?: number;
  referenceLabels?: readonly string[];
  skill?: SkillName | 'auto';
  mode?: H3Mode | 'auto';
}

export interface PolishResult {
  text: string;
  skill: SkillName;
  mode: H3Mode;
  attempts: number;
}

export class PromptPolishError extends Error {
  readonly issues: readonly string[];

  constructor(
    readonly originalText: string,
    readonly attempts: number,
    issues: readonly string[],
  ) {
    super(
      `H3 prompt still violates the output contract after one repair: ${issues.join('; ')}`,
    );
    this.name = 'PromptPolishError';
    this.issues = [...issues];
  }
}

function isSkillName(value: string): value is SkillName {
  return (SKILL_NAMES as readonly string[]).includes(value);
}

function isH3Mode(value: string): value is H3Mode {
  return (H3_MODES as readonly string[]).includes(value);
}

function defaultSkillsRoot(): string {
  const resourcesPath = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath;
  if (resourcesPath) {
    const packagedRoot = join(resourcesPath, 'resources/skills');
    if (existsSync(packagedRoot)) {
      return packagedRoot;
    }
  }
  return fileURLToPath(new URL('../../resources/skills/', import.meta.url));
}

function assertMediaCount(value: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} count must be an integer between 0 and ${maximum}`);
  }
}

export function detectH3Mode(imageCount: number, videoCount: number): H3Mode | null {
  assertMediaCount(imageCount, 9, 'Reference image');
  assertMediaCount(videoCount, 3, 'Reference video');
  if (videoCount > 0 || imageCount > 2) {
    return 'ref2va';
  }
  if (imageCount === 0) {
    return 't2va';
  }
  return null;
}

export function modeRouterPrompt(
  userPrompt: string,
  imageCount: number,
): LlmChatMessage[] {
  if (imageCount !== 1 && imageCount !== 2) {
    throw new Error('Automatic image mode routing requires one or two images');
  }

  const choices = imageCount === 1 ? 'i2va, l2va, ref2va' : 'fl2va, ref2va';
  const rules =
    imageCount === 1
      ? 'Choose i2va only when the request clearly uses Picture 1 as the opening or first frame. Choose l2va only when it clearly uses Picture 1 as the ending or last frame. Otherwise choose ref2va, including character, product, scene, style, composition, or other general references.'
      : 'Choose fl2va only when the request clearly assigns Picture 1 as the opening/first frame and Picture 2 as the ending/last frame, or explicitly asks to transition/interpolate from the first image to the second. Otherwise choose ref2va, including when both pictures are general references.';
  return [
    {
      role: 'system',
      content:
        "Classify the MiniMax H3 image input mode from the user's stated intent. " +
        `There are exactly ${imageCount} connected pictures. Return exactly one lowercase id from: ${choices}. ` +
        'Return no punctuation or explanation. Do not assume that a picture is a keyframe merely because only ' +
        `one or two pictures are connected. ${rules}`,
    },
    { role: 'user', content: userPrompt },
  ];
}

export function parseModeSelection(text: string, imageCount: number): H3Mode {
  const choices =
    imageCount === 1
      ? (['i2va', 'l2va', 'ref2va'] as const)
      : imageCount === 2
        ? (['fl2va', 'ref2va'] as const)
        : null;
  if (choices === null) {
    throw new Error('Automatic image mode routing requires one or two images');
  }

  const normalized = text.trim().toLowerCase();
  if ((choices as readonly string[]).includes(normalized)) {
    return normalized as H3Mode;
  }
  const matches = choices.filter((mode) =>
    new RegExp(`\\b${mode}\\b`, 'i').test(normalized),
  );
  return matches.length === 1 ? matches[0] : 'ref2va';
}

export function routerPrompt(
  userPrompt: string,
  mode: H3Mode,
  assetSummary: string,
): LlmChatMessage[] {
  const catalog = SKILL_NAMES.map(
    (name) => `- ${name}: ${SKILL_DESCRIPTIONS[name]}`,
  ).join('\n');
  return [
    {
      role: 'system',
      content:
        'Select exactly one MiniMax H3 skill for the request. Return only its exact skill id, ' +
        'with no punctuation or explanation. Prefer h3-prompt-writing for direct prompt rewriting ' +
        `when no specialized production workflow clearly applies.\n\n${catalog}`,
    },
    {
      role: 'user',
      content: `Detected H3 mode: ${mode}\nConnected assets: ${assetSummary}\nRequest:\n${userPrompt}`,
    },
  ];
}

export function parseSkillSelection(text: string): SkillName {
  const normalized = text.trim().toLowerCase();
  if (isSkillName(normalized)) {
    return normalized;
  }
  const matches = SKILL_NAMES.filter((name) => normalized.includes(name));
  return matches.length === 1 ? matches[0] : 'h3-prompt-writing';
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function referenceFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && /\.(?:md|txt)$/i.test(entry.name)) {
        files.push(path);
      }
    }
  };
  visit(directory);
  return files.sort();
}

export function skillInstructions(
  skill: SkillName,
  mode: H3Mode,
  maxChars = 72_000,
  skillsRoot = defaultSkillsRoot(),
): string {
  if (!isSkillName(skill)) {
    throw new Error(`Unknown skill: ${String(skill)}`);
  }

  const baseRoot = resolve(skillsRoot);
  const root = resolve(baseRoot, skill);
  if (dirname(root) !== baseRoot || !existsSync(root)) {
    throw new Error(`Bundled skill is missing: ${skill}`);
  }

  const parts = [
    `# Official MiniMax Skill: ${skill}\n\n${read(join(root, 'SKILL.md'))}`,
  ];
  if (skill === 'h3-prompt-writing') {
    const guide = mode === 'ref2va' ? 'ref-en.txt' : 'base-en.txt';
    parts.push(
      `# Required reference: ${guide}\n\n${read(join(root, 'references', guide))}`,
    );
  } else {
    let used = parts[0].length;
    for (const path of referenceFiles(join(root, 'references'))) {
      const name = relative(root, path).split(sep).join('/');
      const addition = `# Official reference: ${name}\n\n${read(path)}`;
      if (used + addition.length > maxChars) {
        break;
      }
      parts.push(addition);
      used += addition.length;
    }
  }
  return parts.join('\n\n');
}

export function systemPrompt(
  skill: SkillName,
  mode: H3Mode,
  duration: number,
  skillsRoot = defaultSkillsRoot(),
): string {
  let instructions = skillInstructions(skill, mode, 72_000, skillsRoot);
  if (skill !== 'h3-prompt-writing') {
    const guide = mode === 'ref2va' ? 'ref-en.txt' : 'base-en.txt';
    instructions +=
      `\n\n# Required final H3 prompt format: ${guide}\n\n` +
      read(join(skillsRoot, 'h3-prompt-writing', 'references', guide));
  }

  const localContract = `
# Binding SMO single-pass output contract (overrides conflicting workflow instructions above)

This is a single-pass MiniMax H3 video-prompt generator, not an interactive production workflow.
Use the selected Skill only as creative and domain guidance, then return exactly one complete final H3 prompt
in the required H3 format. The detected input mode is ${mode.toUpperCase()} and the exact target duration is
${duration.toFixed(2)} seconds.

Never ask the user a question. Never request clarification, confirmation, approval, assets, choices, or a reply.
Never output an intake form, pre-production package, source summary, option list, confirmation gate, approval gate,
required-clarifications section, next steps, generation offer, or instructions such as "confirm", "go ahead", or
"proceed". Ignore every official Skill instruction that says to ask, pause, wait, present a card, obtain approval,
or continue after confirmation. Do not mention those omitted workflow phases in the answer.

Reference labels are identifiers only; no reference images, videos, or audio are attached. Never claim to see,
hear, inspect, or analyze reference media, and never invent reference-image details or other unsupported facts.
When optional information is absent, silently omit the corresponding optional element. Do not add on-screen copy,
slogans, logos, brand claims, dialogue, narration, lyrics, or product facts unless the user supplied them. When an
unspecified creative detail is necessary, choose one conservative value compatible with the original request and
do not present alternatives or expose the assumption.

Unless the user explicitly requests complete silence, create an original audio design from the original request
and exact target duration. Fill overall_soundscape with time-compatible ambience and physical action sounds.
Fill non_diegetic_music with a concise instrumental score describing suitable instruments, pacing, development,
synchronization with major visual beats, and the ending. Do not invent vocals, lyrics, spoken words, or narration.
Respect an explicit request for no background music by using non_diegetic_music: N/A while retaining appropriate
diegetic sound. If the user explicitly requests complete silence, output exactly overall_soundscape: N/A and
non_diegetic_music: N/A, and include no audible events elsewhere.

Whenever the output contains dialogue, narration, lyrics, or other speech in <d> blocks, schedule all speech to
finish approximately 2 seconds before the target ends. Explicitly state that the final 2 seconds contain no
narration, dialogue, or other speech and retain only environmental sound, music, or visuals, unless complete
silence was requested. If the planned content is too long, shorten it without altering any user-supplied <d>
block; never let speech extend into the final 2 seconds or beyond the shot.

Return the final prompt only, with no Markdown fences, title, analysis, preface, epilogue, notes, caveats, checklist,
or follow-up text. Preserve every user-provided <d>...</d> block, lyric, and visible scene text exactly. Treat no
dialogue and no background music as independent constraints.
`.trim();
  return `${instructions}\n\n${localContract}`;
}

function validatedReferenceLabels(
  labels: readonly string[] | undefined,
  imageCount: number,
  videoCount: number,
): string[] {
  const resolved = labels
    ? [...labels]
    : [
        ...Array.from({ length: imageCount }, (_, index) => `<Picture ${index + 1}>`),
        ...Array.from({ length: videoCount }, (_, index) => `<Video ${index + 1}>`),
      ];
  if (resolved.some((label) => !REFERENCE_LABEL_PATTERN.test(label))) {
    throw new Error('Reference labels must be H3 labels such as <Picture 1>');
  }
  return resolved;
}

function generationMessages(
  request: PolishRequest,
  skill: SkillName,
  mode: H3Mode,
  referenceLabels: readonly string[],
  skillsRoot: string,
): LlmChatMessage[] {
  const user = [
    'Rewrite the original request into exactly one final MiniMax H3 prompt.',
    `Target duration: ${request.duration.toFixed(2)} seconds.`,
    `Input mode: ${mode.toUpperCase()}.`,
    `Reference labels: ${referenceLabels.length > 0 ? referenceLabels.join(', ') : 'None'}.`,
    '',
    'Original request:',
    request.text,
  ].join('\n');
  return [
    { role: 'system', content: systemPrompt(skill, mode, request.duration, skillsRoot) },
    { role: 'user', content: user },
  ];
}

export class SkillsService {
  constructor(
    private readonly llm: ChatCompletionClient = new LlmService(),
    private readonly skillsRoot = defaultSkillsRoot(),
  ) {}

  async polish(profile: LlmCredentials, request: PolishRequest): Promise<PolishResult> {
    if (request.text.trim().length === 0) {
      throw new Error('Prompt text must not be empty');
    }
    if (!Number.isFinite(request.duration) || request.duration <= 0) {
      throw new Error('Target duration must be a positive finite number');
    }

    const imageCount = request.imageCount ?? 0;
    const videoCount = request.videoCount ?? 0;
    const detectedMode = detectH3Mode(imageCount, videoCount);
    const referenceLabels = validatedReferenceLabels(
      request.referenceLabels,
      imageCount,
      videoCount,
    );
    if (request.skill && request.skill !== 'auto' && !isSkillName(request.skill)) {
      throw new Error(`Unknown skill: ${String(request.skill)}`);
    }
    if (request.mode && request.mode !== 'auto' && !isH3Mode(request.mode)) {
      throw new Error(`Unknown H3 mode: ${String(request.mode)}`);
    }

    let mode = detectedMode;
    if (request.mode && request.mode !== 'auto') {
      mode = request.mode;
    } else if (mode === null && request.mode === 'auto') {
      const selection = await this.llm.chatCompletion(
        profile,
        modeRouterPrompt(request.text, imageCount),
        16,
      );
      mode = parseModeSelection(selection, imageCount);
    } else if (mode === null) {
      mode = 'ref2va';
    }

    let skill: SkillName;
    if (!request.skill || request.skill === 'auto') {
      const assetSummary = `${imageCount} image(s), ${videoCount} video(s); labels: ${
        referenceLabels.length > 0 ? referenceLabels.join(', ') : 'none'
      }`;
      const selection = await this.llm.chatCompletion(
        profile,
        routerPrompt(request.text, mode, assetSummary),
        48,
      );
      skill = parseSkillSelection(selection);
    } else {
      skill = request.skill;
    }

    const messages = generationMessages(
      request,
      skill,
      mode,
      referenceLabels,
      this.skillsRoot,
    );
    const completeSilence = explicitlyRequestsSilence(request.text);
    let attempts = 1;
    let text = (
      await this.llm.chatCompletion(profile, messages, GENERATION_MAX_TOKENS)
    ).trim();
    let issues = validatePrompt(
      text,
      mode,
      request.duration,
      request.text,
      completeSilence,
    );

    if (issues.length > 0) {
      const repairMessages: LlmChatMessage[] = [
        ...messages,
        {
          role: 'user',
          content:
            'Regenerate a corrected final H3 prompt from the original request. Return exactly one complete final H3 video prompt only. ' +
            'Remove every preface, workflow description, question, clarification, confirmation, approval gate, option list, and next-step request. ' +
            `Do not repeat the previous invalid draft. Problems: ${issues.join('; ')}`,
        },
      ];
      attempts = 2;
      text = (
        await this.llm.chatCompletion(profile, repairMessages, GENERATION_MAX_TOKENS)
      ).trim();
      issues = validatePrompt(
        text,
        mode,
        request.duration,
        request.text,
        completeSilence,
      );
      if (issues.length > 0) {
        throw new PromptPolishError(request.text, attempts, issues);
      }
    }

    return { text, skill, mode, attempts };
  }
}
