export const WORKFLOW_NODES = {
  text: {
    image: '226',
    prompt: '136',
    duration: '132',
    seed: '269',
    steps: '124',
    sigmaRefiner: '147',
    output: '180',
  },
  audio: {
    image: '36',
    audio: '34',
    prompt: '42',
    trim: '85',
    seed: '86',
    steps: '51',
    output: '65',
  },
} as const;

export const WORKFLOW_PATHS = {
  text: {
    image: `${WORKFLOW_NODES.text.image}.inputs.image`,
    prompt: `${WORKFLOW_NODES.text.prompt}.inputs.prompt`,
    duration: `${WORKFLOW_NODES.text.duration}.inputs.value`,
    seed: `${WORKFLOW_NODES.text.seed}.inputs.seed`,
    steps: `${WORKFLOW_NODES.text.steps}.inputs.steps`,
    transitionStep: `${WORKFLOW_NODES.text.seed}.inputs.transition_step`,
    sigmaRefinerStart: `${WORKFLOW_NODES.text.sigmaRefiner}.inputs.start_at_sigma`,
    output: `${WORKFLOW_NODES.text.output}.inputs.filename_prefix`,
  },
  audio: {
    image: `${WORKFLOW_NODES.audio.image}.inputs.image`,
    audio: `${WORKFLOW_NODES.audio.audio}.inputs.audio`,
    prompt: `${WORKFLOW_NODES.audio.prompt}.inputs.prompt`,
    trimStart: `${WORKFLOW_NODES.audio.trim}.inputs.start_index`,
    trimDuration: `${WORKFLOW_NODES.audio.trim}.inputs.duration`,
    seed: `${WORKFLOW_NODES.audio.seed}.inputs.seed`,
    steps: `${WORKFLOW_NODES.audio.steps}.inputs.steps`,
    transitionStep: `${WORKFLOW_NODES.audio.seed}.inputs.transition_step`,
    output: `${WORKFLOW_NODES.audio.output}.inputs.filename_prefix`,
  },
} as const;

export const ALLOWED_WORKFLOW_PATHS: ReadonlySet<string> = new Set([
  ...Object.values(WORKFLOW_PATHS.text),
  ...Object.values(WORKFLOW_PATHS.audio),
]);

type WorkflowGraph = Record<
  string,
  { class_type: string; inputs: Record<string, unknown> }
>;

export function createNoReferenceTextWorkflow<T extends WorkflowGraph>(source: T): T {
  const promptId = WORKFLOW_NODES.text.prompt;
  const promptNode = source[promptId];
  if (!promptNode) {
    throw new Error(`Missing workflow node: ${promptId}`);
  }
  const { clip, vae, prompt, width, height, length } = promptNode.inputs;
  const copy: WorkflowGraph = {
    ...source,
    [promptId]: {
      ...promptNode,
      class_type: 'MiniMaxH3ImageToVideo',
      inputs: { clip, vae, prompt, width, height, length },
    },
  };
  delete copy[WORKFLOW_NODES.text.image];
  return copy as T;
}
