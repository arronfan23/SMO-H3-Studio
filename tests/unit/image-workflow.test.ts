// @vitest-environment node

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  patchQwenImageWorkflow,
  patchQwenReferenceImageWorkflow,
  type ImageWorkflowGraph,
  type QwenImagePatchOptions,
} from '../../src/main/image-workflow';
import { DEFAULT_IMAGE_OPTIONS } from '../../src/shared/image-options';

const frozen = JSON.parse(
  readFileSync(
    new URL('../../resources/workflows/qwen-image-2-1.json', import.meta.url),
    'utf8',
  ),
) as ImageWorkflowGraph;

const validOptions: QwenImagePatchOptions = {
  prompt: '测试画面',
  ...DEFAULT_IMAGE_OPTIONS,
};

const requiredClassTypes = [
  'UNETLoader',
  'TextEncodeQwenImage21',
  'CLIPLoader',
  'VAELoader',
  'EmptyLatentImage',
  'VAEDecode',
  'KSampler',
  'QwenImage21Cache',
  'SaveImageAdvanced',
] as const;

function frozenGraph(): ImageWorkflowGraph {
  return structuredClone(frozen);
}

function findNodeId(graph: ImageWorkflowGraph, classType: string): string {
  const id = Object.keys(graph).find((candidate) => graph[candidate].class_type === classType);
  if (id === undefined) throw new Error(`Test fixture has no ${classType} node`);
  return id;
}

function renameNodes(graph: ImageWorkflowGraph): ImageWorkflowGraph {
  const names: Record<string, string> = {
    UNETLoader: 'unet',
    TextEncodeQwenImage21: 'text',
    CLIPLoader: 'clip',
    VAELoader: 'vae',
    EmptyLatentImage: 'latent',
    VAEDecode: 'decode',
    KSampler: 'sampler',
    QwenImage21Cache: 'cache',
    SaveImageAdvanced: 'output',
  };
  const ids = Object.fromEntries(
    Object.entries(graph).map(([id, node]) => [id, names[node.class_type]]),
  );

  return Object.fromEntries(
    Object.entries(graph).map(([id, node]) => [
      ids[id],
      {
        ...node,
        inputs: Object.fromEntries(
          Object.entries(node.inputs).map(([name, value]) => [
            name,
            Array.isArray(value) && value.length === 2 && typeof value[0] === 'string'
              ? [ids[value[0]], value[1]]
              : value,
          ]),
        ),
      },
    ]),
  );
}

function inputNodeIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number') {
      return [value[0]];
    }
    return value.flatMap(inputNodeIds);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(inputNodeIds);
  }
  return [];
}

function reachableNodeIds(graph: ImageWorkflowGraph, start: string): Set<string> {
  const reached = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    pending.push(...inputNodeIds(graph[id].inputs));
  }
  return reached;
}

