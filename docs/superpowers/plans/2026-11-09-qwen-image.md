# Qwen Image 2.1 标准版文字生图实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 使用当前 ComfyUI 的原生 Qwen Image 2.1 节点提供本地文字生图，支持比例、实际像素、随机种子和 1-100 步调节，默认 25 步，结果进入统一作品管理。

**架构：** 复用基础计划的任务锁、作品服务和组件下载器。图像工作流由 ComfyUI 官方标准模板导出为 API 图，移除未启用的提示词增强分支，只保留三个必需模型。主进程按节点类型校验并补丁提示词、尺寸、种子和步数，避免依赖可变的节点编号。

**技术栈：** ComfyUI 0.38.0、Qwen Image 2.1 标准 INT8、Electron、React、TypeScript、Vitest、Playwright。

**规格：** `docs/superpowers/specs/2026-11-09-media-studio-design.md`

**前置：** `docs/superpowers/plans/2026-11-09-media-studio-foundation.md`；组件服务来自 `docs/superpowers/plans/2026-11-09-local-speech.md`。

---

## 文件职责

- 修改 `scripts/build-media-manifest.mjs`、`resources/environment/media-components.json`：增加三个官方标准模型文件。
- 创建 `resources/workflows/qwen-image-2-1.json`：从官方标准模板导出的简化 API 图。
- 创建 `src/shared/image-options.ts`：图像比例、像素选项、默认值和校验。
- 创建 `src/main/image-workflow.ts`：按节点类型补丁并验证图像 API 图。
- 创建 `src/main/image-generation.ts`：ComfyUI 提交、进度、PNG 输出、取消和重试。
- 创建 `src/renderer/ImageForm.tsx`：文字生图表单。
- 修改 `src/renderer/StudioPage.tsx`：完成语音/图像/视频三主模式。
- 修改共享 IPC、preload、主进程服务装配与 `tests/e2e/studio.spec.ts`。

### 任务 1：标准模型组件与运行时节点校验

**文件：** `scripts/build-media-manifest.mjs`、`resources/environment/media-components.json`、`src/main/media-components.ts`、`src/main/environment-setup.ts`、`tests/unit/media-components.test.ts`、`tests/unit/environment-setup.test.ts`

- [ ] **步骤 1：编写失败测试**

断言图像组件只包含以下三个必需模型，不包含可选提示词增强器：

```text
diffusion_models/qwen_image_2.1_int8_convrot.safetensors
text_encoders/qwen3vl_8b_int8_convrot.safetensors
vae/qwen_image_2.1_vae_bf16.safetensors
```

安装目标为当前环境的 ComfyUI 模型根，语音组件仍安装到自己的组件目录。节点校验要求当前后端具有 `TextEncodeQwenImage21`、`QwenImage21Cache`、`SaveImageAdvanced`；缺节点只使图像组件不就绪，不将健康 H3 环境标记失败。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/media-components.test.ts tests/unit/environment-setup.test.ts -t "image|图像"`

预期：FAIL。

- [ ] **步骤 3：实现图像清单目标与独立节点检查**

生成器从 `Comfy-Org/Qwen-Image-2.1` 获取三个文件的精确大小和 LFS SHA256。`MediaComponentService` 为图像使用 `target: 'comfy-models'`，通过当前配置 `dirname(modelDirectory)` 得到模型根，并断言 `basename(modelDirectory) === 'diffusion_models'` 后写入；语音继续使用 `target: 'component'`。

新增 `inspectImageRuntime(objectInfo)` 返回缺失节点列表，组件状态显示“运行时需要支持 Qwen Image 2.1”，但不改变基础环境 `healthy`。

- [ ] **步骤 4：生成清单并运行测试**

运行：`node scripts/build-media-manifest.mjs --component image && npx vitest run tests/unit/media-components.test.ts tests/unit/environment-setup.test.ts`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add scripts/build-media-manifest.mjs resources/environment/media-components.json src/main/media-components.ts src/main/environment-setup.ts tests/unit/media-components.test.ts tests/unit/environment-setup.test.ts
git commit -m "Add Qwen Image standard component"
```

