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
const VISIBLE_TEXT_PATTERN = /"[^"\r\n]*"/g;
const FIELD_LABEL_PATTERN = /^[ \t]*(?:integrated_multimodal_description|subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):/gim;
const EXPLANATION_PREFIX_PATTERN = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?(?:explanation|analysis|notes?|preface|epilogue)(?:\*\*)?[ \t]*(?::|-|$)/im;
const SELF_REFERENTIAL_PROMPT_PATTERN = /\bthis\s+(?:final\s+)?prompt\b/i;
const SHOT_HEAD_PATTERN = /\[Shot\s+(\d+)\][\s\S]*?(?=\[Shot\s+\d+\]|$)/g;
const SHOT_TIMESTAMP_PATTERN = /^\[Shot\s+\d+\][ \t]+At\s+(\d{2}):(\d{2})\.(\d{3})\b/;
const FINAL_TWO_SECONDS = String.raw`\b(?:final|last)\s+(?:2|two)\s+seconds?\b`;
const TAIL_PERIOD_PATTERN = new RegExp(FINAL_TWO_SECONDS, 'i');
const VOCAL_WORDS = String.raw`(?:narration|dialogue|speech|voiceover|voice-over|spoken\s+(?:words?|content)|vocals?|singing|lyrics)`;
const TAIL_VOCAL_EVENT_PATTERN = new RegExp(
  String.raw`\b(?:${VOCAL_WORDS}|says?|said|speaks?|speaking|narrates?|narrating|sings?|singing|shouts?|shouting|whispers?|whispering|chants?|chanting|hums?|humming)\b`,
  'i',
);
const NEGATED_TAIL_VOCAL_PATTERN = new RegExp(
  String.raw`\b(?:no|without)\s+(?:any\s+)?${VOCAL_WORDS}(?:\s*(?:,|or|and)\s*(?:any\s+)?${VOCAL_WORDS})*`,
  'i',
);
const STOPPED_TAIL_VOCAL_PATTERN = new RegExp(
  String.raw`\b${VOCAL_WORDS}\b[^.\n;]{0,80}\b(?:ends?|stops?|finishes?|concludes?)\b[^.\n;]{0,40}\b(?:before|prior\s+to)\b`,
  'i',
);
const ONLY_ALLOWED_TAIL_PATTERN = new RegExp(
  `${FINAL_TWO_SECONDS}\\b[^.\\n;]{0,160}\\b(?:only|exclusively)\\b[^.\\n;]{0,120}\\b(?:ambient|ambience|ambiance|environmental|music|visuals?|picture|room\\s+tone|silence|silent)\\b`,
  'i',
);

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
const NEGATED_SILENCE_PATTERN = /\b(?:not|isn't|is\s+not|wasn't|never)\s+(?:a\s+)?(?:completely\s+|entirely\s+)?(?:silent|silence|muted)\b/i;
const LOCAL_SILENCE_SCOPE_PATTERN = /\b(?:in|during|at|for)\s+(?:the\s+)?(?:opening|closing|first|last|beginning|ending|final|start|shot\s+\d+|scene\s+\d+|\d+(?:st|nd|rd|th)?\s+seconds?)\b/i;
const CLAUSE_SEPARATOR_PATTERN = /[,;\n]+|(?<=[.!?])\s+/;

