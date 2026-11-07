export type SparkAcceleration = 'none' | 'spark-sm89' | 'spark-sm120';

export interface SparkAccelerationEnvironment {
  runtimeId?: 'sm89' | 'sm120';
  hardwareFingerprint?: { cudaComputeCapability: string };
}

type WorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};
type WorkflowGraph = Record<string, WorkflowNode>;
type ModelLink = [string, number];

export function selectSparkAcceleration(
  environment?: SparkAccelerationEnvironment,
): SparkAcceleration {
  const runtimeId = environment?.runtimeId;
  const capability = environment?.hardwareFingerprint?.cudaComputeCapability;
  if (runtimeId === 'sm120' && capability === '12.0') return 'spark-sm120';
  if (runtimeId === 'sm89' && capability === '8.9') return 'spark-sm89';
  return 'none';
}

function findSingleNode(graph: WorkflowGraph, classType: string): WorkflowNode {
  const nodes = Object.values(graph).filter((node) => node.class_type === classType);
  if (nodes.length !== 1) {
    throw new Error(
      `Spark acceleration requires exactly one ${classType} node; found ${nodes.length}`,
    );
  }
  return nodes[0];
}

function readModelLink(value: unknown): ModelLink {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    value[0].length === 0 ||
    !Number.isSafeInteger(value[1]) ||
    (value[1] as number) < 0
  ) {
    throw new Error('Spark acceleration requires a valid sampler model link');
  }
  return [value[0], value[1] as number];
}

export function applySparkAcceleration<T extends WorkflowGraph>(
  graph: T,
  acceleration: SparkAcceleration,
): T {
  const copy = structuredClone(graph);
  if (acceleration === 'none' || copy.smo_spark !== undefined) return copy;

  const sampler = findSingleNode(copy, 'SelfLiftAvatarH3Sampler');
  const scheduler = findSingleNode(copy, 'BasicScheduler');
  const originalModelLink = readModelLink(sampler.inputs.low_res_model);
  const steps = scheduler.inputs.steps;
  if (!Number.isSafeInteger(steps) || (steps as number) <= 0) {
    throw new Error('Spark acceleration requires positive integer scheduler steps');
  }

  // Apply Spark last so existing low-VRAM model patches cannot replace it.
  copy.smo_spark = {
    class_type:
      acceleration === 'spark-sm120'
        ? 'MiniMaxH3SparkAttentionSM120'
        : 'MiniMaxH3SparkAttentionSM89',
    inputs: {
      model: originalModelLink,
      enabled: true,
      steps,
      warmup_mode: 'warmup_ratio',
      warmup_ratio: 0.25,
      warmup_steps: 1,
      topk_mode: 'topk_ratio',
      topk_ratio: 0.2,
      topk_blocks: 228,
      dense_layers: 0,
      min_tokens: 12288,
      strict: true,
      tail_granularity: 'query',
      reblock_layout: 'q_reuse_k',
    },
  };
  sampler.inputs.low_res_model = ['smo_spark', 0];
  scheduler.inputs.model = ['smo_spark', 0];
  return copy;
}