describe('frozen Qwen Image 2.1 API graph', () => {
  test('contains only the official standard nodes with adjustable defaults', () => {
    expect(Object.values(frozen).map((node) => node.class_type).sort()).toEqual(
      [...requiredClassTypes].sort(),
    );
    expect(DEFAULT_IMAGE_OPTIONS).toEqual({
      width: 1024,
      height: 1024,
      seed: 42,
      steps: 25,
    });

    const sampler = frozen[findNodeId(frozen, 'KSampler')];
    const latent = frozen[findNodeId(frozen, 'EmptyLatentImage')];
    expect(sampler.inputs).toMatchObject({
      seed: 42,
      steps: 25,
      cfg: 1,
      sampler_name: 'euler',
      scheduler: 'simple',
      denoise: 1,
    });
    expect(latent.inputs).toEqual({ width: 1024, height: 1024, batch_size: 1 });
  });

  test('keeps the complete official model, conditioning, sampling, and decode links', () => {
    const id = (classType: string) => findNodeId(frozen, classType);

    expect(frozen[id('QwenImage21Cache')].inputs).toEqual({
      model: [id('UNETLoader'), 0],
      device: 'auto',
      dtype: 'default',
    });
    expect(frozen[id('TextEncodeQwenImage21')].inputs).toEqual({
      clip: [id('CLIPLoader'), 0],
      prompt: '',
      negative_prompt: '',
      resolution: 1024,
    });
    expect(frozen[id('KSampler')].inputs).toMatchObject({
      model: [id('QwenImage21Cache'), 0],
      positive: [id('TextEncodeQwenImage21'), 0],
      negative: [id('TextEncodeQwenImage21'), 1],
      latent_image: [id('EmptyLatentImage'), 0],
    });
    expect(frozen[id('VAEDecode')].inputs).toEqual({
      samples: [id('KSampler'), 0],
      vae: [id('VAELoader'), 0],
    });
    expect(frozen[id('SaveImageAdvanced')].inputs.images).toEqual([id('VAEDecode'), 0]);
  });

  test('saves PNG without the optional Qwen3.5 prompt enhancement branch', () => {
    const output = frozen[findNodeId(frozen, 'SaveImageAdvanced')];
    const serialized = JSON.stringify(frozen);

    expect(output.inputs).toMatchObject({
      filename_prefix: 'SMO-Image',
      format: 'png',
      'format.bit_depth': '8-bit',
      'format.input_color_space': 'sRGB',
    });
    expect(serialized).not.toContain('qwen3.5');
    for (const classType of [
      'TextGenerate',
      'ComfySwitchNode',
      'PreviewAny',
      'PrimitiveStringMultiline',
    ]) {
      expect(Object.values(frozen).map((node) => node.class_type)).not.toContain(classType);
    }
    for (const node of Object.values(frozen)) {
      expect(Object.keys(node).sort()).toEqual(['class_type', 'inputs']);
      expect(node.inputs).not.toHaveProperty('control_after_generate');
    }
  });
});