const MUSIC_TERM = String.raw`(?:music|soundtrack|score|songs?|melody|melodies|lyrics)`;
const MUSIC_VERB = String.raw`(?:plays?|playing|performs?|performing|sounds?|sounding|continues?|continuing|swells?|swelling|fades?|fading|builds?|building|fills?|filling|resumes?|resuming|throughout)`;
const MUSIC_QUALIFIER = String.raw`(?:soft|loud|background|instrumental|ambient|diegetic|non-diegetic|orchestral|cinematic|piano|guitar|violin|cello|percussive|synthesized)`;
const INSTRUMENT_TERM = String.raw`(?:piano|guitar|violin|cello|drums?|flute|trumpet|saxophone|synthesizer)`;
const AUDIBLE_EVENT_PATTERNS = [
  /\b(?:says?|said|speaks?|speaking|narrates?|narrating|sings?|singing|shouts?|shouting|whispers?|whispering|chants?|chanting|hums?|humming)\b/i,
  /\b(?:footsteps?|doorbells?|applause|laughter|panting|heartbeats?|sounds?|audio|noise|ambience|ambiance|ambient\s+(?:sound|noise)|room\s+tone|soundscape|sound\s+effects?|voices?|narration|dialogue|speech|vocals?)\b/i,
  /\b(?:slams?|slamming|bangs?|banging|crashes?|crashing|clicks?|clicking|claps?|clapping|knocks?|knocking|rings?|ringing|rustles?|rustling|echoes?|echoing|beeps?|beeping|barks?|barking|howls?|howling|whistles?|whistling|roars?|roaring|patters?|pattering|rumbles?|rumbling)\b/i,
  /\b(?:loudly|audibly)\b/i,
  new RegExp(String.raw`\b${MUSIC_TERM}\b[^.\n;]{0,60}\b${MUSIC_VERB}\b`, 'i'),
  new RegExp(String.raw`\b${MUSIC_VERB}\b[^.\n;]{0,60}\b${MUSIC_TERM}\b`, 'i'),
  new RegExp(String.raw`\b${MUSIC_QUALIFIER}\b(?:\s+[\w-]+){0,2}\s+${MUSIC_TERM}\b`, 'i'),
  new RegExp(String.raw`\b${INSTRUMENT_TERM}\b[^.\n;]{0,30}\b(?:plays?|playing|sounds?|sounding|notes?|melody|melodies)\b`, 'i'),
  new RegExp(String.raw`\b(?:plays?|playing|performs?|performing)\b[^.\n;]{0,40}\b${INSTRUMENT_TERM}\b`, 'i'),
];
const SILENT_AUDIO_TERM = String.raw`(?:audible\s+(?:activity|events?)|activity|events?|sounds?|audio|music|soundtrack|score|ambience|ambiance|room\s+tone|soundscape|songs?|melody|melodies|lyrics|dialogue|narration|speech|voices?|vocals?|footsteps?|noise)`;
const NEGATED_AUDIO_ADJECTIVES = String.raw`(?:(?!and\b|or\b)[\w-]+\s+){0,2}`;
const SILENT_AUDIO_LIST_PATTERN = new RegExp(
  String.raw`\b(?:no|without|free\s+of)\s+(?:any\s+)?${NEGATED_AUDIO_ADJECTIVES}${SILENT_AUDIO_TERM}(?:\s*(?:or|and)\s*(?:any\s+)?${NEGATED_AUDIO_ADJECTIVES}${SILENT_AUDIO_TERM})*\s*$`,
  'i',
);
const SIMPLE_SILENT_ASSERTION_PATTERN = new RegExp(
  String.raw`\b(?:no|without|free\s+of)\s+(?:any\s+)?${NEGATED_AUDIO_ADJECTIVES}${SILENT_AUDIO_TERM}`,
  'gi',
);

export function explicitlyRequestsSilence(text: string): boolean {
  const scope = stripDialogueAndVisibleText(text);
  return scope.split(/[.!?。！？\n]+|\b(?:but|however)\b/i).some((clause) => {
    if (
      NEGATED_SILENCE_PATTERN.test(clause) ||
      LOCAL_SILENCE_SCOPE_PATTERN.test(clause)
    ) {
      return false;
    }
    return SILENCE_REQUEST_PATTERNS.some((pattern) => pattern.test(clause));
  });
}

function fieldPosition(text: string, field: string): number {
  const match = new RegExp(`^${field}`, 'm').exec(text);
  return match?.index ?? -1;
}

function extractFieldValue(text: string, field: string): string {
  const match = new RegExp(`^${field}`, 'm').exec(text);
  if (!match) {
    return '';
  }
  const remainder = text.slice(match.index + match[0].length);
  const nextField = new RegExp(FIELD_LABEL_PATTERN.source, 'gim').exec(remainder);
  return nextField ? remainder.slice(0, nextField.index) : remainder;
}

function protectedItemsMatch(
  original: string,
  output: string,
  pattern: RegExp,
): boolean {
  const expected = [...original.matchAll(pattern)].map((match) => match[0]);
  if (expected.length === 0) {
    return true;
  }
  const actual = [...output.matchAll(pattern)].map((match) => match[0]);
  return (
    expected.length === actual.length &&
    expected.every((value, index) => value === actual[index])
  );
}

