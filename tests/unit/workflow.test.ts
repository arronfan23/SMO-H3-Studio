// @vitest-environment node

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildH3Frames, patchWorkflow } from '../../src/shared/workflow';
import { WORKFLOW_NODES } from '../../src/shared/workflow-nodes';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

type ApiNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};

type ApiGraph = Record<string, ApiNode>;

type WorkflowConverter = (
  workflow: unknown,
  outputId: number | string,
  overrides?: Record<string, Record<string, unknown>>,
) => ApiGraph;

async function loadWorkflowConverter(): Promise<WorkflowConverter> {
  const modulePath = join(projectRoot, 'scripts/build-workflows.mjs');
  expect(existsSync(modulePath), 'workflow builder should exist').toBe(true);

  const module = (await import(pathToFileURL(modulePath).href)) as {
    toApiGraph: WorkflowConverter;
  };

  return module.toApiGraph;
}

async function readApiGraph(filename: string): Promise<ApiGraph> {
  const graphPath = join(projectRoot, 'resources/workflows', filename);
  expect(existsSync(graphPath), `${filename} should be generated`).toBe(true);

  return JSON.parse(await readFile(graphPath, 'utf8')) as ApiGraph;
}

function isApiLink(value: unknown): value is [string, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    Number.isInteger(value[1])
  );
}

function expectOnlyReachableNodes(graph: ApiGraph, outputId: string): void {
  const reachable = new Set<string>();

  function visit(id: string): void {
    if (reachable.has(id)) return;

    const node = graph[id];
    expect(node, `link source node ${id} should exist`).toBeDefined();
    reachable.add(id);

    for (const value of Object.values(node.inputs)) {
      if (isApiLink(value)) visit(value[0]);
    }
  }

  visit(outputId);
  expect(Object.keys(graph).sort()).toEqual([...reachable].sort());
}

function createLinkedWorkflowFixture() {
  return {
    nodes: [
      {
        id: 1,
        type: 'PrimitiveFloat',
        mode: 0,
        inputs: [],
        widgets_values_named: {
          value: 3,
          labels: ['one', 'two'],
          range: [1, 2],
          metadata: ['not-a-node', 0, 'not-a-link'],
        },
      },
      {
        id: 2,
        type: 'VHS_VideoCombine',
        mode: 0,
        inputs: [{ name: 'value', type: 'FLOAT', link: 7 }],
        widgets_values_named: {
          value: 99,
          frame_rate: 24,
          upload: 'image',
          preview: 'UI preview state',
          videopreview: { fullpath: 'F:\\old\\preview.mp4' },
          selflift_tiling_plan: 'UI state',
          control_after_generate: 'fixed',
        },
      },
    ],
    links: [[7, 1, 0, 2, 0, 'FLOAT']],
  };
}

function createDirectOverrideFixture(links: unknown[] = []) {
  return {
    nodes: [
      {
        id: 2,
        type: 'MiniMaxH3ReferenceToVideo',
        mode: 0,
        inputs: [{ name: 'prompt', type: 'STRING', link: 99 }],
        widgets_values_named: { prompt: '' },
      },
    ],
    links,
  };
}

