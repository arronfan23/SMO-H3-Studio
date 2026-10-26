# SMO.H3 Studio 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 交付一个使用 SMO Logo、以 ComfyUI 为执行后端的 Electron 数字人视频桌面软件，支持照片模特、文字生视频、音频数字人、H3 Prompt Skills、外部 LLM 模型管理、作品库和硬件推荐。

**架构：** Electron 主进程负责密钥、SQLite、文件、LLM 和 ComfyUI API，React 渲染进程只通过类型化 IPC 操作。两条 API 工作流由现有 JSON 离线生成并冻结模型参数；运行时只替换白名单内容。外部 LLM 只润色文字，参考图与音频不离开本机。

**技术栈：** Electron、electron-vite、React、TypeScript、Node.js `node:sqlite`、`safeStorage`、Vitest、Testing Library、Playwright、electron-builder、Sharp。

---

## 文件结构与职责

- `package.json`、`electron.vite.config.ts`、`tsconfig*.json`：开发、构建与测试入口。
- `resources/brand/`：用户 Logo 原图、PNG 与 Windows ICO。
- `public/brand/`：供 React 界面使用的同一枚 PNG Logo。
- `resources/workflows/`：文字与音频两条 API 工作流。
- `resources/skills/`：1 个通用与 8 个风格 H3 Skills 的固定快照。
- `scripts/prepare-brand.mjs`：只缩放和转换 Logo，不改变原图内容。
- `scripts/build-workflows.mjs`：把 UI 工作流转换成可达节点组成的 API 图，并应用已确认的 16 GB 模板。
- `src/shared/types.ts`：`Avatar`、`VideoMode`、`GenerationRequest`、`LlmProfile`、`HardwareProfile` 等共享类型。
- `src/shared/workflow.ts`：H3 帧数、时长与白名单参数替换。
- `src/shared/workflow-nodes.ts`：两条冻结图的运行时节点 ID 与可修改路径单一来源。
- `src/shared/prompt-contract.ts`：Skill 输出字段、时间戳、对白和片尾校验。
- `src/main/store.ts`：SQLite 与本地文件记录。
- `src/main/secrets.ts`：基于 `safeStorage` 的密钥存取。
- `src/main/llm.ts`：上游模型列表、模型测试与润色请求。
- `src/main/skills.ts`：Skills 快照、路由、消息构建和一次修正。
- `src/main/hardware.ts`：硬件检测与规则化推荐。
- `src/main/comfy.ts`：ComfyUI 健康检查、上传、提交、进度、取消与结果读取。
- `src/main/jobs.ts`：单 GPU 队列、取消和恢复。
- `src/main/ipc.ts`、`src/preload/index.ts`：受控 IPC 边界。
- `src/renderer/`：制作台、模特、作品、设置与 SMO 视觉系统。
- `tests/unit/`：纯逻辑与服务测试。
- `tests/e2e/`：Electron 端到端和打包冒烟测试。

### 任务 1：Electron 工程与 SMO 品牌

**文件：** `package.json`、`electron.vite.config.ts`、`electron-builder.yml`、`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/main.tsx`、`scripts/prepare-brand.mjs`、`resources/brand/`、`tests/unit/smoke.test.ts`

- [ ] **步骤 1：建立工程并写入品牌冒烟测试**

```bash
npm init -y
npm install react react-dom lucide-react ws zod
npm install -D electron electron-vite vite @vitejs/plugin-react typescript vitest @types/node @types/react @types/react-dom @types/ws jsdom @testing-library/react @testing-library/jest-dom @playwright/test electron-builder sharp png-to-ico
npm pkg set type=module main=dist/main/index.js scripts.dev="electron-vite dev" scripts.build="electron-vite build" scripts.test="vitest run" scripts.test:e2e="playwright test" scripts.assets="node scripts/prepare-brand.mjs && node scripts/build-workflows.mjs" scripts.pack="npm run build && electron-builder --win portable"
```

```ts
// tests/unit/smoke.test.ts
import { expect, test } from 'vitest';
test('desktop shell has the SMO product name', () => {
  expect('SMO.H3 Studio').toBe('SMO.H3 Studio');
});
```

- [ ] **步骤 2：运行测试并准备 Logo**

```bash
mkdir -p resources/brand tests/unit scripts
Copy-Item 'C:\Users\FG\Desktop\vibecoding\logo.jpg' 'resources/brand/logo-original.jpg'
npx vitest run tests/unit/smoke.test.ts
```

预期：测试通过；原图为 1920×1920 JPEG。

- [ ] **步骤 3：实现图标转换与桌面安全配置**

```js
// scripts/prepare-brand.mjs
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('resources/brand', { recursive: true });
await mkdir('public/brand', { recursive: true });
const png = await sharp('resources/brand/logo-original.jpg').resize(512, 512).png().toBuffer();
await writeFile('resources/brand/icon.png', png);
await writeFile('public/brand/icon.png', png);
await writeFile('resources/brand/icon.ico', await pngToIco(png));
```

