export const H3_MODES = ['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va'] as const;

export type H3Mode = (typeof H3_MODES)[number];

const BASE_FIELDS = [
  'integrated_multimodal_description:',
  'overall_soundscape:',
  'non_diegetic_music:',
] as const;

const REF_FIELDS = [
  'subject_definitions:',
  'summary:',
  'retention_analysis:',
  'detailed_description:',
  'overall_soundscape:',
  'non_diegetic_music:',
] as const;

const DIALOGUE_PATTERN = /<d>[\s\S]*?<\/d>/g;
const TIMESTAMP_PATTERN = /\bAt\s+(\d{2}):(\d{2})\.(\d{3})\b/g;
const VISIBLE_TEXT_PATTERN = /"[^"\r\n]*"/g;
const FIELD_LABEL_PATTERN = /^[ \t]*(?:integrated_multimodal_description|subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):/gim;
const EXPLANATION_PREFIX_PATTERN = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?(?:explanation|analysis|notes?|preface|epilogue)(?:\*\*)?[ \t]*(?::|-|$)/im;
const FINAL_TWO_SECONDS = String.raw`\b(?:final|last)\s+(?:2|two)\s+seconds?\b`;
const VOCAL_WORDS = String.raw`(?:narration|dialogue|speech|voiceover|voice-over|spoken\s+(?:words?|content)|vocals?)`;
const NON_NARRATION_TAIL_PATTERNS = [
  new RegExp(
    `${FINAL_TWO_SECONDS}\\b[^.\\n]{0,160}\\b(?:no|without)\\s+${VOCAL_WORDS}\\b`,
    'i',
  ),
  new RegExp(
    `\\b${VOCAL_WORDS}\\b[^.\\n]{0,120}\\b(?:ends?|stops?|finishes?|concludes?)\\b[^.\\n]{0,80}\\b(?:before|prior\\s+to)\\b[^.\\n]{0,80}${FINAL_TWO_SECONDS}\\b`,
    'i',
  ),
  new RegExp(
    `${FINAL_TWO_SECONDS}\\b[^.\\n]{0,160}\\b(?:only|exclusively)\\b[^.\\n]{0,120}\\b(?:ambient|ambience|ambiance|environmental|music|visuals?|picture|room\\s+tone|silence|silent)\\b`,
    'i',
  ),
];

const INTERACTIVE_OUTPUT_PATTERNS = [
  /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:required\s+)?(?:clarifications?|questions?|next steps?|start gate|approval|confirmation)\b/im,
  /\bnext steps?\b/i,
  /\bplease\s+(?:confirm|reply|provide|upload|choose|answer|let\s+me\s+know)\b/i,
  /\b(?:do|would|could|can)\s+you\b/i,
  /\bshould\s+(?:the|we|i)\b[^.\n]*\?/i,
  /\b(?:confirm|reply)\s+["']?(?:confirm|go\s+ahead|continue)\b/i,
  /\bto\s+proceed\s+with\s+(?:generation|the\s+next\s+step)\b/i,
  /\bawait(?:ing)?\s+(?:your\s+)?(?:confirmation|approval|reply)\b/i,
  /请(?:确认|回复|提供|上传|选择|回答|告知)/,
  /(?:你|您)(?:是否|希望|想要)/,
  /等待(?:你|您|用户)?(?:确认|回复)/,
  /确认后(?:再|即可|将)/,
];

const SILENCE_REQUEST_PATTERNS = [
  /\b(?:completely silent|complete silence|silent video|muted video|no audio|no sound(?: at all)?|without any (?:audio|sound))\b/i,
  /(?:完全静音|全程静音|静音视频|视频静音|无声视频|不要任何声音|不需要任何声音)/,
];

const AUDIBLE_EVENT_PATTERNS = [
  /\b(?:says?|said|speaks?|speaking|narrates?|narrating|sings?|singing|shouts?|shouting|whispers?|whispering|chants?|chanting|hums?|humming)\b/i,
  /\b(?:footsteps?|doorbells?|applause|laughter|panting|heartbeats?|sounds?|audio|noise|ambience|ambiance|ambient\s+(?:sound|noise)|room\s+tone|soundscape|sound\s+effects?|music|soundtrack|songs?|melody|melodies|lyrics|voices?|narration|dialogue|speech|vocals?)\b/i,
  /\b(?:slams?|slamming|bangs?|banging|crashes?|crashing|clicks?|clicking|claps?|clapping|knocks?|knocking|rings?|ringing|rustles?|rustling|echoes?|echoing|beeps?|beeping|barks?|barking|howls?|howling|whistles?|whistling|roars?|roaring)\b/i,
  /\b(?:music|soundtrack|score|ambience|ambiance|room\s+tone|sound\s+effects?)\s+(?:plays?|playing|continues?|continuing|swells?|swelling|fades?|fading|builds?|building)\b/i,
  /\b(?:loudly|audibly)\b/i,
];
const SILENT_AUDIO_TERM = String.raw`(?:audible\s+(?:activity|events?)|activity|events?|sounds?|audio|music|ambience|ambiance|room\s+tone|soundscape|songs?|melody|melodies|lyrics|dialogue|narration|speech|voices?|vocals?|footsteps?|noise)`;
const SILENT_ASSERTION_PATTERN = new RegExp(
  String.raw`\b(?:no|without|free\s+of)\s+(?:any\s+)?${SILENT_AUDIO_TERM}(?:\s*(?:,|or|and)\s*(?:any\s+)?${SILENT_AUDIO_TERM})*`,
  'gi',
);

