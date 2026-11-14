import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { applySparkAcceleration } from '../src/main/spark-acceleration.ts';

const args = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (!match) throw new Error(`Invalid argument: ${argument}`);
    return [match[1], match[2]];
  }),
);
const mode = args.mode;
if (!['baseline', 'spark', 'audio-spark'].includes(mode)) {
  throw new Error('Use --mode=baseline, --mode=spark, or --mode=audio-spark');
}
if (!args.image) throw new Error('--image=PATH is required');
if (mode === 'audio-spark' && !args.audio) {
  throw new Error('--audio=PATH is required for audio-spark');
}

const baseUrl = process.env.SMO_COMFY_URL ?? 'http://127.0.0.1:8188';
const duration = 10;
const megapixels = 1.2;
const seed = args.seed === undefined ? 42 : Number(args.seed);
if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('--seed must be a nonnegative integer');
const acceleration = mode === 'baseline' ? 'none' : 'spark-sm120';
const workflowName = mode === 'audio-spark' ? 'audio-digital-human.json' : 'text-ref2va.json';
const workflow = JSON.parse(
  await readFile(new URL(`../resources/workflows/${workflowName}`, import.meta.url), 'utf8'),
);

async function fetchJson(path, init) {
  const response = await fetch(new URL(path, baseUrl), init);
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`ComfyUI returned non-JSON data for ${path}`);
  }
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  return value;
}

async function upload(path) {
  const bytes = await readFile(path);
  const form = new FormData();
  form.append('type', 'input');
  form.append('image', new Blob([bytes]), basename(path));
  const result = await fetchJson('/upload/image', { method: 'POST', body: form });
  const name = result.name ?? result.filename;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('ComfyUI upload did not return a filename');
  }
  return name;
}

const queue = await fetchJson('/queue');
if ((queue.queue_running?.length ?? 0) > 0 || (queue.queue_pending?.length ?? 0) > 0) {
  throw new Error('ComfyUI queue is busy; refusing to add a benchmark task');
}

const image = await upload(args.image);
if (mode === 'audio-spark') {
  const audio = await upload(args.audio);
  workflow['34'].inputs.audio = audio;
  workflow['36'].inputs.image = image;
  workflow['42'].inputs.prompt = 'Natural subtle motion and synchronized lip movement.';
  workflow['61'].inputs.megapixels = megapixels;
  workflow['85'].inputs.start_index = 0;
  workflow['85'].inputs.duration = duration;
  workflow['86'].inputs.seed = seed;
  workflow['65'].inputs.filename_prefix = `SMO-H3/benchmark-${mode}-${Date.now()}`;
} else {
  workflow['226'].inputs.image = image;
  workflow['136'].inputs.prompt = 'A clean geometric test pattern with subtle camera motion.';
  workflow['115'].inputs.megapixels = megapixels;
  workflow['132'].inputs.value = duration;
  workflow['269'].inputs.seed = seed;
  workflow['180'].inputs.filename_prefix = `SMO-H3/benchmark-${mode}-${Date.now()}`;
}

const submittedGraph = applySparkAcceleration(workflow, acceleration);
const startedAt = Date.now();
const submitted = await fetchJson('/prompt', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: submittedGraph }),
});
if (typeof submitted.prompt_id !== 'string') throw new Error('Missing prompt_id');
if (Object.keys(submitted.node_errors ?? {}).length > 0) {
  throw new Error(`ComfyUI rejected the workflow: ${JSON.stringify(submitted.node_errors)}`);
}
console.log(JSON.stringify({ event: 'submitted', mode, promptId: submitted.prompt_id, duration, megapixels, seed }));

for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const history = await fetchJson(`/history/${submitted.prompt_id}`);
  const entry = history[submitted.prompt_id];
  if (!entry) continue;
  const status = entry.status?.status_str;
  if (status !== 'success' && status !== 'error') continue;
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  if (status === 'error') {
    throw new Error(`ComfyUI benchmark failed after ${elapsedSeconds.toFixed(1)} seconds`);
  }
  console.log(JSON.stringify({
    event: 'completed',
    mode,
    promptId: submitted.prompt_id,
    elapsedSeconds,
    elapsedMinutes: elapsedSeconds / 60,
    outputNodes: Object.keys(entry.outputs ?? {}),
  }));
  break;
}