```ts
// src/main/index.ts 的关键窗口配置
const icon = app.isPackaged ? join(process.resourcesPath, 'resources/brand/icon.ico') : join(process.env.APP_ROOT, 'resources/brand/icon.ico');
new BrowserWindow({
  width: 1280, height: 820, minWidth: 960, minHeight: 640,
  title: 'SMO.H3 Studio', icon,
  webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
});
```

主进程使用 ESM。由于 sandboxed preload 不支持 ESM imports，preload 必须使用 electron-vite 打包后的 CJS `index.cjs`，并始终保持 `sandbox: true`、`contextIsolation: true` 与 `nodeIntegration: false`。

```ts
// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { formats: ['cjs'] },
      rolldownOptions: { output: { entryFileNames: '[name].cjs' } },
    },
  },
  renderer: { plugins: [react()] },
});
```

- [ ] **步骤 4：生成图标并验证开发构建**

```bash
node scripts/prepare-brand.mjs
npm run build
npx vitest run tests/unit/smoke.test.ts
```

预期：生成 `icon.png`、`icon.ico`，构建退出码为 0，测试通过。

- [ ] **步骤 5：Commit**

```bash
git add package.json package-lock.json electron.vite.config.ts electron-builder.yml tsconfig.json src resources/brand scripts/prepare-brand.mjs tests/unit/smoke.test.ts
git commit -m 'Bootstrap SMO.H3 Studio desktop shell'
```

### 任务 2：两条 API 工作流与帧数契约

**文件：** `scripts/build-workflows.mjs`、`src/shared/types.ts`、`src/shared/workflow.ts`、`resources/workflows/`、`tests/unit/workflow.test.ts`

- [ ] **步骤 1：编写失败测试**

```ts
import { expect, test } from 'vitest';
import { buildH3Frames, patchWorkflow } from '../../src/shared/workflow';
test('audio duration gets the H3 grid and 48 frame tail', () => {
  expect(buildH3Frames(10, true)).toBe(291); // 243 + 48
  expect(buildH3Frames(12, true)).toBe(342); // 294 + 48
});
test('runtime patching cannot alter the frozen model', () => {
  const graph = { '55': { class_type: 'UNETLoader', inputs: { unet_name: 'int8.safetensors' } } };
  expect(() => patchWorkflow(graph, { '55.inputs.unet_name': 'other.safetensors' })).toThrow(/not allowed/);
});
```

- [ ] **步骤 2：确认测试失败**

```bash
npx vitest run tests/unit/workflow.test.ts
```

预期：因 `buildH3Frames` 与 `patchWorkflow` 尚不存在而失败。

- [ ] **步骤 3：实现共享类型、帧数与可达图转换**

文字源文件为 `G:\H3Selflift整合包\工作流\Selflift参考生视频.json`，音频源文件为 `G:\H3Selflift整合包\工作流\Selflift数字人_5080_16GB.json`，分别输出到 `resources/workflows/text-ref2va.json` 与 `resources/workflows/audio-digital-human.json`。

```ts
// src/shared/types.ts
export type VideoMode = 'text' | 'audio';
export interface GenerationRequest { mode: VideoMode; avatarId: string; prompt: string; duration: number; seed: number; audioPath?: string; trimStart?: number }
export interface Avatar { id: string; name: string; photoPath: string; createdAt: string }
export interface LlmProfile { baseUrl: string; model: string }
export interface LlmCredentials extends LlmProfile { apiKey: string }
```

```ts
// src/shared/workflow.ts
export function buildH3Frames(seconds: number, tail: boolean) {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Duration must be positive');
  const n = Math.max(5, Math.round(seconds * 24));
  const grid = (5 - (n % 17) + 17) % 17;
  return n + grid + (tail ? 48 : 0);
}
const ALLOWED = new Set(['36.inputs.image', '226.inputs.image', '34.inputs.audio', '42.inputs.prompt', '136.inputs.prompt', '132.inputs.value', '85.inputs.start_time', '85.inputs.duration', '86.inputs.seed', '269.inputs.seed', '65.inputs.filename_prefix', '180.inputs.filename_prefix']);
export function patchWorkflow<T>(graph: T, changes: Record<string, unknown>): T {
  for (const path of Object.keys(changes)) if (!ALLOWED.has(path)) throw new Error(`Workflow path not allowed: ${path}`);
  const copy = structuredClone(graph) as any;
  for (const [path, value] of Object.entries(changes)) {
    const [id, , field] = path.split('.');
    if (!copy[id]) throw new Error(`Missing workflow node: ${id}`);
    copy[id].inputs[field] = value;
  }
  return copy;
}
```