function stripDialogueAndVisibleText(text: string): string {
  return text.replace(DIALOGUE_PATTERN, ' ').replace(VISIBLE_TEXT_PATTERN, ' ');
}

function hasNonNarrationTail(text: string): boolean {
  const scope = stripDialogueAndVisibleText(text);
  for (const clause of scope.split(CLAUSE_SEPARATOR_PATTERN)) {
    const tailMatch = TAIL_PERIOD_PATTERN.exec(clause);
    if (!tailMatch) {
      continue;
    }
    const tail = clause.slice(tailMatch.index);
    const hasNegation = NEGATED_TAIL_VOCAL_PATTERN.test(tail);
    const hasStoppedVocals = STOPPED_TAIL_VOCAL_PATTERN.test(clause);
    const hasOnlyAllowedContent = ONLY_ALLOWED_TAIL_PATTERN.test(clause);
    if (!hasNegation && !hasStoppedVocals && !hasOnlyAllowedContent) {
      continue;
    }
    const remaining = tail
      .replace(new RegExp(NEGATED_TAIL_VOCAL_PATTERN.source, 'gi'), '')
      .replace(new RegExp(STOPPED_TAIL_VOCAL_PATTERN.source, 'gi'), '');
    if (!TAIL_VOCAL_EVENT_PATTERN.test(remaining)) {
      return true;
    }
  }
  return false;
}

function validateShotTimestamps(
  text: string,
  mode: H3Mode,
  duration: number,
): string[] {
  const field = mode === 'ref2va' ? REF_FIELDS[3] : BASE_FIELDS[0];
  const description = stripDialogueAndVisibleText(extractFieldValue(text, field));
  let previous = -1;
  for (const match of description.matchAll(SHOT_HEAD_PATTERN)) {
    if (Number(match[1]) <= 1) {
      continue;
    }
    const timestampMatch = SHOT_TIMESTAMP_PATTERN.exec(match[0]);
    if (!timestampMatch) {
      return ['Later shots must begin with At MM:SS.mmm'];
    }
    const timestamp =
      Number(timestampMatch[1]) * 60 +
      Number(timestampMatch[2]) +
      Number(timestampMatch[3]) / 1000;
    if (timestamp <= previous) {
      return ['Shot timestamps must be strictly increasing'];
    }
    if (timestamp >= duration) {
      return [
        `Shot timestamp ${timestamp.toFixed(3)}s must be earlier than ${duration.toFixed(2)}s`,
      ];
    }
    previous = timestamp;
  }
  return [];
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
  if (
    EXPLANATION_PREFIX_PATTERN.test(scope) ||
    SELF_REFERENTIAL_PROMPT_PATTERN.test(scope)
  ) {
    issues.push('Remove explanations, analysis, notes, prefaces, and epilogues');
  }
  return issues;
}

function stripNegatedAudioFromClause(clause: string): string {
  if (SILENT_AUDIO_LIST_PATTERN.test(clause)) {
    return clause.replace(new RegExp(SILENT_AUDIO_LIST_PATTERN.source, 'gi'), '');
  }
  return clause.replace(SIMPLE_SILENT_ASSERTION_PATTERN, '');
}

function hasAudibleEvent(text: string): boolean {
  const scope = stripDialogueAndVisibleText(text)
    .replace(FIELD_LABEL_PATTERN, '')
    .replace(/\bN\/A\b/g, '');
  return scope.split(CLAUSE_SEPARATOR_PATTERN).some((clause) => {
    const remaining = stripNegatedAudioFromClause(clause);
    return AUDIBLE_EVENT_PATTERNS.some((pattern) => pattern.test(remaining));
  });
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

  issues.push(...validateShotTimestamps(stripped, mode, duration));

  if (!protectedItemsMatch(original, stripped, DIALOGUE_PATTERN)) {
    issues.push('Dialogue was modified');
  }
  if (!protectedItemsMatch(original, stripped, VISIBLE_TEXT_PATTERN)) {
    issues.push('Visible text was modified');
  }

  if (/<d>[\s\S]*?<\/d>/.test(stripped) && !hasNonNarrationTail(stripped)) {
    issues.push('Missing narration tail');
  }

  if (requireCompleteSilence) {
    issues.push(...validateCompleteSilence(stripped));
  }

  return issues;
}