describe('buildH3Frames', () => {
  test('adds the 48 frame audio tail after aligning to the H3 grid', () => {
    expect(buildH3Frames(10, true)).toBe(291);
    expect(buildH3Frames(12, true)).toBe(342);
  });

  test('uses 24 fps and rounds up to the next 17k+5 frame', () => {
    expect(buildH3Frames(0.01, false)).toBe(5);
    expect(buildH3Frames(22 / 24, false)).toBe(22);
    expect(buildH3Frames(23 / 24, false)).toBe(39);
    expect(buildH3Frames(10, false)).toBe(243);
    expect(buildH3Frames(12, false)).toBe(294);
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid duration %s',
    (seconds) => {
      expect(() => buildH3Frames(seconds, false)).toThrow('Duration must be positive');
    },
  );
});

describe('patchWorkflow', () => {
  test('accepts every runtime media, prompt, timing, seed, and output path', () => {
    const graph = {
      '34': { class_type: 'LoadAudio', inputs: { audio: 'old.mp3' } },
      '36': { class_type: 'LoadImage', inputs: { image: 'old.png' } },
      '42': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { prompt: '' } },
      '65': { class_type: 'VHS_VideoCombine', inputs: { filename_prefix: 'old' } },
      '85': {
        class_type: 'TrimAudioDuration',
        inputs: { start_index: 0, duration: 1 },
      },
      '86': { class_type: 'SelfLiftAvatarH3Sampler', inputs: { seed: 1 } },
      '132': { class_type: 'PrimitiveFloat', inputs: { value: 1 } },
      '136': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { prompt: '' } },
      '180': { class_type: 'VHS_VideoCombine', inputs: { filename_prefix: 'old' } },
      '226': { class_type: 'LoadImage', inputs: { image: 'old-text.png' } },
      '269': { class_type: 'SelfLiftAvatarH3Sampler', inputs: { seed: 1 } },
    };

    const patched = patchWorkflow(graph, {
      '34.inputs.audio': 'voice.mp3',
      '36.inputs.image': 'avatar.png',
      '42.inputs.prompt': 'Audio prompt',
      '65.inputs.filename_prefix': 'audio-output',
      '85.inputs.duration': 8,
      '85.inputs.start_index': 48,
      '86.inputs.seed': 101,
      '132.inputs.value': 12,
      '136.inputs.prompt': 'Text prompt',
      '180.inputs.filename_prefix': 'text-output',
      '226.inputs.image': 'text-avatar.png',
      '269.inputs.seed': 202,
    });

    expect(patched).toMatchObject({
      '34': { inputs: { audio: 'voice.mp3' } },
      '36': { inputs: { image: 'avatar.png' } },
      '42': { inputs: { prompt: 'Audio prompt' } },
      '65': { inputs: { filename_prefix: 'audio-output' } },
      '85': { inputs: { duration: 8, start_index: 48 } },
      '86': { inputs: { seed: 101 } },
      '132': { inputs: { value: 12 } },
      '136': { inputs: { prompt: 'Text prompt' } },
      '180': { inputs: { filename_prefix: 'text-output' } },
      '226': { inputs: { image: 'text-avatar.png' } },
      '269': { inputs: { seed: 202 } },
    });
  });

  test('returns a deep copy and leaves the source graph unchanged', () => {
    const graph = {
      '36': { class_type: 'LoadImage', inputs: { image: 'old.png' } },
      '65': {
        class_type: 'VHS_VideoCombine',
        inputs: { filename_prefix: 'old', format: { name: 'video/h264-mp4' } },
      },
    };

    const patched = patchWorkflow(graph, { '36.inputs.image': 'new.png' });

    expect(patched).not.toBe(graph);
    expect(patched['36']).not.toBe(graph['36']);
    expect(patched['65']).not.toBe(graph['65']);
    expect(patched['65'].inputs.format).not.toBe(graph['65'].inputs.format);
    expect(graph['36'].inputs.image).toBe('old.png');
    expect(patched['36'].inputs.image).toBe('new.png');
  });

  test.each([
    '55.inputs.unet_name',
    '86.inputs.cfg',
    '85.inputs.start_time',
    '136.class_type',
    '269.inputs.highres_tiling',
  ])('rejects frozen or unknown path %s', (path) => {
    const graph = {
      '55': { class_type: 'UNETLoader', inputs: { unet_name: 'int8.safetensors' } },
    };

    expect(() => patchWorkflow(graph, { [path]: 'changed' })).toThrow(
      `Workflow path not allowed: ${path}`,
    );
  });

  test('rejects a whitelisted path when its node is absent', () => {
    expect(() => patchWorkflow({}, { '36.inputs.image': 'new.png' })).toThrow(
      'Missing workflow node: 36',
    );
  });
});