转换脚本只保留从输出节点可达的节点，先写入直接提示词再遍历，因此本地 Qwen、快速解码分支和 UI 辅助节点不会进入 API 图。文字输出节点为 `180`，音频输出节点为 `65`。文字模板只保留节点 `226` 的第一张模特照片，离线构建时删除 `136` 的 `ref_images.ref_image_1` 与 `ref_images.ref_image_2` 输入，使节点 `255` 和旧硬编码图片不再可达；运行时通过 `226.inputs.image` 注入用户照片。

```js
const FRONTEND_ONLY_FIELDS = new Set([
  'upload',
  'preview',
  'videopreview',
  'selflift_tiling_plan',
  'control_after_generate',
]);

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
    const nodeOverrides = overrides[id] ?? {};
    const linkedNames = new Set(
      nodeInputs
        .filter((input) => !Object.hasOwn(nodeOverrides, input.name) && input.link != null)
        .map((input) => input.name),
    );
    const inputs = Object.fromEntries(
      Object.entries(node.widgets_values_named ?? {}).filter(
        ([name]) => !linkedNames.has(name) && !FRONTEND_ONLY_FIELDS.has(name),
      ),
    );

    const dependencies = new Map();
    for (const input of nodeInputs) {
      if (Object.hasOwn(nodeOverrides, input.name)) continue;
      if (input.link != null) {
        const apiLink = resolveApiLink(input.link);
        inputs[input.name] = apiLink;
        dependencies.set(input.name, apiLink[0]);
      }
    }

    Object.assign(inputs, nodeOverrides);
    for (const field of FRONTEND_ONLY_FIELDS) delete inputs[field];

    graph[id] = { class_type: node.type, inputs };

    // Only real UI connections are dependencies; direct overrides sever their input links.
    for (const dependencyId of dependencies.values()) visit(dependencyId);
  }

  visit(String(outputId));
  return graph;
}

function removeNodeInputs(workflow, id, names) {
  const node = workflow.nodes.find((candidate) => String(candidate.id) === id);
  if (!node) throw new Error(`Missing node ${id}`);

  const removed = new Set(names);
  node.inputs = (node.inputs ?? []).filter((input) => !removed.has(input.name));
}

// main() 中，在文字模板转换前删除第二、第三参考图输入。
removeNodeInputs(textWorkflow, '136', [
  'ref_images.ref_image_1',
  'ref_images.ref_image_2',
]);
```

文字模板离线应用 `127` 的 INT8 主模型、`194` 的 INT8 视频 VAE、`184` 的根目录音频 VAE、`145` 与 `261` 的根目录 LoRA、`115` 的 `0.7` MP、`136` 的 `match`，并把 `195` 与 `196` 的 `mode` 设为 `0`。音频模板保留已确认配置，只把 `42.inputs.prompt` 改为直接文本。

- [ ] **步骤 4：生成并验证模板**

```bash
node scripts/build-workflows.mjs
npx vitest run tests/unit/workflow.test.ts
```

预期：2 个测试通过；文字图包含 `MiniMaxH3ReferenceToVideo`、标准 `VAEDecode` 和 `VAEDecodeAudio`，不包含 `MiniMaxH3VAEDecodeFast`、`RAMCleanup`、`QwenH3PromptLocal`；两条图均保留 INT8 模型与低显存节点。

- [ ] **步骤 5：Commit**

```bash
git add scripts/build-workflows.mjs src/shared resources/workflows tests/unit/workflow.test.ts
git commit -m 'Build parameterized H3 API workflows'
```

### 任务 3：SQLite 与本地作品库

**文件：** `src/main/store.ts`、`tests/unit/store.test.ts`

- [ ] **步骤 1：编写失败测试**

```ts
import { expect, test } from 'vitest';
import { Store } from '../../src/main/store';
test('avatars and works survive reopening the store', () => {
  const store = new Store(':memory:');
  const avatar = store.createAvatar({ name: '林悦', photoPath: 'avatar/lin.jpg' });
  store.addWork({ id: 'w1', avatarId: avatar.id, mode: 'text', outputPath: 'works/w1.mp4', status: 'done' });
  expect(store.listAvatars()[0].name).toBe('林悦');
  expect(store.listWorks()[0].outputPath).toBe('works/w1.mp4');
  store.close();
});
```

- [ ] **步骤 2：确认失败并实现 `node:sqlite` 存储**

```bash
npx vitest run tests/unit/store.test.ts
```