describe('patchQwenImageWorkflow', () => {
  test('writes prompt, dimensions, seed, and steps to the unique correct nodes', () => {
    const source = frozenGraph();
    const before = structuredClone(source);
    const { graph, nodeIds } = patchQwenImageWorkflow(source, {
      ...validOptions,
      steps: 30,
    });

    expect(graph[nodeIds.sampler].inputs).toMatchObject({
      seed: 42,
      steps: 30,
      cfg: 1,
      sampler_name: 'euler',
      scheduler: 'simple',
      denoise: 1,
    });
    expect(graph[nodeIds.text].inputs.prompt).toBe('测试画面');
    expect(graph[nodeIds.latent].inputs).toMatchObject({
      width: 1024,
      height: 1024,
      batch_size: 1,
    });
    expect(nodeIds).toEqual({
      unet: '451',
      text: '452',
      clip: '453',
      vae: '454',
      latent: '456',
      decode: '457',
      sampler: '458',
      output: '461',
      cache: '480',
    });
    expect(source).toEqual(before);
    expect(graph).not.toBe(source);
    expect(graph[nodeIds.sampler]).not.toBe(source[nodeIds.sampler]);
  });

  test('finds nodes by class_type after every official node id changes', () => {
    const source = renameNodes(frozenGraph());
    const { graph, nodeIds } = patchQwenImageWorkflow(source, {
      ...validOptions,
      width: 1344,
      height: 768,
      seed: 99,
      steps: 40,
    });

    expect(nodeIds).toEqual({
      unet: 'unet',
      text: 'text',
      clip: 'clip',
      vae: 'vae',
      latent: 'latent',
      decode: 'decode',
      sampler: 'sampler',
      output: 'output',
      cache: 'cache',
    });
    expect(graph.text.inputs.prompt).toBe('测试画面');
    expect(graph.latent.inputs).toMatchObject({ width: 1344, height: 768 });
    expect(graph.sampler.inputs).toMatchObject({ seed: 99, steps: 40 });
    expect(graph.sampler.inputs.model).toEqual(['cache', 0]);
    expect(graph.output.inputs.images).toEqual(['decode', 0]);
  });

  test.each(requiredClassTypes)('rejects a missing %s node', (classType) => {
    const source = frozenGraph();
    delete source[findNodeId(source, classType)];

    expect(() => patchQwenImageWorkflow(source, validOptions)).toThrow(
      `Expected exactly one ${classType} node, found 0`,
    );
  });

  test.each(requiredClassTypes)('rejects duplicate %s nodes', (classType) => {
    const source = frozenGraph();
    source.duplicate = structuredClone(source[findNodeId(source, classType)]);

    expect(() => patchQwenImageWorkflow(source, validOptions)).toThrow(
      `Expected exactly one ${classType} node, found 2`,
    );
  });

  test.each([
    ['width', 1000],
    ['width', 224],
    ['width', 4128],
    ['height', 1023],
    ['height', 0],
    ['height', 4097],
    ['height', 1024.5],
    ['width', Number.NaN],
    ['height', Number.POSITIVE_INFINITY],
  ])('rejects invalid %s value %s', (field, value) => {
    expect(() =>
      patchQwenImageWorkflow(frozenGraph(), { ...validOptions, [field]: value }),
    ).toThrow(new RegExp(field));
  });

  test.each([0, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid steps value %s',
    (steps) => {
      expect(() =>
        patchQwenImageWorkflow(frozenGraph(), { ...validOptions, steps }),
      ).toThrow(/steps/);
    },
  );

  test.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid seed value %s', (seed) => {
    expect(() => patchQwenImageWorkflow(frozenGraph(), { ...validOptions, seed })).toThrow(
      /seed/,
    );
  });

  test('accepts inclusive dimension, step, and seed boundaries', () => {
    for (const options of [
      { ...validOptions, width: 256, height: 4096, steps: 1, seed: 0 },
      {
        ...validOptions,
        width: 4096,
        height: 256,
        steps: 100,
        seed: Number.MAX_SAFE_INTEGER,
      },
    ]) {
      const { graph, nodeIds } = patchQwenImageWorkflow(frozenGraph(), options);
      expect(graph[nodeIds.latent].inputs).toMatchObject({
        width: options.width,
        height: options.height,
      });
      expect(graph[nodeIds.sampler].inputs).toMatchObject({
        steps: options.steps,
        seed: options.seed,
      });
    }
  });

  test('keeps the empty latent path when no reference images are supplied', () => {
    const { graph, nodeIds } = patchQwenImageWorkflow(frozenGraph(), validOptions);

    expect(graph[nodeIds.sampler].inputs.latent_image).toEqual([nodeIds.latent, 0]);
    expect(graph[nodeIds.text].inputs).not.toHaveProperty('images');
    expect(graph[nodeIds.text].inputs).not.toHaveProperty('vae');
  });
});