export function explicitlyRequestsSilence(text: string): boolean {
  return SILENCE_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

function fieldPosition(text: string, field: string): number {
  const match = new RegExp(`^${field}`, 'm').exec(text);
  return match?.index ?? -1;
}

function hasNonNarrationTail(text: string): boolean {
  return NON_NARRATION_TAIL_PATTERNS.some((pattern) => pattern.test(text));
}

function stripDialogueAndVisibleText(text: string): string {
  return text.replace(DIALOGUE_PATTERN, ' ').replace(VISIBLE_TEXT_PATTERN, ' ');
}

function validateInteractionAndExplanation(text: string): string[] {
  const scope = stripDialogueAndVisibleText(text);
  const issues: string[] = [];
  if (
    /[?？]/.test(scope) ||
    INTERACTIVE_OUTPUT_PATTERNS.some((pattern) => pattern.test(scope))
  ) {
    issues.push(
      'Remove all questions, clarifications, confirmations, approval gates, and next-step requests',
    );
  }
  if (EXPLANATION_PREFIX_PATTERN.test(scope)) {
    issues.push('Remove explanations, analysis, notes, prefaces, and epilogues');
  }
  return issues;
}

function hasAudibleEvent(text: string): boolean {
  const scope = stripDialogueAndVisibleText(text)
    .replace(FIELD_LABEL_PATTERN, '')
    .replace(/\bN\/A\b/g, '')
    .replace(SILENT_ASSERTION_PATTERN, '');
  return AUDIBLE_EVENT_PATTERNS.some((pattern) => pattern.test(scope));
}

function validateCompleteSilence(text: string): string[] {
  const issues: string[] = [];
  const soundscapeIsSilent = /^overall_soundscape:[ \t]*N\/A[ \t]*$/im.test(text);
  const musicIsSilent = /^non_diegetic_music:[ \t]*N\/A[ \t]*$/im.test(text);
  if (!soundscapeIsSilent || !musicIsSilent) {
    issues.push(
      'Complete silence was requested: set both overall_soundscape and non_diegetic_music exactly to N/A',
    );
  }
  if (/<d>[\s\S]*?<\/d>/.test(text) || hasAudibleEvent(text)) {
    issues.push('Complete silence was requested: remove all audible events');
  }
  return issues;
}

export function validatePrompt(
  text: string,
  mode: H3Mode,
  duration: number,
  original = '',
  requireCompleteSilence = explicitlyRequestsSilence(original),
): string[] {
  const stripped = text.trim();
  if (stripped.length === 0) {
    return ['The output is empty'];
  }

  const issues: string[] = [];
  if (stripped.includes('```')) {
    issues.push('Remove Markdown code fences');
  }

  issues.push(...validateInteractionAndExplanation(stripped));

  const fields = mode === 'ref2va' ? REF_FIELDS : BASE_FIELDS;
  const positions = fields.map((field) => fieldPosition(stripped, field));
  const missing = fields.filter((_field, index) => positions[index] < 0);
  if (missing.length > 0) {
    issues.push(`Missing required fields: ${missing.join(', ')}`);
  } else if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    issues.push('Required fields are not in the official order');
  }

  if (mode === 't2va' && !stripped.startsWith(BASE_FIELDS[0])) {
    issues.push('T2VA must begin directly with integrated_multimodal_description');
  }
  if (mode === 'ref2va' && !stripped.startsWith(REF_FIELDS[0])) {
    issues.push('REF2VA must begin directly with subject_definitions');
  }
  if (
    mode === 'i2va' &&
    !stripped.startsWith('For the target video, at 0.00 seconds into the target video,')
  ) {
    issues.push('I2VA must begin with the official first-frame instruction');
  }
  if (
    (mode === 'fl2va' || mode === 'l2va') &&
    !stripped.startsWith('How the reference pictures align with the target video')
  ) {
    issues.push(`${mode.toUpperCase()} must begin with the official alignment instruction`);
  }

  let previous = -1;
  for (const match of stripped.matchAll(TIMESTAMP_PATTERN)) {
    const timestamp =
      Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 1000;
    if (timestamp <= previous) {
      issues.push('Shot timestamps must be strictly increasing');
      break;
    }
    if (timestamp >= duration) {
      issues.push(
        `Shot timestamp ${timestamp.toFixed(3)}s must be earlier than ${duration.toFixed(2)}s`,
      );
      break;
    }
    previous = timestamp;
  }

  for (const match of original.matchAll(DIALOGUE_PATTERN)) {
    if (!stripped.includes(match[0])) {
      issues.push('Dialogue was modified');
      break;
    }
  }

  if (/<d>[\s\S]*?<\/d>/.test(stripped) && !hasNonNarrationTail(stripped)) {
    issues.push('Missing narration tail');
  }

  if (requireCompleteSilence) {
    issues.push(...validateCompleteSilence(stripped));
  }

  return issues;
}