```ts
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS avatars(id TEXT PRIMARY KEY,name TEXT NOT NULL,photoPath TEXT NOT NULL,createdAt TEXT NOT NULL); CREATE TABLE IF NOT EXISTS works(id TEXT PRIMARY KEY,avatarId TEXT NOT NULL,mode TEXT NOT NULL,outputPath TEXT,status TEXT NOT NULL,createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);');
  }
  createAvatar(input: { name: string; photoPath: string }) {
    const value = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    this.db.prepare('INSERT INTO avatars(id,name,photoPath,createdAt) VALUES(?,?,?,?)').run(value.id, value.name, value.photoPath, value.createdAt);
    return value;
  }
  listAvatars() { return this.db.prepare('SELECT * FROM avatars ORDER BY createdAt DESC').all(); }
  addWork(work: any) { this.db.prepare('INSERT INTO works(id,avatarId,mode,outputPath,status) VALUES(?,?,?,?,?)').run(work.id, work.avatarId, work.mode, work.outputPath, work.status); }
  listWorks() { return this.db.prepare('SELECT * FROM works ORDER BY createdAt DESC').all(); }
  close() { this.db.close(); }
}
```

- [ ] **步骤 3：验证存储测试并 Commit**

```bash
npx vitest run tests/unit/store.test.ts
git add src/main/store.ts tests/unit/store.test.ts
git commit -m 'Add persistent avatar and work library'
```

预期：测试通过，工作库使用 SQLite，不引入原生 npm 数据库模块。

### 任务 4：外部 LLM 模型获取、测试与密钥

**文件：** `src/main/llm.ts`、`src/main/secrets.ts`、`tests/unit/llm.test.ts`

- [ ] **步骤 1：用本地模拟上游编写失败测试**

```ts
import { expect, test } from 'vitest';
import { LlmService } from '../../src/main/llm';
test('lists upstream ids and tests the selected model', async () => {
  const service = new LlmService();
  const models = await service.listModels({ baseUrl: 'http://127.0.0.1:4010', apiKey: 'secret' });
  expect(models).toContain('model-a');
  const result = await service.testModel({ baseUrl: 'http://127.0.0.1:4010', apiKey: 'secret', model: 'model-a' });
  expect(result.ok).toBe(true);
  expect(result.latencyMs).toBeGreaterThanOrEqual(0);
});
```

- [ ] **步骤 2：确认失败并实现请求与脱敏**

```ts
// 模型列表使用 GET /models，模型测试和润色使用 POST /chat/completions。
async function request(path: string, profile: { baseUrl: string; apiKey: string }, init?: RequestInit) {
  const response = await fetch(new URL(path, profile.baseUrl.endsWith('/') ? profile.baseUrl : `${profile.baseUrl}/`), { ...init, headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json', ...init?.headers }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`LLM ${response.status}: ${(await response.text()).replaceAll(profile.apiKey, '[redacted]').slice(0, 500)}`);
  return response.json();
}
import type { LlmCredentials } from '../shared/types';
export class LlmService {
  async listModels(profile: LlmCredentials) { const data = await request('models', profile); return data.data.map((item: any) => item.id).sort(); }
  async testModel(profile: LlmCredentials) { const started = performance.now(); const data = await request('chat/completions', profile, { method: 'POST', body: JSON.stringify({ model: profile.model, messages: [{ role: 'user', content: 'Reply with OK only.' }], max_tokens: 4, stream: false }) }); return { ok: true, latencyMs: Math.round(performance.now() - started), summary: data.choices?.[0]?.message?.content ?? '' }; }
}
```

`secrets.ts` 仅在 `safeStorage.isEncryptionAvailable()` 时写入密文；不可用时拒绝保存并提示用户，不退化为明文。

```ts
import { safeStorage } from 'electron';
export function encryptSecret(value: string) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable');
  return safeStorage.encryptString(value).toString('base64');
}
```

- [ ] **步骤 3：验证上游行为并 Commit**

```bash
npx vitest run tests/unit/llm.test.ts
git add src/main/llm.ts src/main/secrets.ts tests/unit/llm.test.ts
git commit -m 'Add secure external LLM configuration'
```

预期：模型列表、测试延迟、401/404/超时和密钥脱敏测试全部通过。

### 任务 5：H3 Prompt Skills 服务

**文件：** `resources/skills/`、`src/main/skills.ts`、`src/shared/prompt-contract.ts`、`tests/unit/skills.test.ts`

- [ ] **步骤 1：复制固定 Skills 并编写失败测试**

```bash
Copy-Item -Recurse 'G:\H3Selflift整合包\ComfyUI_SelfLift_Spark_SM120_CUDA130\ComfyUI\custom_nodes\ComfyUI_Qwen_H3_Prompt\skills' 'resources/skills'
```

```ts
import { expect, test } from 'vitest';
import { validatePrompt } from '../../src/shared/prompt-contract';
test('rejects missing Ref2VA sections and late shots', () => {
  expect(validatePrompt('summary: x', 'ref2va', 12)).toContain('subject_definitions');
  const valid = 'subject_definitions:\nx\nsummary:\nx\nretention_analysis:\nx\ndetailed_description:\nx\noverall_soundscape:\nx\nnon_diegetic_music:\nN/A';
  expect(validatePrompt(valid, 'ref2va', 12)).toEqual([]);
});
```

