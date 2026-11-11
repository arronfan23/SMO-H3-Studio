# Qwen 多参考生图与 2K 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Qwen Image 2.1 增加 1-4 张参考图的编辑/生成模式，并加入 2MP、4MP 原生输出档位。

**架构：** 复用现有图像任务、组件状态和 `ReferenceImagePicker`。参考模式沿用冻结图的模型、VAE、Cache、KSampler 和输出节点，但由 `TextEncodeQwenImage21` 接收多图及 VAE，采样 latent 改为该节点的编辑 latent。纯文字模式保持现有空 latent 路径。

**技术栈：** ComfyUI `TextEncodeQwenImage21`、Electron、React、TypeScript、Zod、Vitest、Playwright。

**规格：** `docs/superpowers/specs/2026-11-11-studio-navigation-reference-media-design.md`

**前置：** `docs/superpowers/plans/2026-11-11-studio-foundation.md`

---

## 文件职责

- 修改 `src/shared/types.ts`、`src/shared/ipc.ts`：可选 `referenceImagePaths`，0-4 张。
- 修改 `src/shared/image-options.ts`、`src/shared/resolution.ts`：2MP/4MP 和参考分辨率计算。
- 修改 `src/main/image-workflow.ts`：参考图连接和编辑 latent。
- 修改 `src/main/image-generation.ts`：多图上传、图选择、重试和清理。
- 修改 `src/renderer/ImageForm.tsx`：文字/参考双模式及 2K。
- 新增对应单元和 E2E 测试。

### 任务 1：参考请求、图像选择与 2K 选项

**文件：** `src/shared/types.ts`、`src/shared/ipc.ts`、`src/shared/image-options.ts`、`src/shared/resolution.ts`、`src/renderer/ImageForm.tsx`、`tests/unit/ipc.test.ts`、`tests/unit/image-form.test.tsx`、`tests/unit/resolution.test.ts`

- [x] **步骤 1：编写失败测试**

`referenceImagePaths` 缺省为 `[]`，1-4 张合法，超过 4、空路径、非字符串拒绝，未知字段拒绝。UI 有“文字生图 / 参考生图”，参考模式显示 1-4 张增删、预览和提示词；隐藏参考图时不能提交。

分辨率选项包含 2MP、4MP，1:1 对应约 1448×1448、2048×2048，其他比例按 32 像素网格计算。视频选项不变。

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/ipc.test.ts tests/unit/image-form.test.tsx tests/unit/resolution.test.ts`

- [x] **步骤 3：实现请求和双模式表单**

类型：

```ts
export interface ImageGenerationRequest {
  mode: 'image';
  prompt: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  referenceImagePaths?: string[];
  retryOf?: string;
}
```

`ImageForm` 保留原纯文字模式。参考模式调用共享 picker，显示 `<image1..4>` 编号和编辑说明。输出尺寸按 `resolveH3Resolution` 计算，参考输出保留第一张图宽高比，不把自定义比例强行拉伸到参考图上。

- [x] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/ipc.test.ts tests/unit/image-form.test.tsx tests/unit/resolution.test.ts && npm run typecheck`

- [x] **步骤 5：提交**

```bash
git add src/shared/types.ts src/shared/ipc.ts src/shared/image-options.ts src/shared/resolution.ts src/renderer/ImageForm.tsx tests/unit/ipc.test.ts tests/unit/image-form.test.tsx tests/unit/resolution.test.ts
git commit -m "Add Qwen reference image controls and 2K options"
```

实际完成：共享请求/分辨率提交 `a0b3cd85`，表单提交 `95099905`，生命周期修复 `5ab0eb3a`，极端尺寸校验 `cda31105`。最终 IPC/分辨率 305/305、表单 36/36，类型检查通过；规格与代码质量审查均通过。2MP 方形按 32 像素网格实际为 1440×1440，4MP 为 2048×2048。

### 任务 2：多图工作流补丁与上传

**文件：** `src/main/image-workflow.ts`、`src/main/image-generation.ts`、`tests/unit/image-workflow.test.ts`、`tests/unit/image-generation.test.ts`

- [ ] **步骤 1：编写失败测试**

用 1 张和 4 张图验证 `TextEncodeQwenImage21.images.image_N` 连接、VAE 连接、采样 latent `['452',2]`、prompt、seed、steps、输出前缀，且不经过 EmptyLatent。0 张保持原纯文字图。上传必须按顺序、按授权调用 `comfy.uploadFile`，失败/取消删除暂存文件，重试不重复节点。

参考分辨率按 `round(sqrt(width*height)/32)*32` 写入 TextEncode，4MP 时为 2048。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/image-workflow.test.ts tests/unit/image-generation.test.ts`

- [ ] **步骤 3：实现参考工作流和上传生命周期**

新增 `patchQwenReferenceImageWorkflow(frozen, request, uploadedNames)`：

```ts
text.inputs.vae = ['454', 0];
text.inputs.resolution = resolveReferenceResolution(width, height);
text.inputs.images = Object.fromEntries(
  uploadedNames.map((name, index) => [`image_${index + 1}`, [`ref${index + 1}`, 0]]),
);
sampler.inputs.latent_image = ['452', 2];
```

主进程按 workId 暂存参考图并逐个上传， LoadImage ID 使用 `ref1..ref4`。清理临时副本与节点只针对当前 workId。旧请求无 `referenceImagePaths` 时仍走原路径，旧作品重试不需要重新上传。

- [ ] **步骤 4：运行测试**

运行：`npx vitest run tests/unit/image-workflow.test.ts tests/unit/image-generation.test.ts tests/unit/ipc.test.ts && npm run typecheck`

- [ ] **步骤 5：提交**

```bash
git add src/main/image-workflow.ts src/main/image-generation.ts tests/unit/image-workflow.test.ts tests/unit/image-generation.test.ts tests/unit/ipc.test.ts
git commit -m "Generate Qwen images from multiple references"
```

### 任务 3：多图与 2K 的真实验收

- [ ] **步骤 1：Electron E2E**

用 1 张和 4 张授权图片完成模拟生成，验证请求、上传顺序、提交图、草稿、实际 `_00001.png` 预览和删除。覆盖 4MP 参数与窄窗口布局。

- [ ] **步骤 2：真实 Qwen 验收**

使用现有模型分别生成 1 张参考图和 4 张参考图，默认 25 步，记录输出尺寸、耗时和显存。4MP 参考输出使用实际 2K 节点分辨率，不运行提示词增强器。检查 `_00001.png` 非空白、作品可预览、可导入模特、可删除。

- [ ] **步骤 3：完整回归并提交结果**

运行类型检查、排除已知旧环境导入测试的 Vitest、studio/package E2E，将真实结果和未执行项写入本计划并只提交计划文件。
