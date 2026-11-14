# SMO.H3 Studio 整体 UI 与交互调整实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完成托盘驻停、制作台交互、照片拖放、作品管理和硬件设置优化，并用自动化测试验证真实行为。

**架构：** 沿用现有 Electron 主进程、严格 IPC、React 页面和 SQLite 数据层。托盘与文件授权保持主进程边界；作品标题和完成时间通过增量列迁移；生成与硬件逻辑继续复用现有 H3 工作流，不重写模型或运行环境。

**技术栈：** Electron、React、TypeScript、Zod、Node:sqlite、Vitest、Playwright、electron-builder。

**分支与规格：** `codex/runtime-in-app-repo`；规格为 `docs/superpowers/specs/2026-10-31-smo-h3-ui-interaction-design.md`。

---

## 文件结构与职责

- `src/main/tray.ts`：托盘创建、恢复窗口与退出动作。
- `src/main/index.ts`：关闭到托盘和唯一退出清理。
- `src/shared/generation-options.ts`：分辨率选项和默认生成选项，不再包含字幕。
- `src/main/generation.ts`：移除新任务的字幕提示词注入，记录完成时间。
- `src/shared/prompt-contract.ts`：中英文旁白收尾校验。
- `src/main/skills.ts`：仅针对 `Missing narration tail` 的结构化修复。
- `src/renderer/AudioDigitalHumanForm.tsx`：音频原文、润色结果和生成流程。
- `src/main/files.ts`、`src/shared/ipc.ts`、`src/main/ipc.ts`、`src/preload/index.ts`：拖放图片的严格授权通道。
- `src/renderer/AvatarsPage.tsx`：单文件拖放、预览和错误状态。
- `src/shared/types.ts`：作品标题、完成时间和兼容元数据。
- `src/main/store.ts`：作品新列迁移、读取和更新。
- `src/main/works.ts`：作品重命名与关联资产安全删除。
- `src/renderer/WorksPage.tsx`：标题、耗时和重命名交互。
- `src/main/hardware.ts`：PowerShell UTF-8 输出。
- `src/renderer/SettingsPage.tsx`：自动推荐和中文硬件场景说明。

### 任务 1：托盘驻停与真实退出

**文件：** 创建 `src/main/tray.ts`、`tests/unit/tray.test.ts`；修改 `src/main/index.ts`。

- [ ] **步骤 1：编写托盘行为失败测试**

```ts
test('close hides the window while quit closes services once', async () => {
  const controller = createTrayController({ window, tray, menu, onQuit });
  controller.handleClose();
  expect(window.hide).toHaveBeenCalledTimes(1);
  expect(onQuit).not.toHaveBeenCalled();
  await controller.quit();
  await controller.quit();
  expect(onQuit).toHaveBeenCalledTimes(1);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/tray.test.ts`
预期：模块不存在，`createTrayController` 无法导入。

- [ ] **步骤 3：实现托盘控制器并接入主窗口**

```ts
export function createTrayController({ window, tray, menu, onQuit }) {
  let quitRequested = false;
  return {
    handleClose: () => window.hide(),
    open: () => window.isDestroyed() ? menu.createWindow() : window.show(),
    quit: async () => {
      if (quitRequested) return;
      quitRequested = true;
      await onQuit();
    },
  };
}
```

主进程创建托盘并接管关闭事件，`window-all-closed` 不再直接 `app.quit()`，只有托盘退出调用现有服务清理。

- [ ] **步骤 4：运行托盘与启动回归测试**

运行：`npx vitest run tests/unit/tray.test.ts tests/unit/bootstrap.test.ts tests/unit/bootstrap-cleanup.test.ts`
预期：全部通过，关闭隐藏与退出清理不混用。

- [ ] **步骤 5：提交**

```bash
git add src/main/tray.ts src/main/index.ts tests/unit/tray.test.ts
git commit -m "Add tray lifecycle"
```

### 任务 2：移除字幕并扩展生成选项

**文件：** 修改 `src/shared/generation-options.ts`、`src/shared/types.ts`、`src/main/generation.ts`、`src/renderer/GenerationOptions.tsx`、`src/renderer/TextToVideoForm.tsx` 及相关测试。

- [ ] **步骤 1：更新测试以要求新行为**