- [ ] **步骤 2：实现校验与单次润色流程**

```ts
const REF_FIELDS = ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:'];
export function validatePrompt(text: string, mode: string, duration: number, original = '') {
  const fields = mode === 'ref2va' ? REF_FIELDS : ['integrated_multimodal_description:', 'overall_soundscape:', 'non_diegetic_music:'];
  const positions = fields.map(field => text.indexOf(field));
  const issues = fields.filter((field, index) => positions[index] < 0);
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) issues.push('Fields are out of order');
  let previous = -1;
  for (const match of text.matchAll(/\bAt\s+(\d{2}):(\d{2})\.(\d{3})\b/g)) {
    const seconds = Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 1000;
    if (seconds <= previous) issues.push('Shot timestamps are not strictly increasing');
    if (seconds >= duration) { issues.push('Shot timestamp exceeds duration'); break; }
    previous = seconds;
  }
  if (/```|please confirm|请确认/i.test(text)) issues.push('Interactive or Markdown wrapper found');
  for (const match of original.matchAll(/<d>[\s\S]*?<\/d>/g)) if (!text.includes(match[0])) issues.push('Dialogue was modified');
  if (/<d>[\s\S]*?<\/d>/.test(text) && !/(final|last)\s+(2|two)\s+seconds/i.test(text)) issues.push('Missing narration tail');
  return issues;
}
```

`skills.ts` 使用快照中的 `SKILL.md`、对应参考文档和与整合包一致的单次输出约束，并额外要求含对白的提示词明确保留最后 2 秒非旁白空间。自动路由默认回退到 `h3-prompt-writing`，润色结果校验失败后只请求修正 1 次，第二次失败返回错误并保留原文。

- [ ] **步骤 3：验证全部 Skill 与格式并 Commit**

```bash
npx vitest run tests/unit/skills.test.ts tests/unit/prompt-contract.test.ts
git add resources/skills src/main/skills.ts src/shared/prompt-contract.ts tests/unit/skills.test.ts tests/unit/prompt-contract.test.ts
git commit -m 'Integrate official H3 prompt skills'
```

预期：9 个 Skill 均可读取；Ref2VA 六段、时间戳、对白、Markdown 和片尾校验通过。

### 任务 6：硬件检测与推荐

**文件：** `src/main/hardware.ts`、`tests/unit/hardware.test.ts`

- [ ] **步骤 1：编写不同硬件档位的失败测试**

```ts
import { expect, test } from 'vitest';
import { applyHardwareProfile, recommendHardware } from '../../src/main/hardware';
test('keeps the verified 16 GB profile and degrades lower memory', () => {
  expect(recommendHardware({ gpu: 'RTX 5080', vramGiB: 16, ramGiB: 64 }).megapixels).toBe(0.7);
  expect(recommendHardware({ gpu: 'RTX 4060', vramGiB: 8, ramGiB: 32 }).megapixels).toBe(0.4);
  expect(recommendHardware({ gpu: 'RTX 4090', vramGiB: 24, ramGiB: 64 }).requiresConfirmation).toBe(true);
  const graph = { '61': { class_type: 'ResolutionSelector', inputs: { megapixels: 0.7 } } };
  expect(() => applyHardwareProfile(graph, { megapixels: 1 }, false)).toThrow(/confirmation/);
  const copy = applyHardwareProfile(graph, { megapixels: 1 }, true);
  expect(copy['61'].inputs.megapixels).toBe(1);
  expect(graph['61'].inputs.megapixels).toBe(0.7);
});
```

- [ ] **步骤 2：实现可解释推荐**

```ts
export function recommendHardware(input: { gpu: string; vramGiB: number; ramGiB: number }) {
  if (input.vramGiB < 12 || input.ramGiB < 32) return { preset: 'conservative', modelPolicy: 'int8', megapixels: 0.4, lowvram: true, tiling: 4, requiresConfirmation: true };
  if (input.vramGiB < 20) return { preset: 'balanced-16gb', modelPolicy: 'int8', megapixels: 0.7, lowvram: true, tiling: 'auto', requiresConfirmation: true };
  return { preset: 'high-memory-candidate', modelPolicy: 'bf16-if-present', megapixels: 1.0, lowvram: false, tiling: 'auto', requiresConfirmation: true };
}
```

```ts
export function applyHardwareProfile(graph: any, profile: any, confirmed: boolean) {
  if (!confirmed) throw new Error('Hardware profile requires confirmation');
  const copy = structuredClone(graph);
  for (const node of Object.values<any>(copy)) {
    if (node.class_type === 'ResolutionSelector') node.inputs.megapixels = profile.megapixels;
    if (node.class_type === 'SelfLiftAvatarH3Sampler') node.inputs.highres_tiling = true;
  }
  return copy;
}
```

应用推荐前必须检查对应模型文件并生成新工作流副本，禁止覆盖原文件。

- [ ] **步骤 3：运行测试并 Commit**

```bash
npx vitest run tests/unit/hardware.test.ts
git add src/main/hardware.ts tests/unit/hardware.test.ts
git commit -m 'Add hardware-aware ComfyUI recommendations'
```

预期：3 个硬件档位测试通过，高档位只标记为候选配置，不声称已实测。

### 任务 7：ComfyUI 客户端与单任务队列

**文件：** `src/main/comfy.ts`、`src/main/jobs.ts`、`tests/unit/comfy.test.ts`、`tests/unit/jobs.test.ts`

- [ ] **步骤 1：用模拟 ComfyUI 编写失败测试**

```ts
import { expect, test } from 'vitest';
import { JobCoordinator } from '../../src/main/jobs';
test('runs only one H3 job at a time', async () => {
  const coordinator = new JobCoordinator();
  const first = coordinator.enqueue({ id: 'a', run: async () => {} });
  const second = coordinator.enqueue({ id: 'b', run: async () => {} });
  expect(coordinator.activeCount).toBe(1);
  await Promise.all([first, second]);
  expect(coordinator.completedIds).toEqual(['a', 'b']);
});
```

- [ ] **步骤 2：实现 API 客户端与顺序队列**

```ts
export class ComfyClient {
  constructor(private baseUrl = 'http://127.0.0.1:8188') {}
  async health() { const response = await fetch(`${this.baseUrl}/system_stats`, { signal: AbortSignal.timeout(5000) }); if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}`); return response.json(); }
  async submit(prompt: unknown) { const response = await fetch(`${this.baseUrl}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) }); if (!response.ok) throw new Error((await response.text()).slice(0, 800)); return response.json(); }
  async cancel() { await fetch(`${this.baseUrl}/interrupt`, { method: 'POST' }); }
}
```

```ts
export class JobCoordinator {
  private queue: any[] = []; private running = false; completedIds: string[] = [];
  get activeCount() { return this.running ? 1 : 0; }
  enqueue(job: any) { return new Promise<void>((resolve, reject) => { this.queue.push({ job, resolve, reject }); this.pump(); }); }
  private async pump() { if (this.running || !this.queue.length) return; this.running = true; const item = this.queue.shift(); try { await item.job.run(); this.completedIds.push(item.job.id); item.resolve(); } catch (error) { item.reject(error); } finally { this.running = false; this.pump(); } }
}
```

- [ ] **步骤 3：验证提交、取消、恢复与 Commit**

```bash
npx vitest run tests/unit/comfy.test.ts tests/unit/jobs.test.ts
git add src/main/comfy.ts src/main/jobs.ts tests/unit/comfy.test.ts tests/unit/jobs.test.ts
git commit -m 'Add ComfyUI execution and job coordination'
```

预期：上传、提交、进度、取消、失败恢复与顺序执行测试通过。

### 任务 8：类型化 Electron IPC

**文件：** `src/main/ipc.ts`、`src/preload/index.ts`、`src/shared/ipc.ts`、`tests/unit/ipc.test.ts`

- [ ] **步骤 1：编写 IPC 白名单失败测试**

```ts
import { expect, test } from 'vitest';
import { createIpcSchema } from '../../src/shared/ipc';
test('rejects unsupported channels and empty generation prompts', () => {
  const schema = createIpcSchema();
  expect(() => schema.parse({ channel: 'shell:exec', payload: 'dir' })).toThrow();
  expect(() => schema.parse({ channel: 'jobs:start', payload: { prompt: '' } })).toThrow();
});
```

- [ ] **步骤 2：实现 Zod 校验和 preload 暴露**

```ts
import { z } from 'zod';
export function createIpcSchema() {
  return z.discriminatedUnion('channel', [
    z.object({ channel: z.literal('jobs:start'), payload: z.object({ prompt: z.string().min(1) }).passthrough() }),
    z.object({ channel: z.literal('llm:listModels'), payload: z.object({ baseUrl: z.string().url(), model: z.string() }) }),
    z.object({ channel: z.literal('llm:testModel'), payload: z.object({ baseUrl: z.string().url(), model: z.string().min(1) }) }),
    z.object({ channel: z.literal('comfy:health'), payload: z.object({}).strict() }),
    z.object({ channel: z.literal('avatars:list'), payload: z.object({}).strict() }),
    z.object({ channel: z.literal('avatars:create'), payload: z.object({ name: z.string().min(1), photoPath: z.string().min(1) }) }),
    z.object({ channel: z.literal('works:list'), payload: z.object({}).strict() }),
    z.object({ channel: z.literal('hardware:detect'), payload: z.object({}).strict() }),
  ]);
}
```

`preload` 仅暴露 `window.smo.avatars`、`window.smo.jobs`、`window.smo.llm`、`window.smo.comfy` 和 `window.smo.hardware`，不暴露通用 IPC、文件系统或 shell。

- [ ] **步骤 3：验证 IPC 并 Commit**

```bash
npx vitest run tests/unit/ipc.test.ts
git add src/main/ipc.ts src/preload src/shared/ipc.ts tests/unit/ipc.test.ts
git commit -m 'Secure the Electron IPC boundary'
```

预期：非法 channel、路径越界和空参数均被拒绝。

### 任务 9：SMO 界面与两种制作模式

**文件：** `src/renderer/App.tsx`、`src/renderer/pages/StudioPage.tsx`、`src/renderer/components/`、`src/renderer/styles.css`、`tests/unit/studio.test.tsx`

- [ ] **步骤 1：编写界面失败测试**

```tsx
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { App } from '../../src/renderer/App';
test('offers text and audio modes without TTS controls', () => {
  render(<App />);
  expect(screen.getByText('SMO.H3 Studio')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '文字生视频' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '音频数字人' })).toBeInTheDocument();
  expect(screen.queryByText(/Fish Speech|声音克隆|文字转音频/)).toBeNull();
});
```

- [ ] **步骤 2：实现 A 布局、Logo 与模式切换**

```tsx
export function App() {
  const [page, setPage] = useState<'studio' | 'avatars' | 'works' | 'settings'>('studio');
  const labels = { studio: '制作台', avatars: '数字模特', works: '我的作品', settings: '设置' };
  return <main className="studio-shell"><aside><img src="/brand/icon.png" alt="SMO"/><strong>SMO.H3 Studio</strong><nav>{Object.keys(labels).map(item => <button key={item} onClick={() => setPage(item as typeof page)}>{labels[item as keyof typeof labels]}</button>)}</nav></aside>{page === 'studio' ? <StudioPage/> : page === 'avatars' ? <AvatarsPage/> : page === 'works' ? <WorksPage/> : <SettingsPage/>}</main>;
}