### 任务 2：官方 API 图与可校验补丁

**文件：** `resources/workflows/qwen-image-2-1.json`、`src/shared/image-options.ts`、`src/main/image-workflow.ts`、`tests/unit/image-workflow.test.ts`

- [ ] **步骤 1：编写失败测试**

使用冻结 API 图，验证默认 `25` 步、`cfg = 1`、`euler/simple`，修改后提示词、宽度、高度、种子和步数写入唯一正确节点；输入图不变；缺少节点或重复目标节点会失败。

```ts
const output = patchQwenImageWorkflow(frozen, {
  prompt: '测试画面', width: 1024, height: 1024, seed: 42, steps: 30,
});
expect(output.sampler.inputs).toMatchObject({ seed: 42, steps: 30, cfg: 1 });
expect(output.text.inputs.prompt).toBe('测试画面');
expect(output.latent.inputs).toMatchObject({ width: 1024, height: 1024, batch_size: 1 });
```

- [ ] **步骤 2：运行测试确认模块不存在**

运行：`npx vitest run tests/unit/image-workflow.test.ts`

预期：FAIL。

- [ ] **步骤 3：导出并简化官方工作流**

从 Comfy-Org `image_qwen_image_2_1_t2i.json` 的标准子图导出 API 图，保留 `UNETLoader`、`CLIPLoader`、`VAELoader`、`TextEncodeQwenImage21`、`QwenImage21Cache`、空 latent、`KSampler`、`VAEDecode`、`SaveImageAdvanced`。关闭并移除可选 Qwen3.5 提示词增强分支；输出 PNG，前缀由应用设置。

`patchQwenImageWorkflow` 通过 `class_type` 找唯一节点并返回 `{ graph, nodeIds }`；`nodeIds.output` 供历史输出选择。校验尺寸为 `256-4096` 且为 32 的倍数，步数为 `1-100` 整数，种子为非负安全整数。

共享默认项：

```ts
export const DEFAULT_IMAGE_OPTIONS = {
  width: 1024,
  height: 1024,
  seed: 42,
  steps: 25,
} as const;
```

- [ ] **步骤 4：运行测试**

运行：`npx vitest run tests/unit/image-workflow.test.ts tests/unit/workflow.test.ts`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add resources/workflows/qwen-image-2-1.json src/shared/image-options.ts src/main/image-workflow.ts tests/unit/image-workflow.test.ts
git commit -m "Freeze adjustable Qwen Image standard workflow"
```

### 任务 3：图像生成请求与 ComfyUI 任务

**文件：** `src/shared/types.ts`、`src/shared/ipc.ts`、`src/main/image-generation.ts`、`src/main/generation.ts`、`src/main/app-services.ts`、`src/main/ipc.ts`、`src/preload/index.ts`、`tests/unit/image-generation.test.ts`、`tests/unit/ipc.test.ts`

- [ ] **步骤 1：编写失败测试**

验证 `ImageGenerationRequest`：

```ts
export interface ImageGenerationRequest {
  mode: 'image';
  prompt: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  retryOf?: string;
}
```

本任务将共享联合类型最终扩展为 `type GenerationRequest = VideoGenerationRequest | SpeechGenerationRequest | ImageGenerationRequest`。

模拟 ComfyUI 运行后断言：无 avatar 上传、组件未 ready 时拒绝、提交图参数正确、仅接受输出节点的 PNG、完成作品 `avatarId = null`、进度和耗时持久化、取消只取消当前 prompt、失败可重试、语音/视频活动时不新增图像作品。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/image-generation.test.ts tests/unit/ipc.test.ts -t "image|图像"`

预期：FAIL。

- [ ] **步骤 3：实现图像任务与统一重试路由**

`createImageGenerationHandler` 沿用视频任务的执行阶段、进度节流、精确 prompt 取消和路径逃逸校验，但不调用硬件工作流或上传头像。提交前读取冻结图并应用 `patchQwenImageWorkflow`，输出路径限制为 `output/SMO-Image/<workId>.png`。