```ts
expect(RESOLUTION_OPTIONS.map((option) => option.value)).toEqual([
  0.3, 0.4, 0.55, 0.7, 0.85, 1, 1.2,
]);
expect(DEFAULT_GENERATION_OPTIONS).not.toHaveProperty('subtitles');
expect(screen.getByLabelText('视频风格（Skill）')).toHaveValue('h3-prompt-writing');
expect(screen.queryByLabelText('生成画面内字幕')).not.toBeInTheDocument();
```

- [ ] **步骤 2：运行测试确认旧实现失败**

运行：`npx vitest run tests/unit/skill-options.test.ts tests/unit/resolution.test.ts tests/unit/generation.test.ts tests/unit/studio.test.tsx`
预期：旧三档分辨率、默认 `auto` 和字幕入口导致失败。

- [ ] **步骤 3：实现新选项并删除字幕路径**

将 `ResolutionMegapixels` 扩展为 `0.3 | 0.4 | 0.55 | 0.7 | 0.85 | 1 | 1.2`，保持默认 0.7。删除 `GenerationOptionsValue.subtitles`、复选框和 `withSubtitlePreference` 调用；旧元数据仅作记录读取，重试不再追加字幕。文字 Skill 初始值改为 `h3-prompt-writing`。

- [ ] **步骤 4：运行生成选项回归**

运行：`npx vitest run tests/unit/skill-options.test.ts tests/unit/resolution.test.ts tests/unit/generation.test.ts tests/unit/studio.test.tsx`
预期：全部通过，提交给 ComfyUI 的提示词不含字幕注入。

- [ ] **步骤 5：提交**

```bash
git add src/shared/generation-options.ts src/shared/types.ts src/main/generation.ts src/renderer/GenerationOptions.tsx src/renderer/TextToVideoForm.tsx tests
git commit -m "Update generation options and remove subtitles"
```

### 任务 3：定向修复润色旁白收尾

**文件：** 修改 `src/shared/prompt-contract.ts`、`src/main/skills.ts`、`tests/unit/prompt-contract.test.ts`、`tests/unit/skills.test.ts`。

- [ ] **步骤 1：添加中文收尾和定向修复失败测试**

```ts
expect(validatePrompt(promptWithChineseNonNarrationTail, 'ref2va', 12, original)).toEqual([]);
expect(validatePrompt(promptWithConflictingTail, 'ref2va', 12, original)).toContain('Missing narration tail');

const result = await service.polish(profile, requestWithOnlyTailMissing);
expect(result.text).toContain('The final 2 seconds contain no narration, dialogue, or other speech');
expect(validatePrompt(result.text, result.mode, 8, request.text)).toEqual([]);
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/prompt-contract.test.ts tests/unit/skills.test.ts`
预期：中文声明被误拒，单次收尾错误最终抛出 `PromptPolishError`。

- [ ] **步骤 3：实现中英文校验与结构化补尾**

仅在 `issues.length === 1 && issues[0] === 'Missing narration tail'` 时，在描述字段与 `overall_soundscape:` 之间插入：

```ts
const NON_NARRATION_TAIL =
  'The final 2 seconds contain no narration, dialogue, or other speech; ' +
  'only ambient sound, music, or visuals remain.';
```

插入后必须重新运行完整 `validatePrompt`，其他错误仍然抛出。

- [ ] **步骤 4：运行润色合同回归**

运行：`npx vitest run tests/unit/prompt-contract.test.ts tests/unit/skills.test.ts`
预期：全部通过，字段缺失、对白变更和时间戳错误不被跳过。

- [ ] **步骤 5：提交**

```bash
git add src/shared/prompt-contract.ts src/main/skills.ts tests/unit/prompt-contract.test.ts tests/unit/skills.test.ts
git commit -m "Repair narration tail validation"
```

### 任务 4：音频数字人 AI 润色

**文件：** 修改 `src/renderer/AudioDigitalHumanForm.tsx`、`tests/unit/studio.test.tsx`、`tests/e2e/studio.spec.ts`。

- [ ] **步骤 1：编写音频润色失败测试**

```ts
await user.click(screen.getByRole('button', { name: 'AI 润色' }));
expect(window.smo.llm.polish).toHaveBeenCalledWith({
  text: '看镜头并自然挥手',
  duration: 6,
  imageCount: 1,
  mode: 'ref2va',
  referenceLabels: ['<Picture 1>', '<Audio 1>'],
  skill: 'h3-prompt-writing',
});
expect(request).not.toHaveProperty('audioPath');
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/studio.test.tsx`
预期：音频面板没有 AI 润色按钮和润色结果页。