export function StudioPage() {
  const [mode, setMode] = useState<'text' | 'audio'>('text');
  return <section><header>数字人制作台</header><div className="workbench"><AvatarPreview/><div className="controls"><div role="tablist"><button role="tab" onClick={() => setMode('text')}>文字生视频</button><button role="tab" onClick={() => setMode('audio')}>音频数字人</button></div>{mode === 'text' ? <TextPromptEditor/> : <AudioDigitalHumanForm/>}</div></div></section>;
}
```

样式沿用原型的深灰侧栏、薄荷绿主色、暖橙生成按钮、6px 卡片、清晰表单和响应式双栏。任何窗口尺寸下都不允许按钮或长模型名溢出。

- [ ] **步骤 3：运行界面测试并检查实际窗口**

```bash
npx vitest run tests/unit/studio.test.tsx
npm run dev
```

预期：组件测试通过；1280×820 与 960×640 窗口均无重叠，Logo 清晰，文字与音频模式可切换。

- [ ] **步骤 4：Commit**

```bash
git add src/renderer tests/unit/studio.test.tsx
git commit -m 'Build the SMO digital human studio interface'
```

### 任务 10：模特、作品与设置页

**文件：** `src/renderer/pages/AvatarsPage.tsx`、`src/renderer/pages/WorksPage.tsx`、`src/renderer/pages/SettingsPage.tsx`、`tests/unit/settings.test.tsx`

任务 10 的硬件档案集成边界：仅在用户明确确认硬件档案后，才在本次任务的工作流副本上调用 `applyHardwareProfile`，并在 `comfy.submit` 前完成注入。当前默认生成路径仍提交冻结的 16 GB 配置，不改变两条冻结图或其默认参数；这不表示跳过任务 10 的硬件集成。

- [ ] **步骤 1：编写设置页失败测试**

```tsx
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { SettingsPage } from '../../src/renderer/pages/SettingsPage';
test('supports model discovery and testing', () => {
  render(<SettingsPage />);
  expect(screen.getByRole('button', { name: '获取模型列表' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '测试模型' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '检查后端' })).toBeInTheDocument();
});
```

- [ ] **步骤 2：实现三个页面与真实 IPC 调用**

```tsx
async function refreshModels() {
  setBusy(true); setError('');
  try { setModels(await window.smo.llm.listModels({ baseUrl, model })); }
  catch (error) { setError((error as Error).message); }
  finally { setBusy(false); }
}
async function testSelectedModel() {
  setBusy(true); setError('');
  try { setTestResult(await window.smo.llm.testModel({ baseUrl, model })); }
  catch (error) { setError((error as Error).message); }
  finally { setBusy(false); }
}
```

模特页只保存名称与照片；作品页保存原始终态并支持播放、重试与打开目录；设置页同时展示 LLM、ComfyUI 和硬件档案。

- [ ] **步骤 3：验证页面并 Commit**

```bash
npx vitest run tests/unit/settings.test.tsx tests/unit/library-pages.test.tsx
git add src/renderer/pages tests/unit/settings.test.tsx tests/unit/library-pages.test.tsx
git commit -m 'Add avatar, work and configuration pages'
```

预期：模型获取、测试、后端检查、作品重试与硬件确认状态测试通过。

### 任务 11：端到端验证

**文件：** `tests/e2e/studio.spec.ts`、`tests/fixtures/`、`playwright.config.ts`

- [ ] **步骤 1：建立模拟 LLM 与 ComfyUI 服务**

```ts
import { _electron as electron } from 'playwright';
// Playwright fixture 使用 Node HTTP 服务提供 /models、/chat/completions、/system_stats、/object_info、/prompt、/history/:id。
const app = await electron.launch({ args: ['.'] });
const page = await app.firstWindow();
await page.getByRole('button', { name: '获取模型列表' }).click();
await expect(page.getByText('model-a')).toBeVisible();
await page.getByRole('button', { name: '测试模型' }).click();
await expect(page.getByText(/测试成功/)).toBeVisible();
```

- [ ] **步骤 2：验证完整桌面流程**

```bash
npx playwright test tests/e2e/studio.spec.ts
```

预期：创建模特、模型获取与测试、原文与润色切换、任务排队、作品显示、应用重启恢复全部通过；日志不包含测试密钥。

- [ ] **步骤 3：使用真实 H3 后端执行短片验收**

```bash
node scripts/build-workflows.mjs
npm run build
```

用用户提供的照片生成 1 条 4–6 秒文字视频，再用照片和音频生成 1 条短数字人视频。验收 MP4 可播放、音画存在、时长和片尾正确、原 ComfyUI 文件未改变。真实生成失败时保留错误日志并先修复对应工作流，不跳过验收。

- [ ] **步骤 4：Commit**

```bash
git add tests/e2e tests/fixtures playwright.config.ts
git commit -m 'Verify SMO.H3 Studio end to end'
```

### 任务 12：Windows 打包与桌面快捷方式

**文件：** `electron-builder.yml`、`scripts/create-shortcut.ps1`、`tests/e2e/package.spec.ts`

- [ ] **步骤 1：配置打包内容**

```yaml
appId: com.smo.h3studio
productName: SMO.H3 Studio
directories:
  output: release
