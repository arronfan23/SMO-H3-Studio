import { resolveReferenceResolution } from '../shared/resolution';

export interface ImageWorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

export type ImageWorkflowGraph = Record<string, ImageWorkflowNode>;

export interface QwenImagePatchOptions {
  prompt: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
}

export interface QwenImageNodeIds {
  unet: string;
  text: string;
  clip: string;
  vae: string;
  latent: string;
  decode: string;
  sampler: string;
  output: string;
  cache: string;
}

function findUniqueNodeId(graph: ImageWorkflowGraph, classType: string): string {
  const matches = Object.entries(graph).filter(([, node]) => node.class_type === classType);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${classType} node, found ${matches.length}`);
  }
  return matches[0][0];
}

function validateDimension(name: 'width' | 'height', value: number): void {
  if (!Number.isInteger(value) || value < 256 || value > 4096 || value % 32 !== 0) {
    throw new Error(`${name} must be an integer from 256 to 4096 and a multiple of 32`);
  }
}

function validateOptions(options: QwenImagePatchOptions): void {
  validateDimension('width', options.width);
  validateDimension('height', options.height);
  if (!Number.isInteger(options.steps) || options.steps < 1 || options.steps > 100) {
    throw new Error('steps must be an integer from 1 to 100');
  }
  if (!Number.isSafeInteger(options.seed) || options.seed < 0) {
    throw new Error('seed must be a non-negative safe integer');
  }
}

export function patchQwenImageWorkflow(
  source: ImageWorkflowGraph,
  options: QwenImagePatchOptions,
): { graph: ImageWorkflowGraph; nodeIds: QwenImageNodeIds } {
  validateOptions(options);

  const nodeIds: QwenImageNodeIds = {
    unet: findUniqueNodeId(source, 'UNETLoader'),
    text: findUniqueNodeId(source, 'TextEncodeQwenImage21'),
    clip: findUniqueNodeId(source, 'CLIPLoader'),
    vae: findUniqueNodeId(source, 'VAELoader'),
    latent: findUniqueNodeId(source, 'EmptyLatentImage'),
    decode: findUniqueNodeId(source, 'VAEDecode'),
    sampler: findUniqueNodeId(source, 'KSampler'),
    output: findUniqueNodeId(source, 'SaveImageAdvanced'),
    cache: findUniqueNodeId(source, 'QwenImage21Cache'),
  };
  const graph = structuredClone(source);

  graph[nodeIds.text].inputs.prompt = options.prompt;
  graph[nodeIds.latent].inputs.width = options.width;
  graph[nodeIds.latent].inputs.height = options.height;
  graph[nodeIds.sampler].inputs.seed = options.seed;
  graph[nodeIds.sampler].inputs.steps = options.steps;

  return { graph, nodeIds };
}

export function patchQwenReferenceImageWorkflow(
  source: ImageWorkflowGraph,
  options: QwenImagePatchOptions,
  uploadedNames: string[],
): { graph: ImageWorkflowGraph; nodeIds: QwenImageNodeIds } {
  if (uploadedNames.length < 1 || uploadedNames.length > 4) {
    throw new RangeError('uploadedNames must contain between 1 and 4 image names');
  }
  if (uploadedNames.some((name) => typeof name !== 'string' || name.trim().length === 0)) {
    throw new Error('uploadedNames must contain only non-empty image names');
  }

  const referenceIds = uploadedNames.map((_, index) => `ref${index + 1}`);
  for (const id of referenceIds) {
    if (Object.prototype.hasOwnProperty.call(source, id)) {
      throw new Error(`Reference image node id ${id} already exists`);
    }
  }

  const { graph, nodeIds } = patchQwenImageWorkflow(source, options);
  for (const [index, uploadedName] of uploadedNames.entries()) {
    const id = referenceIds[index];
    graph[id] = { class_type: 'LoadImage', inputs: { image: uploadedName } };
    graph[nodeIds.text].inputs[`images.image_${index + 1}`] = [id, 0];
  }

  graph[nodeIds.text].inputs.vae = [nodeIds.vae, 0];
  graph[nodeIds.text].inputs.resolution = resolveReferenceResolution(
    options.width,
    options.height,
  );
  graph[nodeIds.sampler].inputs.latent_image = [nodeIds.text, 2];

  return { graph, nodeIds };
}