- [ ] **步骤 3：实现音频原文与润色结果状态**

复用文字模式的 `originalText`、`polishedText`、`activeTab`、`skill` 和 `polishing` 状态。实际截取时长通过现有校验后再调用 LLM，润色失败保留原文和音频。

- [ ] **步骤 4：运行音频与完整制作台测试**

运行：`npx vitest run tests/unit/studio.test.tsx tests/unit/skills.test.ts`
预期：全部通过，生成使用用户最终确认的文本。

- [ ] **步骤 5：提交**

```bash
git add src/renderer/AudioDigitalHumanForm.tsx tests/unit/studio.test.tsx tests/e2e/studio.spec.ts
git commit -m "Add audio prompt polishing"
```

### 任务 5：数字模特照片拖放授权

**文件：** 修改 `src/main/files.ts`、`src/shared/ipc.ts`、`src/main/ipc.ts`、`src/preload/index.ts`、`src/renderer/AvatarsPage.tsx` 及相关测试。

- [ ] **步骤 1：编写拖放授权失败测试**

```ts
await expect(files.authorizeDroppedImage(droppedPath)).resolves.toBe(droppedPath);
expect(mediaRegistry.authorizeSelectedImage).toHaveBeenCalledWith(droppedPath);

fireEvent.drop(dropZone, { dataTransfer: { files: [imageFile] } });
expect(await screen.findByRole('img', { name: '待保存模特照片预览' })).toBeInTheDocument();
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/files.test.ts tests/unit/ipc.test.ts tests/unit/studio.test.tsx`
预期：授权方法和拖放区域不存在。

- [ ] **步骤 3：实现严格 IPC 和单文件拖放**

新增 `files:authorizeDroppedImage`，仅接受 `{ path: string }`，主进程调用 `authorizeSelectedImage` 后返回同一路径。页面拒绝多文件和非法扩展名，保留预览、错误和移除状态。

- [ ] **步骤 4：运行授权与模特测试**

运行：`npx vitest run tests/unit/files.test.ts tests/unit/ipc.test.ts tests/unit/avatars.test.ts tests/unit/studio.test.tsx`
预期：全部通过，未授权路径不能直接创建模特。

- [ ] **步骤 5：提交**

```bash
git add src/main/files.ts src/shared/ipc.ts src/main/ipc.ts src/preload/index.ts src/renderer/AvatarsPage.tsx tests
git commit -m "Support avatar photo drag and drop"
```

### 任务 6：作品标题、完成时间与重命名

**文件：** 修改 `src/shared/types.ts`、`src/main/store.ts`、`src/main/generation.ts`、`src/main/works.ts`、`src/shared/ipc.ts`、`src/main/ipc.ts`、`src/preload/index.ts`、`src/renderer/WorksPage.tsx` 及相关测试。

- [ ] **步骤 1：编写迁移、耗时和重命名失败测试**

```ts
const work = store.addWork({
  id: 'work-1',
  avatarId: 'avatar-1',
  mode: 'text',
  outputPath: null,
  status: 'done',
  title: '默认作品',
});
store.updateWork(work.id, { title: '我的口播', completedAt: '2026-10-31T08:01:00.000Z' });
expect(store.getWork(work.id)).toMatchObject({ title: '我的口播', completedAt: '2026-10-31T08:01:00.000Z' });
expect(formatWorkDuration(work)).toBe('1分00秒');
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/store.test.ts tests/unit/works.test.ts tests/unit/studio.test.tsx`
预期：新列、耗时和重命名通道不存在。

- [ ] **步骤 3：实现增量迁移与作品编辑**

新增 `title`、`completedAt` 可空列并加入 `WORK_COLUMNS` 和允许更新字段。完成时写入 `completedAt`，空标题回退模特名。新增 `works:rename`，只更新数据库标题。

- [ ] **步骤 4：运行存储与作品页面测试**

运行：`npx vitest run tests/unit/store.test.ts tests/unit/works.test.ts tests/unit/ipc.test.ts tests/unit/studio.test.tsx`
预期：全部通过，旧记录无标题或时间时不出现空白页面。

- [ ] **步骤 5：提交**

```bash
git add src/shared/types.ts src/main/store.ts src/main/generation.ts src/main/works.ts src/shared/ipc.ts src/main/ipc.ts src/preload/index.ts src/renderer/WorksPage.tsx tests
git commit -m "Add work titles and completion times"
```

### 任务 7：删除作品关联资产