files:
  - dist/**
extraResources:
  - from: resources/brand
    to: resources/brand
  - from: resources/workflows
    to: resources/workflows
  - from: resources/skills
    to: resources/skills
win:
  target: portable
  icon: resources/brand/icon.ico
portable:
  artifactName: SMO.H3-Studio-${version}.${ext}
```

`extraResources` 的目标路径相对 `process.resourcesPath`，因此品牌、工作流与 Skills 分别位于 `resources/brand`、`resources/workflows` 与 `resources/skills`，不依赖 app.asar 内路径。

- [ ] **步骤 2：构建 portable 应用并检查资源**

```bash
npm run assets
npm run pack
```

预期：生成 Windows 可执行文件；包内包含 Logo、2 条工作流和 9 个 Skill，不包含 API Key、测试作品、日志或 `.worktrees`。

- [ ] **步骤 3：验证打包启动并创建快捷方式**

```powershell
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut("$env:USERPROFILE\Desktop\SMO.H3 Studio.lnk")
$shortcut.TargetPath = (Resolve-Path 'release\SMO.H3-Studio-0.1.0.exe').Path
$shortcut.WorkingDirectory = (Resolve-Path 'release').Path
$shortcut.IconLocation = "$($shortcut.TargetPath),0"
$shortcut.Save()
```

启动打包应用，验证窗口标题、图标、模型获取、ComfyUI 连接和作品目录。Playwright 检查 `1280×820` 与 `960×640` 截图中的布局及非空预览。

- [ ] **步骤 4：Commit 并检查工作区**

```bash
git add electron-builder.yml scripts/create-shortcut.ps1 tests/e2e/package.spec.ts package.json package-lock.json
git commit -m 'Package SMO.H3 Studio for Windows'
git status --short
```

预期：提交后工作区干净，桌面快捷方式指向打包程序。

## 计划自检结果

- 规格中的 2 条视频模式、9 个 Skill、上游模型获取与测试、ComfyUI 壳层、硬件推荐、SQLite、隐私、异常恢复和 Windows 桌面交付均有对应任务。
- 所有外部服务均可使用本地模拟服务测试，真实 LLM 只在用户配置后调用，真实 H3 只在验收阶段生成。
- 工作流模型参数只允许在离线模板构建或用户确认的硬件副本中改变，运行时白名单不能修改它们。
- 类型 `VideoMode`、`GenerationRequest`、`Avatar` 和 `LlmProfile` 在共享文件定义后供 IPC、界面、任务与测试复用。