describe('patchQwenReferenceImageWorkflow', () => {
  test.each([1, 4])(
    'adds %s ordered references and preserves model, decode, and output links',
    (count) => {
      const source = frozenGraph();
      const before = structuredClone(source);
      const uploadedNames = Array.from({ length: count }, (_, index) => `image-${index + 1}.png`);
      const options = {
        ...validOptions,
        width: 1440,
        height: 1440,
        seed: 987,
        steps: 36,
      };
      const { graph, nodeIds } = patchQwenReferenceImageWorkflow(
        source,
        options,
        uploadedNames,
      );
      const expectedImages = Object.fromEntries(
        uploadedNames.map((_, index) => [`image_${index + 1}`, [`ref${index + 1}`, 0]]),
      );

      for (const [index, uploadedName] of uploadedNames.entries()) {
        expect(graph[`ref${index + 1}`]).toEqual({
          class_type: 'LoadImage',
          inputs: { image: uploadedName },
        });
      }
      expect(graph[nodeIds.text].inputs).toMatchObject({
        clip: [nodeIds.clip, 0],
        prompt: options.prompt,
        vae: [nodeIds.vae, 0],
        resolution: 1440,
      });
      expect(graph[nodeIds.text].inputs.images).toEqual(expectedImages);
      expect(Object.keys(graph[nodeIds.text].inputs.images as object)).toEqual(
        uploadedNames.map((_, index) => `image_${index + 1}`),
      );
      expect(graph[nodeIds.latent].inputs).toMatchObject({
        width: options.width,
        height: options.height,
      });
      expect(graph[nodeIds.sampler].inputs).toMatchObject({
        model: [nodeIds.cache, 0],
        positive: [nodeIds.text, 0],
        negative: [nodeIds.text, 1],
        latent_image: [nodeIds.text, 2],
        seed: options.seed,
        steps: options.steps,
      });
      expect(graph[nodeIds.cache].inputs).toEqual(before[nodeIds.cache].inputs);
      expect(graph[nodeIds.decode].inputs).toEqual(before[nodeIds.decode].inputs);
      expect(graph[nodeIds.output].inputs).toEqual(before[nodeIds.output].inputs);
      expect(reachableNodeIds(graph, nodeIds.output)).not.toContain(nodeIds.latent);
      expect(source).toEqual(before);
    },
  );

  test('uses dynamically discovered node ids', () => {
    const source = renameNodes(frozenGraph());
    const { graph, nodeIds } = patchQwenReferenceImageWorkflow(source, validOptions, [
      'reference.png',
    ]);

    expect(nodeIds.text).toBe('text');
    expect(graph.ref1).toEqual({
      class_type: 'LoadImage',
      inputs: { image: 'reference.png' },
    });
    expect(graph.text.inputs).toMatchObject({
      vae: ['vae', 0],
      resolution: 1024,
      images: { image_1: ['ref1', 0] },
    });
    expect(graph.sampler.inputs).toMatchObject({
      model: ['cache', 0],
      latent_image: ['text', 2],
    });
    expect(graph.decode.inputs).toEqual(source.decode.inputs);
    expect(graph.output.inputs).toEqual(source.output.inputs);
  });

  test('does not accumulate reference nodes across calls on the same frozen source', () => {
    const source = Object.freeze(frozenGraph());
    const before = structuredClone(source);
    const first = patchQwenReferenceImageWorkflow(source, validOptions, ['one.png', 'two.png']);
    const second = patchQwenReferenceImageWorkflow(source, validOptions, ['one.png', 'two.png']);

    expect(second.graph).toEqual(first.graph);
    expect(Object.keys(second.graph).filter((id) => /^ref[1-4]$/.test(id))).toEqual([
      'ref1',
      'ref2',
    ]);
    expect(source).toEqual(before);
  });

  test.each<{ uploadedNames: string[] }>([
    { uploadedNames: [] },
    { uploadedNames: ['one.png', 'two.png', 'three.png', 'four.png', 'five.png'] },
  ])(
    'rejects invalid uploaded image count $uploadedNames',
    ({ uploadedNames }) => {
      expect(() =>
        patchQwenReferenceImageWorkflow(frozenGraph(), validOptions, uploadedNames),
      ).toThrow(/uploadedNames/);
    },
  );

  test.each(['', '   '])('rejects empty uploaded image name %s', (emptyName) => {
    expect(() =>
      patchQwenReferenceImageWorkflow(frozenGraph(), validOptions, ['valid.png', emptyName]),
    ).toThrow(/non-empty/);
  });

  test.each(['ref1', 'ref4'])('rejects an existing %s node without overwriting it', (id) => {
    const source = frozenGraph();
    source[id] = { class_type: 'LoadImage', inputs: { image: 'existing.png' } };
    const before = structuredClone(source);

    expect(() =>
      patchQwenReferenceImageWorkflow(source, validOptions, [
        'one.png',
        'two.png',
        'three.png',
        'four.png',
      ]),
    ).toThrow(new RegExp(`${id}.*already exists`));
    expect(source).toEqual(before);
  });
});
