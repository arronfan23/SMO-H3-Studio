# H3 文生与多参考视频实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 支持无参考图文生视频，以及 1-9 张参考图的图片生视频，并将两类画面视频与音频数字人清晰区分。

**架构：** 沿用当前 H3 工作流。无参考时把 `MiniMaxH3ReferenceToVideo` 替换为 `MiniMaxH3ImageToVideo` 并删除全部 `ref_images.*`；多参考时保留 Ref2VA 节点并按 ComfyUI Autogrow 契约动态连接扁平键 `ref_images.ref_image_0..8`。请求沿用 `mode: 'text'`，以参考数组和可空 avatarId 区分输入，不迁移旧作品。

**技术栈：** MiniMax H3、Electron、React、TypeScript、Zod、Vitest、Playwright。

**规格：** `docs/superpowers/specs/2026-11-11-studio-navigation-reference-media-design.md`

**前置：** `docs/superpowers/plans/2026-11-11-studio-foundation.md`

---

## 文件职责

- 修改 `src/shared/types.ts`、`src/shared/ipc.ts`：可空 avatarId 和 `referenceImagePaths`。
- 修改 `src/main/generation.ts`、`src/shared/workflow-nodes.ts`：无参考替换和多参考连接。
- 修改 `src/renderer/TextToVideoForm.tsx`、`StudioPage.tsx`：三类视频模式及可选模特。
- 修改 `src/main/llm.ts`：按 0-9 张图和 t2va/ref2va 润色。
- 新增对应单元和 E2E 测试。

### 任务 1：无参考视频请求与工作流

**文件：** `src/shared/types.ts`、`src/shared/ipc.ts`、`src/main/generation.ts`、`src/shared/workflow-nodes.ts`、`tests/unit/ipc.test.ts`、`tests/unit/generation.test.ts`

- [x] **步骤 1：编写失败测试**

验证 `mode:'text'`、`avatarId:null`、`referenceImagePaths:[]` 合法且不上传图片；提交图中 `MiniMaxH3ImageToVideo` 没有任何 `ref_images.*`，其他调度、Spark、步数、输出不变。旧请求含 avatarId 仍走原 Ref2VA。

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/ipc.test.ts tests/unit/generation.test.ts -t "no reference|无参考"`

- [x] **步骤 3：实现可空输入和无参考替换**

```ts
interface VideoGenerationRequest {
  mode: VideoMode;
  avatarId: string | null;
  referenceImagePaths?: string[];
  // 其余现有字段保持
}
```

`referenceImagePaths` 缺省为 `[]`。无参考且 avatarId 为空时不再读取模特，work.avatarId=null。将 ReferenceToVideo 改为 ImageToVideo 并删除 ref_images 输入；不上传头像。保留所有调度器、输出和低步数 Refiner 修补。

- [x] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/ipc.test.ts tests/unit/generation.test.ts && npm run typecheck`

- [x] **步骤 5：提交**

```bash
git add src/shared/types.ts src/shared/ipc.ts src/main/generation.ts src/shared/workflow-nodes.ts tests/unit/ipc.test.ts tests/unit/generation.test.ts
git commit -m "Allow H3 text to video without a reference image"
```

实际完成：`30d618f2`。无参考专项 22/22、IPC/generation 413/413，类型检查通过；规格与代码质量审查均通过。旧 avatar 与 audio 行为保持，refs>0 在下一阶段接入前会明确拒绝且不建作品。审查仅记录一个覆盖缺口：无参考+SM120+1 step 将在任务 4 的真实低负载验收中覆盖。

### 任务 2：1-9 张参考图上传与 Ref2VA 连接

**文件：** `src/main/generation.ts`、`src/shared/workflow-nodes.ts`、`tests/unit/generation.test.ts`

- [x] **步骤 1：编写失败测试**

用 1 张和 9 张验证扁平键 `ref_images.ref_image_0..8` 顺序、`MiniMaxH3ReferenceToVideo` 保留、上传授权、临时文件清理、取消和重试不重复节点。超过 9、空数组元素和未授权路径拒绝。

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/generation.test.ts -t "reference images|参考图"`

- [x] **步骤 3：实现多图上传与动态节点**

参考路径长度 1-9 时按顺序调用 `comfy.uploadFile({kind:'image'})`，首图使用现有节点 226，其他 LoadImage 节点使用 `ref2..ref9`：

```ts
uploaded.forEach((name, index) => {
  refNode.inputs[`ref_images.ref_image_${index}`] = [
    index === 0 ? '226' : `ref${index + 1}`,
    0,
  ];
});
```

数组存在时只使用数组，不隐式重复当前模特。旧请求只有 avatarId 时维持原一张 Ref2VA 行为。

注意：本机 Autogrow 诊断已证实嵌套 `ref_images` 会被忽略，扁平 `ref_images.ref_image_N` 才进入执行图；前缀索引为 0-8，对应第 1-9 张图，提示词标签仍是 `<Picture 1>` 至 `<Picture 9>`。

- [x] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/generation.test.ts tests/unit/ipc.test.ts && npm run typecheck`

- [x] **步骤 5：提交**

```bash
git add src/main/generation.ts src/shared/workflow-nodes.ts tests/unit/generation.test.ts tests/unit/ipc.test.ts
git commit -m "Support up to nine H3 reference images"
```