**文件：** 修改 `src/main/works.ts`、`tests/unit/works.test.ts`、`tests/e2e/studio.spec.ts`。

- [ ] **步骤 1：编写真实文件删除失败测试**

```ts
await service.deleteWork(done.id);
expect(existsSync(videoPath)).toBe(false);
expect(existsSync(imagePath)).toBe(false);
expect(existsSync(otherWorkImage)).toBe(true);
expect(existsSync(avatarSource)).toBe(true);
expect(store.getWork(done.id)).toBeNull();
```

同时覆盖目录穿越、符号链接、非任务文件、删除失败保留记录。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/works.test.ts`
预期：视频被删除但关联图片残留。

- [ ] **步骤 3：实现候选收集与安全删除**

以 `dirname(outputPath)` 为唯一候选目录，文件名必须满足 `name === workId`、`name.startsWith(workId + '.')` 或 `name.startsWith(workId + '_')`，扩展名限于现有图片、视频和音频格式。逐项执行 `lstat`、真实路径和常规文件校验后再删除，最后删除数据库记录。

- [ ] **步骤 4：运行作品删除与 E2E 回归**

运行：`npx vitest run tests/unit/works.test.ts tests/unit/studio.test.tsx`
预期：全部通过，其他作品和用户素材不变。

- [ ] **步骤 5：提交**

```bash
git add src/main/works.ts tests/unit/works.test.ts tests/e2e/studio.spec.ts
git commit -m "Delete all work output assets"
```

### 任务 8：Windows 编码与硬件设置逻辑

**文件：** 修改 `src/main/hardware.ts`、`src/renderer/SettingsPage.tsx`、`tests/unit/hardware.test.ts`、`tests/unit/settings-hardware.test.tsx`。

- [ ] **步骤 1：编写中文输出和自动推荐失败测试**

```ts
expect(powershellScript).toContain('[Console]::OutputEncoding');
expect(info.windowsVersion).toBe('Microsoft Windows 10 专业版 10.0.19045');

await user.click(screen.getByRole('button', { name: '检测硬件' }));
expect(await screen.findByText('均衡配置')).toBeInTheDocument();
expect(screen.getByText('下一次生成时生效')).toBeInTheDocument();
expect(screen.queryByRole('button', { name: '获取推荐' })).not.toBeInTheDocument();
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/hardware.test.ts tests/unit/settings-hardware.test.tsx`
预期：缺少 UTF-8 设置，仍需手动获取推荐并显示英文术语。

- [ ] **步骤 3：实现编码修复与中文推荐流程**

在 PowerShell 脚本开头加入 `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);`。检测成功后自动调用现有 `recommendHardware`，用中文展示模型、显存策略、分辨率和平铺，并注明下一次生成生效。

- [ ] **步骤 4：运行硬件与设置回归**

运行：`npx vitest run tests/unit/hardware.test.ts tests/unit/settings-hardware.test.tsx tests/unit/studio.test.tsx`
预期：全部通过，应用和恢复默认仍需确认。

- [ ] **步骤 5：提交**

```bash
git add src/main/hardware.ts src/renderer/SettingsPage.tsx tests/unit/hardware.test.ts tests/unit/settings-hardware.test.tsx
git commit -m "Clarify hardware settings and Windows encoding"
```

### 任务 9：完整验收与 0.3.0 发布

**文件：** 修改 `package.json`、`package-lock.json`、相关 E2E 和发布文档。

- [ ] **步骤 1：运行完整自动验证**

```bash
npm test
npm run typecheck
npm run test:e2e
git diff --check
```

预期：全部通过且无未提交异常变更。

- [ ] **步骤 2：构建并验证打包态**

```bash
npm version 0.3.0 --no-git-tag-version
npm run assets
npm run pack
npm run test:e2e:package
```

预期：portable 构建成功，打包测试全部通过，运行环境资源完整。

- [ ] **步骤 3：更新发布物**

将新 portable 复制到 `G:\SMO-H3-Studio\release\SMO.H3-Studio-0.3.0.exe`，核对 SHA256，运行 `scripts/create-shortcut.ps1` 更新桌面快捷方式，并推送当前分支更新 PR。

- [ ] **步骤 4：提交发布准备**

```bash
git add package.json package-lock.json docs tests
git commit -m "Release SMO.H3 Studio 0.3.0"
```

最终报告必须列出实际测试数量、发布物路径与 SHA256；未实测硬件继续标为候选，不配置代码签名时不作签名声明。