describe('UI workflow conversion', () => {
  test('uses named widget values and replaces connected widgets with API links', async () => {
    const toApiGraph = await loadWorkflowConverter();

    const graph = toApiGraph(createLinkedWorkflowFixture(), 2);

    expect(graph['1'].inputs.value).toBe(3);
    expect(graph['2'].inputs.value).toEqual(['1', 0]);
    expect(graph['2'].inputs.frame_rate).toBe(24);
    for (const field of [
      'upload',
      'preview',
      'videopreview',
      'selflift_tiling_plan',
      'control_after_generate',
    ]) {
      expect(graph['2'].inputs).not.toHaveProperty(field);
    }
  });

  test('does not mistake ordinary widget arrays for node links', async () => {
    const toApiGraph = await loadWorkflowConverter();

    const graph = toApiGraph(createLinkedWorkflowFixture(), 2);

    expect(graph['1'].inputs).toMatchObject({
      labels: ['one', 'two'],
      range: [1, 2],
      metadata: ['not-a-node', 0, 'not-a-link'],
    });
  });

  test('only traverses real input links when a widget looks like an API link', async () => {
    const toApiGraph = await loadWorkflowConverter();
    const fixture = {
      nodes: [
        {
          id: 1,
          type: 'Unexpected',
          mode: 0,
          inputs: [],
          widgets_values_named: {},
        },
        {
          id: 2,
          type: 'PrimitiveFloat',
          mode: 0,
          inputs: [],
          widgets_values_named: { value: 7 },
        },
        {
          id: 3,
          type: 'Sink',
          mode: 0,
          inputs: [{ name: 'connected', type: 'FLOAT', link: 9 }],
          widgets_values_named: { connected: 99, ordinary: ['1', 0] },
        },
      ],
      links: [[9, 2, 0, 3, 0, 'FLOAT']],
    };

    const graph = toApiGraph(fixture, 3);

    expect(graph['3'].inputs.ordinary).toEqual(['1', 0]);
    expect(graph['3'].inputs.connected).toEqual(['2', 0]);
    expect(graph['2'].inputs.value).toBe(7);
    expect(graph).not.toHaveProperty('1');
    expect(Object.keys(graph).sort()).toEqual(['2', '3']);
  });

  test('rejects a required node in bypass mode', async () => {
    const toApiGraph = await loadWorkflowConverter();
    const fixture = createLinkedWorkflowFixture();
    fixture.nodes[0].mode = 4;

    expect(() => toApiGraph(fixture, 2)).toThrow('Required node 1 is bypassed');
  });

  test('applies direct prompt overrides before following links', async () => {
    const toApiGraph = await loadWorkflowConverter();
    const fixture = {
      nodes: [
        {
          id: 1,
          type: 'QwenH3PromptLocal',
          mode: 0,
          inputs: [],
          widgets_values_named: { prompt: 'Local rewrite' },
        },
        {
          id: 2,
          type: 'MiniMaxH3ReferenceToVideo',
          mode: 0,
          inputs: [{ name: 'prompt', type: 'STRING', link: 9 }],
          widgets_values_named: { prompt: '', ref_image_size: 'match' },
        },
      ],
      links: [[9, 1, 0, 2, 0, 'STRING']],
    };

    const graph = toApiGraph(fixture, 2, { '2': { prompt: 'Final prompt' } });

    expect(graph['2'].inputs.prompt).toBe('Final prompt');
    expect(graph).not.toHaveProperty('1');
  });

  test('direct overrides skip dangling input links', async () => {
    const toApiGraph = await loadWorkflowConverter();

    const graph = toApiGraph(createDirectOverrideFixture(), 2, {
      '2': { prompt: 'Direct prompt' },
    });

    expect(graph['2'].inputs.prompt).toBe('Direct prompt');
    expect(Object.keys(graph)).toEqual(['2']);
  });

  test('direct overrides skip missing upstream nodes', async () => {
    const toApiGraph = await loadWorkflowConverter();
    const fixture = createDirectOverrideFixture([[99, 1, 0, 2, 0, 'STRING']]);

    const graph = toApiGraph(fixture, 2, { '2': { prompt: 'Direct prompt' } });

    expect(graph['2'].inputs.prompt).toBe('Direct prompt');
    expect(Object.keys(graph)).toEqual(['2']);
  });

  test('unoverridden dangling input links still fail validation', async () => {
    const toApiGraph = await loadWorkflowConverter();

    expect(() => toApiGraph(createDirectOverrideFixture(), 2)).toThrow('Missing link 99');
  });

  test('unoverridden missing upstream nodes still fail validation', async () => {
    const toApiGraph = await loadWorkflowConverter();
    const fixture = createDirectOverrideFixture([[99, 1, 0, 2, 0, 'STRING']]);

    expect(() => toApiGraph(fixture, 2)).toThrow('Missing node 1');
  });

  test('resolves frontend Reroute nodes to their upstream API links', async () => {
    const toApiGraph = await loadWorkflowConverter();
    const fixture = {
      nodes: [
        {
          id: 1,
          type: 'PrimitiveFloat',
          mode: 0,
          inputs: [],
          widgets_values_named: { value: 3 },
        },
        {
          id: 2,
          type: 'Reroute',
          mode: 0,
          inputs: [{ name: '', type: '*', link: 8 }],
        },
        {
          id: 3,
          type: 'Sink',
          mode: 0,
          inputs: [{ name: 'value', type: 'FLOAT', link: 9 }],
          widgets_values_named: {},
        },
      ],
      links: [
        [8, 1, 0, 2, 0, '*'],
        [9, 2, 0, 3, 0, 'FLOAT'],
      ],
    };

    const graph = toApiGraph(fixture, 3);

    expect(graph['3'].inputs.value).toEqual(['1', 0]);
    expect(graph).not.toHaveProperty('2');
    expectOnlyReachableNodes(graph, '3');
  });
});

