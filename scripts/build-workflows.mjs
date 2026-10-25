import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_ONLY_FIELDS = new Set([
  'upload',
  'videopreview',
  'selflift_tiling_plan',
  'control_after_generate',
]);

const TEXT_SOURCE = 'G:\\H3Selflift整合包\\工作流\\Selflift参考生视频.json';
const AUDIO_SOURCE = 'G:\\H3Selflift整合包\\工作流\\Selflift数字人_5080_16GB.json';

const TEXT_OVERRIDES = {
  '115': { megapixels: 0.7 },
  '127': {
    unet_name: 'minimax_h3_hybrid_fl2va_ref2va_b30-49-int8.safetensors',
  },
  '136': { prompt: '', ref_image_size: 'match' },
  '145': {
    lora_name: 'dmad_minimax_h3_4step_full_critic_comfy.safetensors',
  },
  '184': { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' },
  '194': { vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors' },
  '261': { lora_name: 'H3_speed_slider_1.1.safetensors' },
};

export function toApiGraph(workflow, outputId, overrides = {}) {
  const nodes = new Map(workflow.nodes.map((node) => [String(node.id), node]));
  const links = new Map(workflow.links.map((link) => [String(link[0]), link]));
  const graph = {};

  function resolveApiLink(linkId, visitedReroutes = new Set()) {
    const link = links.get(String(linkId));
    if (!link) throw new Error(`Missing link ${linkId}`);

    const sourceId = String(link[1]);
    const sourceNode = nodes.get(sourceId);
    if (!sourceNode) throw new Error(`Missing node ${sourceId}`);

    if (sourceNode.type !== 'Reroute') {
      return [sourceId, link[2]];
    }

    if (visitedReroutes.has(sourceId)) {
      throw new Error(`Reroute cycle at node ${sourceId}`);
    }
    visitedReroutes.add(sourceId);

    // Reroute only exists in the editor; carry its upstream output into the API graph.
    const input = (sourceNode.inputs ?? []).find((candidate) => candidate.link != null);
    if (!input) throw new Error(`Reroute node ${sourceId} has no input link`);

    return resolveApiLink(input.link, visitedReroutes);
  }

  function visit(id) {
    if (graph[id]) return;

    const node = nodes.get(id);
    if (!node) throw new Error(`Missing node ${id}`);
    if (node.mode === 4) throw new Error(`Required node ${id} is bypassed`);

    const nodeInputs = node.inputs ?? [];
    const linkedNames = new Set(
      nodeInputs.filter((input) => input.link != null).map((input) => input.name),
    );
    const inputs = Object.fromEntries(
      Object.entries(node.widgets_values_named ?? {}).filter(
        ([name]) => !linkedNames.has(name) && !FRONTEND_ONLY_FIELDS.has(name),
      ),
    );

    const dependencies = new Map();
    for (const input of nodeInputs) {
      if (input.link != null) {
        const apiLink = resolveApiLink(input.link);
        inputs[input.name] = apiLink;
        dependencies.set(input.name, apiLink[0]);
      }
    }

    const nodeOverrides = overrides[id] ?? {};
    Object.assign(inputs, nodeOverrides);
    for (const name of Object.keys(nodeOverrides)) dependencies.delete(name);
    for (const field of FRONTEND_ONLY_FIELDS) delete inputs[field];

    graph[id] = { class_type: node.type, inputs };

    // Only real UI connections are dependencies; direct overrides sever their input links.
    for (const dependencyId of dependencies.values()) visit(dependencyId);
  }

  visit(String(outputId));
  return graph;
}

async function readWorkflow(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function enableRequiredNodes(workflow, ids) {
  for (const id of ids) {
    const node = workflow.nodes.find((candidate) => String(candidate.id) === id);
    if (!node) throw new Error(`Missing node ${id}`);
    node.mode = 0;
  }
}

async function main() {
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const outputDirectory = resolve(projectRoot, 'resources/workflows');
  const [textWorkflow, audioWorkflow] = await Promise.all([
    readWorkflow(TEXT_SOURCE),
    readWorkflow(AUDIO_SOURCE),
  ]);

  enableRequiredNodes(textWorkflow, ['195', '196']);

  const textGraph = toApiGraph(textWorkflow, 180, TEXT_OVERRIDES);
  const audioGraph = toApiGraph(audioWorkflow, 65, { '42': { prompt: '' } });

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(outputDirectory, 'text-ref2va.json'),
      `${JSON.stringify(textGraph, null, 2)}\n`,
      'utf8',
    ),
    writeFile(
      resolve(outputDirectory, 'audio-digital-human.json'),
      `${JSON.stringify(audioGraph, null, 2)}\n`,
      'utf8',
    ),
  ]);

  console.log(`Built ${Object.keys(textGraph).length} text and ${Object.keys(audioGraph).length} audio API nodes.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
