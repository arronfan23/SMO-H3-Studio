export const WORKFLOW_NODES = {
  text: {
    image: '226',
    prompt: '136',
    duration: '132',
    seed: '269',
    output: '180',
  },
  audio: {
    image: '36',
    audio: '34',
    prompt: '42',
    trim: '85',
    seed: '86',
    output: '65',
  },
} as const;

export const WORKFLOW_PATHS = {
  text: {
    image: `${WORKFLOW_NODES.text.image}.inputs.image`,
    prompt: `${WORKFLOW_NODES.text.prompt}.inputs.prompt`,
    duration: `${WORKFLOW_NODES.text.duration}.inputs.value`,
    seed: `${WORKFLOW_NODES.text.seed}.inputs.seed`,
    output: `${WORKFLOW_NODES.text.output}.inputs.filename_prefix`,
  },
  audio: {
    image: `${WORKFLOW_NODES.audio.image}.inputs.image`,
    audio: `${WORKFLOW_NODES.audio.audio}.inputs.audio`,
    prompt: `${WORKFLOW_NODES.audio.prompt}.inputs.prompt`,
    trimStart: `${WORKFLOW_NODES.audio.trim}.inputs.start_index`,
    trimDuration: `${WORKFLOW_NODES.audio.trim}.inputs.duration`,
    seed: `${WORKFLOW_NODES.audio.seed}.inputs.seed`,
    output: `${WORKFLOW_NODES.audio.output}.inputs.filename_prefix`,
  },
} as const;

export const ALLOWED_WORKFLOW_PATHS: ReadonlySet<string> = new Set([
  ...Object.values(WORKFLOW_PATHS.text),
  ...Object.values(WORKFLOW_PATHS.audio),
]);
