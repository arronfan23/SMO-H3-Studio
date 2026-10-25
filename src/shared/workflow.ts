export function buildH3Frames(seconds: number, tail: boolean): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('Duration must be positive');
  }

  const frames = Math.max(5, Math.round(seconds * 24));
  const gridOffset = (5 - (frames % 17) + 17) % 17;

  return frames + gridOffset + (tail ? 48 : 0);
}

const ALLOWED_PATHS = new Set([
  '36.inputs.image',
  '34.inputs.audio',
  '42.inputs.prompt',
  '136.inputs.prompt',
  '132.inputs.value',
  '85.inputs.start_index',
  '85.inputs.duration',
  '86.inputs.seed',
  '269.inputs.seed',
  '65.inputs.filename_prefix',
  '180.inputs.filename_prefix',
]);

type WorkflowNode = {
  inputs: Record<string, unknown>;
};

export function patchWorkflow<T extends Record<string, WorkflowNode>>(
  graph: T,
  changes: Record<string, unknown>,
): T {
  for (const path of Object.keys(changes)) {
    if (!ALLOWED_PATHS.has(path)) {
      throw new Error(`Workflow path not allowed: ${path}`);
    }
  }

  const copy = structuredClone(graph);

  for (const [path, value] of Object.entries(changes)) {
    const [id, , field] = path.split('.');
    const node = copy[id];

    if (!node) {
      throw new Error(`Missing workflow node: ${id}`);
    }

    node.inputs[field] = value;
  }

  return copy;
}
