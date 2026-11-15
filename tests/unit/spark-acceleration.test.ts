// @vitest-environment node

import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  applySparkAcceleration,
  selectSparkAcceleration,
} from '../../src/main/spark-acceleration';

type WorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};
type WorkflowGraph = Record<string, WorkflowNode>;

let textGraph: WorkflowGraph;
let audioGraph: WorkflowGraph;

beforeAll(async () => {
  textGraph = JSON.parse(
    await readFile(
      new URL('../../resources/workflows/text-ref2va.json', import.meta.url),
      'utf8',
    ),
  ) as WorkflowGraph;
  audioGraph = JSON.parse(
    await readFile(
      new URL('../../resources/workflows/audio-digital-human.json', import.meta.url),
      'utf8',
    ),
  ) as WorkflowGraph;
});

describe('selectSparkAcceleration', () => {
  test.each([
    {
      scenario: 'RTX 50',
      runtimeId: 'sm120',
      cudaComputeCapability: '12.0',
      expected: 'spark-sm120',
    },
    {
      scenario: 'RTX 40',
      runtimeId: 'sm89',
      cudaComputeCapability: '8.9',
      expected: 'spark-sm89',
    },
    {
      scenario: 'RTX 30',
      runtimeId: 'sm89',
      cudaComputeCapability: '8.6',
      expected: 'none',
    },
    {
      scenario: 'mismatched SM120 runtime and RTX 40',
      runtimeId: 'sm120',
      cudaComputeCapability: '8.9',
      expected: 'none',
    },
  ])(
    'selects $expected for $scenario',
    ({ runtimeId, cudaComputeCapability, expected }) => {
      expect(
        selectSparkAcceleration({
          runtimeId: runtimeId as 'sm89' | 'sm120',
          hardwareFingerprint: { cudaComputeCapability },
        }),
      ).toBe(expected);
    },
  );

  test('does not accelerate without a verified hardware fingerprint', () => {
    expect(selectSparkAcceleration()).toBe('none');
    expect(selectSparkAcceleration({ runtimeId: 'sm120' })).toBe('none');
  });
});

describe('applySparkAcceleration', () => {
  test('inserts SM120 after the final text model patch and before sampling', () => {
    const accelerated = applySparkAcceleration(textGraph, 'spark-sm120');

    expect(accelerated.smo_spark).toEqual({
      class_type: 'MiniMaxH3SparkAttentionSM120',
      inputs: {
        model: ['153', 0],
        enabled: true,
        steps: 8,
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
    });
    expect(accelerated['269'].inputs.low_res_model).toEqual(['smo_spark', 0]);
    expect(accelerated['124'].inputs.model).toEqual(['smo_spark', 0]);
    expect(accelerated).not.toBe(textGraph);
    expect(accelerated['269']).not.toBe(textGraph['269']);
    expect(textGraph.smo_spark).toBeUndefined();
    expect(textGraph['269'].inputs.low_res_model).toEqual(['153', 0]);
  });

  test('uses the audio scheduler steps and final audio model patch', () => {
    const accelerated = applySparkAcceleration(audioGraph, 'spark-sm89');

    expect(accelerated.smo_spark).toMatchObject({
      class_type: 'MiniMaxH3SparkAttentionSM89',
      inputs: { model: ['62', 0], steps: 6 },
    });
    expect(accelerated['86'].inputs.low_res_model).toEqual(['smo_spark', 0]);
    expect(accelerated['51'].inputs.model).toEqual(['smo_spark', 0]);
  });

  test('returns an unchanged clone for unsupported hardware', () => {
    const accelerated = applySparkAcceleration(textGraph, 'none');

    expect(accelerated).toEqual(textGraph);
    expect(accelerated).not.toBe(textGraph);
    expect(accelerated.smo_spark).toBeUndefined();
  });

  test('does not insert Spark twice when a transformed graph is reused', () => {
    const once = applySparkAcceleration(textGraph, 'spark-sm120');
    const twice = applySparkAcceleration(once, 'spark-sm120');

    expect(twice).toEqual(once);
    expect(twice).not.toBe(once);
    expect(
      Object.values(twice).filter(
        (node) => node.class_type === 'MiniMaxH3SparkAttentionSM120',
      ),
    ).toHaveLength(1);
  });

  test('rejects a supported graph without the SelfLift sampler', () => {
    const invalid = structuredClone(textGraph);
    delete invalid['269'];

    expect(() => applySparkAcceleration(invalid, 'spark-sm120')).toThrow(
      /SelfLiftAvatarH3Sampler/i,
    );
  });

  test('rejects a non-positive scheduler step count', () => {
    const invalid = structuredClone(textGraph);
    invalid['124'].inputs.steps = 0;

    expect(() => applySparkAcceleration(invalid, 'spark-sm120')).toThrow(
      /steps/i,
    );
  });
});