`createRetryHandler` 改为按 `work.mode` 路由视频、语音、图像处理器；图像不需要媒体授权，语音参考音按语音计划处理。注册严格 `jobs:start` 联合 schema，未知字段仍拒绝。

- [ ] **步骤 4：运行测试与类型检查**

运行：`npx vitest run tests/unit/image-generation.test.ts tests/unit/generation.test.ts tests/unit/speech-generation.test.ts tests/unit/ipc.test.ts && npm run typecheck`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add src/shared/types.ts src/shared/ipc.ts src/main/image-generation.ts src/main/generation.ts src/main/app-services.ts src/main/ipc.ts src/preload/index.ts tests/unit/image-generation.test.ts tests/unit/ipc.test.ts
git commit -m "Generate Qwen Image works through ComfyUI"
```

### 任务 4：图像面板与三主模式完成

**文件：** `src/renderer/ImageForm.tsx`、`src/renderer/StudioPage.tsx`、`src/renderer/GenerationOptions.tsx`、`src/renderer/styles.css`、`tests/unit/image-form.test.tsx`、`tests/unit/studio.test.tsx`、`tests/e2e/studio.spec.ts`

- [ ] **步骤 1：编写失败渲染测试**

验证图像 tab 无模特要求，提示词、比例、实际像素、种子和默认 25 步正确；加减和直接输入步数；组件安装状态；全局 busy；切换语音/视频/页面后草稿保留；完成作品在 WorksPage 以原始比例显示。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/image-form.test.tsx tests/unit/studio.test.tsx -t "图像|image"`

预期：FAIL。

- [ ] **步骤 3：实现图像面板与最终 tab 顺序**

主 tab 顺序为语音、图像、视频。图像表单使用文本域、比例菜单、分辨率菜单、随机种子和 `StepNumberField recommended={25}`；分辨率选项直接显示 `1024 × 1024 px` 等实际值。不加入 AI 润色、图片编辑或参考图控件。

三个主面板保持挂载；只有视频显示模特侧栏。图像与语音使用单列工作区，生成按钮使用 `Image` 图标并遵循全局活动任务锁。

- [ ] **步骤 4：运行测试与视觉回归**

运行：`npx vitest run tests/unit/image-form.test.tsx tests/unit/studio.test.tsx tests/unit/layout.test.ts && npm run build && npx playwright test tests/e2e/studio.spec.ts`

预期：PASS；1280×820、960×640 和 200% 缩放无重叠或横向溢出。

- [ ] **步骤 5：提交**

```bash
git add src/renderer/ImageForm.tsx src/renderer/StudioPage.tsx src/renderer/GenerationOptions.tsx src/renderer/styles.css tests/unit/image-form.test.tsx tests/unit/studio.test.tsx tests/e2e/studio.spec.ts
git commit -m "Add Qwen Image workspace"
```

### 任务 5：真实图像验收与整体验证

- [ ] **步骤 1：真实标准模型生成**

安装三个官方模型，使用固定提示词和种子分别生成 25 步与 30 步 1024×1024 PNG。通过 `/history` 确认标准 `KSampler` 使用 `euler/simple`、无固定 Turbo `ManualSigmas`，输出非空白、尺寸正确，作品可预览、重命名、打开目录和删除。

- [ ] **步骤 2：显存与单任务验收**

在低显存档位记录模型加载和生成错误；若 8 GB 候选失败，保留明确提示并记录实测，不宣称保证兼容。图像运行时尝试启动语音或视频，IPC 必须拒绝且无新作品；完成后两个入口恢复。

- [ ] **步骤 3：完整自动验证与打包**

运行：

```bash
npm run typecheck
npm test
npm run test:e2e
npm run pack -- --config.electronDist=node_modules/electron/dist
npm run test:e2e:package
```

检查安装包不含模型和用户素材，远程 Release 仅在真实语音、图像、视频验收全部完成后创建。将实际结果和未执行项写入本计划，提交计划文档。

