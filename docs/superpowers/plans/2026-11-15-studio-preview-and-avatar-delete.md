# 制作台预览、独立提示词与数字模特删除实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。当前侧会话禁止使用子代理，全部内联执行。

**目标：** 制作台直接显示生成结果，独立文字/参考生图提示词，移除文生和图生视频的模特区域，并在保留历史作品的前提下删除数字模特。

**架构：** 以 `GenerationResultPreview` 和 `useWorkResult` 统一读取完成作品的媒体，不新增作品记录。`StudioPage` 仅在音频数字人显示模特。`ImageForm` 分离提示词状态。`Store.deleteAvatar` 通过事务解除历史关联，`AvatarService` 提交后删除照片。

**技术栈：** Electron、React、TypeScript、SQLite、Vitest、Playwright。

**规格：** `docs/superpowers/specs/2026-11-15-studio-sanmao-experience-design.md`

---

## 文件职责

- 新建 `src/renderer/GenerationResultPreview.tsx`：音频、图像、视频结果预览和操作。
- 新建 `src/renderer/useWorkResult.ts`：按 jobId 轮询完成作品并停止于终态。
- 修改 `src/renderer/SpeechForm.tsx`、`ImageForm.tsx`、`TextToVideoForm.tsx`、`AudioDigitalHumanForm.tsx`、`StudioPage.tsx`、`App.tsx`：接入预览和 `onOpenWorks`。
- 修改 `src/main/store.ts`、`src/main/avatars.ts`：历史保留事务和照片删除。
- 新建 `tests/unit/generation-result-preview.test.tsx`。
- 修改 `tests/unit/studio.test.tsx`、`tests/unit/image-form.test.tsx`、`tests/unit/avatars.test.ts`、`tests/e2e/studio.spec.ts`。

### 任务 1：共享结果预览

- [x] **步骤 1：编写失败测试**

创建 `tests/unit/generation-result-preview.test.tsx`，为 speech/image/text 三种完成作品分别断言出现 `audio`、`img`、`video`，保持 `controls` 和图片 `object-fit: contain`。未完成作品不渲染。点击“打开目录”调用 `files.openFolder(parentPath(outputPath))`，点击“进入我的作品”调用传入的 `onOpenWorks`。

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/generation-result-preview.test.tsx`

预期：找不到 `GenerationResultPreview` 和 `useWorkResult`。

- [x] **步骤 3：实现 hook 与预览**

`useWorkResult(jobId)` 在 jobId 非空时读取 `works.list()`，找到对应记录；每 500ms 轮询直到 done/failed 后停止，空 jobId 和卸载时取消。`GenerationResultPreview({ work, onOpenWorks })` 仅在 `work.status === 'done' && work.outputPath` 时渲染，使用 `useMediaUrl(work.outputPath)`，并按 mode 输出对应原生媒体。

- [x] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/generation-result-preview.test.tsx && npm run typecheck`

- [x] **步骤 5：提交**

```bash
git add src/renderer/GenerationResultPreview.tsx src/renderer/useWorkResult.ts tests/unit/generation-result-preview.test.tsx
git commit -m "Add shared generation result preview"
```

### 任务 2：制作台接入预览并移除文生/图生模特区域

- [ ] **步骤 1：编写失败测试**

在 `tests/unit/studio.test.tsx` 为语音、图像、文生视频、音频数字人分别断言完成后出现预览播放器。断言 `#video-main-panel` 在 text/reference 下没有 `section[aria-label="当前人物预览"]`，audio 下保留。断言可调用 `onOpenWorks` 进入仓库。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/studio.test.tsx -t "预览|当前人物预览"`

- [ ] **步骤 3：接入 `onOpenWorks` 和 `useWorkResult`**

`App` 传 `onOpenWorks={() => setPage('works')}` 给 `StudioPage`，再传至四种表单。表单在 `JobStatus` 后渲染 `GenerationResultPreview`。`StudioPage` 仅在 `videoMode === 'audio' && avatar !== null` 时渲染模特区域，text/reference 使用 `studio-layout-without-avatar`。

- [ ] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/studio.test.tsx tests/unit/generation-result-preview.test.tsx && npm run typecheck`

- [ ] **步骤 5：提交**

```bash
git add src/renderer/App.tsx src/renderer/StudioPage.tsx src/renderer/SpeechForm.tsx src/renderer/ImageForm.tsx src/renderer/TextToVideoForm.tsx src/renderer/AudioDigitalHumanForm.tsx tests/unit/studio.test.tsx
git commit -m "Preview generated media in the studio"
```

### 任务 3：独立文字与参考生图提示词

- [ ] **步骤 1：编写失败测试**

在 `tests/unit/image-form.test.tsx` 写入文字提示词 A，切到参考生图，断言输入框为空；写入参考提示词 B，切回文字生图，断言仍为 A。分别提交并断言 text 模式发送 A、reference 模式发送 B。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/image-form.test.tsx -t "提示词独立|独立提示词"`

- [ ] **步骤 3：分离状态和输入框**

将 `prompt` 改为 `textPrompt` 和 `referencePrompt`，使用 `text-image-prompt` 与 `reference-image-prompt` 两个 ID。当前模式的值用于 trim 和提交，切换只切换显示，不互相同步。

- [ ] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/image-form.test.tsx && npm run typecheck`

- [ ] **步骤 5：提交**

```bash
git add src/renderer/ImageForm.tsx tests/unit/image-form.test.tsx
git commit -m "Keep text and reference image prompts independent"
```

### 任务 4：保留历史作品的数字模特删除

- [ ] **步骤 1：编写失败测试**

在 `tests/unit/avatars.test.ts` 覆盖：有 done/failed 作品时可删除，未命名作品标题保留原模特名，`avatarId` 为 `NULL`，输出路径和媒体不变，照片删除，外键检查为空；pending/running 作品仍拒绝且模特与照片保留。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/avatars.test.ts -t "delete|删除|history|历史"`

预期：当前抛出 `Avatar cannot be deleted while works exist`。

- [ ] **步骤 3：实现删除事务和照片清理**

`Store.deleteAvatar` 在单个事务中检查活动作品，给无标题历史作品写入原模特名，解除 `avatarId`，删除模特并返回 avatar。`AvatarService.deleteAvatar` 仅在事务成功后执行受管路径照片删除。禁止关闭外键或删除作品。

- [ ] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/avatars.test.ts tests/unit/store.test.ts && npm run typecheck`

- [ ] **步骤 5：提交**

```bash
git add src/main/store.ts src/main/avatars.ts tests/unit/avatars.test.ts
git commit -m "Preserve works when deleting avatars"
```

### 任务 5：完整验证

- [ ] **步骤 1：运行自动回归**

```powershell
npm run typecheck
npx vitest run --exclude tests/unit/environment-wizard.test.tsx --reporter=dot
npm run test:e2e -- tests/e2e/studio.spec.ts
```

- [ ] **步骤 2：补充 Electron 验证并提交**

在 `tests/e2e/studio.spec.ts` 验证三种播放器、文生/图生无模特区域、删除模特后作品仍可播放。通过后只提交本计划相关代码、测试和本计划文件。