describe('generated API workflows', () => {
  test.each([
    {
      filename: 'text-ref2va.json',
      nodes: WORKFLOW_NODES.text,
      types: {
        image: 'LoadImage',
        prompt: 'MiniMaxH3ReferenceToVideo',
        duration: 'PrimitiveFloat',
        seed: 'SelfLiftAvatarH3Sampler',
        output: 'VHS_VideoCombine',
      },
    },
    {
      filename: 'audio-digital-human.json',
      nodes: WORKFLOW_NODES.audio,
      types: {
        image: 'LoadImage',
        audio: 'LoadAudio',
        prompt: 'MiniMaxH3ReferenceToVideo',
        trim: 'TrimAudioDuration',
        seed: 'SelfLiftAvatarH3Sampler',
        output: 'VHS_VideoCombine',
      },
    },
  ])('keeps shared node ids compatible with $filename', async ({ filename, nodes, types }) => {
    const graph = await readApiGraph(filename);

    for (const [role, id] of Object.entries(nodes)) {
      expect(graph[id], `${filename} ${role} node ${id}`).toMatchObject({
        class_type: types[role as keyof typeof types],
      });
    }
  });

  test.each([
    ['text-ref2va.json', '180'],
    ['audio-digital-human.json', '65'],
  ])('%s contains only nodes reachable from its output', async (filename, outputId) => {
    const graph = await readApiGraph(filename);

    expectOnlyReachableNodes(graph, outputId);
  });

  test('text workflow keeps only the primary reference image input', async () => {
    const graph = await readApiGraph('text-ref2va.json');
    const imageNodeIds = Object.entries(graph)
      .filter(([, node]) => node.class_type === 'LoadImage')
      .map(([id]) => id);

    expect(imageNodeIds).toEqual(['226']);
    expect(graph).not.toHaveProperty('255');
    expect(graph['136'].inputs).not.toHaveProperty('ref_images.ref_image_1');
    expect(graph['136'].inputs).not.toHaveProperty('ref_images.ref_image_2');
    expect(JSON.stringify(graph)).not.toContain('9600355f787e5d893e2c2069691e9cd9.png');
  });

  test('patchWorkflow replaces the text avatar without changing frozen settings', async () => {
    const graph = await readApiGraph('text-ref2va.json');
    const originalImage = graph['226'].inputs.image;

    const patched = patchWorkflow(graph, { '226.inputs.image': 'uploads/text-avatar.png' });

    expect(patched['226'].inputs.image).toBe('uploads/text-avatar.png');
    expect(patched).not.toHaveProperty('255');
    expect(JSON.stringify(patched)).not.toContain(String(originalImage));
    expect(JSON.stringify(patched)).not.toContain('9600355f787e5d893e2c2069691e9cd9.png');
    expect(patched['127']).toEqual(graph['127']);
    expect(patched['128']).toEqual(graph['128']);
    expect(patched['194']).toEqual(graph['194']);
    expect(patched['269']).toEqual(graph['269']);
    expect(graph['226'].inputs.image).toBe(originalImage);
  });

  test('patchWorkflow replaces the audio avatar without changing frozen settings', async () => {
    const graph = await readApiGraph('audio-digital-human.json');
    const originalImage = graph['36'].inputs.image;

    const patched = patchWorkflow(graph, { '36.inputs.image': 'uploads/audio-avatar.png' });

    expect(patched['36'].inputs.image).toBe('uploads/audio-avatar.png');
    expect(JSON.stringify(patched)).not.toContain(String(originalImage));
    expect(patched['55']).toEqual(graph['55']);
    expect(patched['54']).toEqual(graph['54']);
    expect(patched['53']).toEqual(graph['53']);
    expect(patched['86']).toEqual(graph['86']);
    expect(graph['36'].inputs.image).toBe(originalImage);
  });

  test('text workflow uses direct prompts and the standard audio/video decoders', async () => {
    const graph = await readApiGraph('text-ref2va.json');
    const classTypes = Object.values(graph).map((node) => node.class_type);

    expect(graph['136'].inputs.prompt).toBe('');
    expect(classTypes).toEqual(
      expect.arrayContaining([
        'MiniMaxH3ReferenceToVideo',
        'SelfLiftAvatarH3Sampler',
        'VAEDecode',
        'VAEDecodeAudio',
      ]),
    );
  });

  test('text workflow applies the RTX 5080 16GB model configuration', async () => {
    const graph = await readApiGraph('text-ref2va.json');

    expect(graph['127'].inputs).toMatchObject({
      unet_name: 'minimax_h3_hybrid_fl2va_ref2va_b30-49-int8.safetensors',
    });
    expect(graph['128'].inputs).toMatchObject({
      clip_name:
        'MiniMax-H3\\qwen3vl_32b_minimax_h3_ultra_uncensored_heretic_int8_convrot.safetensors',
    });
    expect(graph['184'].inputs.vae_name).toBe('minimax_h3_audio_vae_fp32.safetensors');
    expect(graph['194'].inputs.vae_name).toBe('minimax_h3_video_vae_int8_convrot.safetensors');
    expect(graph['145'].inputs.lora_name).toBe(
      'dmad_minimax_h3_4step_full_critic_comfy.safetensors',
    );
    expect(graph['261'].inputs.lora_name).toBe('H3_speed_slider_1.1.safetensors');
    expect(graph['115'].inputs.megapixels).toBe(0.7);
    expect(graph['136'].inputs.ref_image_size).toBe('match');
    expect(graph['195'].class_type).toBe('MiniMaxChunkFeedForward');
    expect(graph['196'].class_type).toBe('MiniMaxLowVRAMAttention');
  });

  test('audio workflow retains its confirmed models, sampler, and direct prompt', async () => {
    const graph = await readApiGraph('audio-digital-human.json');

    expect(graph['42'].inputs.prompt).toBe('');
    expect(graph['55'].inputs.unet_name).toBe(
      'minimax_h3_hybrid_fl2va_ref2va_b30-49-int8.safetensors',
    );
    expect(graph['54'].inputs.clip_name).toBe(
      'MiniMax-H3\\qwen3vl_32b_minimax_h3_ultra_uncensored_heretic_int8_convrot.safetensors',
    );
    expect(graph['52'].inputs.vae_name).toBe('minimax_h3_audio_vae_fp32.safetensors');
    expect(graph['53'].inputs.vae_name).toBe('minimax_h3_video_vae_int8_convrot.safetensors');
    expect(graph['56'].inputs.lora_name).toBe(
      'dmad_minimax_h3_4step_full_critic_comfy.safetensors',
    );
    expect(graph['87'].inputs.lora_name).toBe('H3_speed_slider_1.1.safetensors');
    expect(graph['58'].class_type).toBe('MiniMaxChunkFeedForward');
    expect(graph['59'].class_type).toBe('MiniMaxLowVRAMAttention');
    expect(graph['86'].inputs).toMatchObject({
      seed: 780,
      cfg: 1,
      transition_step: 4,
      lowres_scale: 0.5,
      rho: 0,
      w_min: 0.5,
      w_max: 1,
      highres_tiling: true,
      tiling_mode: 'auto',
      tiling_tiles: 4,
      tiling_axis: 'auto',
    });
  });

  test.each(['text-ref2va.json', 'audio-digital-human.json'])(
    '%s omits UI-only state, frontend helpers, old paths, and FP16 VAEs',
    async (filename) => {
      const graph = await readApiGraph(filename);
      const serialized = JSON.stringify(graph);
      const classTypes = Object.values(graph).map((node) => node.class_type);

      for (const forbidden of [
        'MiniMaxH3VAEDecodeFast',
        'RAMCleanup',
        'QwenH3PromptLocal',
        'PreviewAny',
        'Fast Groups Bypasser (rgthree)',
      ]) {
        expect(classTypes).not.toContain(forbidden);
      }

      for (const node of Object.values(graph)) {
        for (const field of [
          'upload',
          'preview',
          'videopreview',
          'selflift_tiling_plan',
          'control_after_generate',
        ]) {
          expect(node.inputs).not.toHaveProperty(field);
        }
        expect(node.class_type).not.toContain('rgthree');
        if (node.class_type === 'VAELoader') {
          expect(node.inputs.vae_name).not.toMatch(/fp16/i);
        }
      }

      expect(serialized).not.toMatch(/[A-Za-z]:[\\/]{2}/);
      expect(serialized).not.toContain('F:\\\\');
    },
  );

  test('audio trimming exposes start_index and duration controls', async () => {
    const graph = await readApiGraph('audio-digital-human.json');

    expect(graph['85']).toMatchObject({
      class_type: 'TrimAudioDuration',
      inputs: {
        audio: ['34', 0],
        start_index: 0,
        duration: 21,
      },
    });
    expect(graph['85'].inputs).not.toHaveProperty('start_time');
  });

  test.each([
    ['text-ref2va.json', '180', 'selflift'],
    ['audio-digital-human.json', '65', 'selfliftAvatar'],
  ])('%s preserves video output settings without videopreview', async (filename, id, prefix) => {
    const graph = await readApiGraph(filename);

    expect(graph[id].inputs).toMatchObject({
      frame_rate: 24,
      loop_count: 0,
      filename_prefix: prefix,
      format: 'video/h264-mp4',
      pix_fmt: 'yuv420p',
      crf: 12,
      save_metadata: true,
      trim_to_audio: false,
      pingpong: false,
      save_output: true,
    });
    expect(graph[id].inputs).not.toHaveProperty('videopreview');
  });
});