实际完成：`898ba9be`。参考图专项 15/15、generation+IPC 426/426，类型检查通过；规格与代码质量审查均通过。数组存在时只使用数组，works.avatarId=null 以避免弃用模特关联，原 avatarId 与有序 refs 保留在 metadata；重启重试会重新验证并授权参考图。

### 任务 3：三类视频 UI 与提示词润色

**文件：** `src/renderer/TextToVideoForm.tsx`、`src/renderer/StudioPage.tsx`、`src/main/llm.ts`、`tests/unit/studio.test.tsx`、`tests/e2e/studio.spec.ts`

- [x] **步骤 1：编写失败测试**

验证视频细分为“文生视频 / 图片生视频 / 音频数字人”。文生视频无模特可提交，图片生视频必须至少一张、最多九张；当前模特仅能通过显式按钮加入，不自动注入。三类草稿、焦点和 busy 保持。

润色验证：无参考时 `imageCount:0/mode:t2va/referenceLabels:[]`；N 图时 `imageCount:N/mode:ref2va` 且 labels 为 Picture1..N。

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/studio.test.tsx -t "文生视频|图片生视频|无模特"`

- [x] **步骤 3：实现三类表单和润色输入**

videoMode 改为 `'text'|'reference'|'audio'`。文字面板 `avatarId=null/referenceImagePaths=[]`；参考面板使用共享 picker，只有 `avatar` 存在时显示“使用当前模特”按钮。无 avatar 不再显示全页空状态，参考模式不强制模特预览。

单元阶段实际完成：三类 UI `5bd75d51`，润色失效与跨表单互斥 `2ff34780`，busy 交接 `1fea4775`。完整 Studio 单元 200/200、类型检查通过；规格与代码质量审查均通过。Electron 与提交记录见下一步。

- [x] **步骤 4：运行单元、类型和 Electron 测试**

运行：`npx vitest run tests/unit/studio.test.tsx && npm run typecheck && npm run build && npx playwright test tests/e2e/studio.spec.ts`

- [x] **步骤 5：提交**

```bash
git add src/renderer/TextToVideoForm.tsx src/renderer/StudioPage.tsx src/main/llm.ts tests/unit/studio.test.tsx tests/e2e/studio.spec.ts
git commit -m "Separate text and reference H3 video modes"
```

Electron 与实际提交记录：三类 UI `5bd75d51`，润色失效与互斥 `2ff34780`，busy 交接 `1fea4775`，三类 E2E `ef4395b2`，隐私断言修正 `6575b0b2`，上传字节/全消息/T2VA 二次生成补强 `4ae649b8`。最终 Studio 单元 200/200、定向 E2E 3/3、完整 Studio E2E 26/26、类型检查通过；规格与代码质量审查均通过。

### 任务 4：真实视频验收

- [x] **步骤 1：无参考真实生成**

用固定提示词和 1 step 低负载运行 4 秒无参考视频，确认无图像上传、MiniMaxH3ImageToVideo 节点、非空输出和任务锁释放。

- [x] **步骤 2：多参考真实生成**

用 1 张和 9 张合成参考图分别运行 Ref2VA，检查上传顺序、ref_image 连接、Spark/transition 与非空输出。删除测试作品后无媒体残留，用户原图不动。

#### 2026-11-11 最终合并真实验收（生产代码 `6575b0b2`）

**结论：PASS。** 真实 Electron + ComfyUI，A→B→C 顺序执行，均为 0.3MP、4 秒、1 step、seed `20261111`，未调用 LLM 或提示词增强。证据：`G:\SMO-H3-Verification\h3-video-real-20261111\acceptance-report.md` 与 `acceptance-summary.json`。

- A 无模特文生：`MiniMaxH3ImageToVideo`，无 226、`audio_vae`、`ref_image_size`、`ref_images.*`，零图片上传。生成墙钟 **5.138 秒**（缓存后），峰值 **14,277 MiB**。
- B 无模特 1 图：`ref_images.ref_image_0 -> ['226',0]`，仅 1 张上传。生成墙钟 **45.175 秒**，峰值 **15,270 MiB**。
- C 无模特 9 图：`ref_images.ref_image_0..8` 顺序连接 `226,ref2..ref9`，9 张上传。生成墙钟 **50.239 秒**，峰值 **15,441 MiB**。
- 三案均确认 Spark SM120、`transition_step=1`、1 步 `H3SigmaRefiner(start_at_sigma=20)` 和 MP4 输出节点。
- 三案视频均为 **736×416、4.458333 秒、24fps**，文件非空，首/中/尾抽帧经 sharp 和人工查看均非空白；作品页 `readyState=4` 可预览。
- 三案最终 `jobs.getState.activeId=null`、ComfyUI 队列空闲；作品和输出删除成功，`data/uploads` 无暂存残留，测试上传按精确 workId 文件名清理，参考原图哈希不变。
- 首次 harness 选择器错误发生在提交前并已单独归档；最终合并轮无未执行项，ComfyUI 0.38.0 / RTX 5080 结束健康。

- [ ] **步骤 3：完整回归并记录**

运行类型检查、排除已知旧环境导入测试的 Vitest、studio/package E2E，将结果写入本计划并只提交计划文件。
