# 制作台导航、语音兼容与作品基础实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 exFAT 下的本地 TTS 安装，增加克隆录音、左侧二级制作目录、共享参考图选择器，以及图像导入模特和分层作品筛选。

**架构：** 将 Python 安装根目录与模型/venv 解耦，Python 固定到 NTFS 的应用目录。制作模式由 `App` 统一控制，左侧导航只发出模式切换，不复制状态。共享参考图选择器只负责授权、预览和数量，后续 Qwen/H3 各自负责上传与工作流。

**技术栈：** Electron、React、TypeScript、uv、Vitest、Playwright。

**规格：** `docs/superpowers/specs/2026-11-11-studio-navigation-reference-media-design.md`

---

## 文件职责

- 修改 `src/main/speech-runtime.ts`、`tests/unit/speech-runtime.test.ts`：NTFS Python 安装目录和真实失败恢复。
- 修改 `src/renderer/SpeechForm.tsx`：克隆复用 `AudioRecorder`。
- 创建 `src/renderer/ReferenceImagePicker.tsx`：多图授权、拖入、预览、删除、数量上限。
- 修改 `src/renderer/App.tsx`、`StudioPage.tsx`、`styles.css`：受控二级导航和焦点。
- 修改 `src/main/media.ts`、`src/main/avatars.ts`、`src/renderer/WorksPage.tsx`、`App.tsx`：生成图导入模特。
- 修改 `src/renderer/WorksPage.tsx`、`styles.css`：类型/子类型/状态三级筛选。
- 修改对应单元与 E2E 测试。

### 任务 1：NTFS Python 安装与克隆录音

**文件：** `src/main/speech-runtime.ts`、`src/renderer/SpeechForm.tsx`、`tests/unit/speech-runtime.test.ts`、`tests/unit/speech-form.test.tsx`

- [ ] **步骤 1：编写失败测试**

验证默认 `UV_PYTHON_INSTALL_DIR` 位于 `%LOCALAPPDATA%\SMO-H3-Runtime\python`，而不是 G 盘组件目录；支持显式覆盖，uv 缓存和 venv 仍在组件目录。补克隆录音成功、权限失败保留旧参考音、重录替换、隐藏不丢状态测试。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/speech-runtime.test.ts tests/unit/speech-form.test.tsx -t "NTFS|录音|clone"`

预期：默认路径错误且克隆无录音入口。

- [ ] **步骤 3：实现路径解析和录音复用**

新增选项 `pythonInstallDirectory?: string`，默认使用绝对 `%LOCALAPPDATA%`，不支持时回退到组件目录。将该目录只用于 `UV_PYTHON_INSTALL_DIR`，不改变 `UV_PROJECT_ENVIRONMENT`、`UV_CACHE_DIR` 或模型路径。`prepare()` 继续检查实际 Python 和锁文件。

在克隆参考音区域加入：

```tsx
<AudioRecorder
  active={active && pageActive && speechMode === 'clone'}
  disabled={submitting || busy}
  hasAudio={referenceAudioPath !== null}
  onRecorded={handleReferenceAudioSelected}
  onError={setError}
/>
```

- [ ] **步骤 4：运行测试与 exFAT 实体验证**

运行：`npx vitest run tests/unit/speech-runtime.test.ts tests/unit/speech-form.test.tsx && npm run typecheck`

在当前 G 盘 exFAT 环境重新执行能力加载，确认不再出现 minor version link directory 错误；不删除旧模型或 ComfyUI Python。

- [ ] **步骤 5：提交**

```bash
git add src/main/speech-runtime.ts src/renderer/SpeechForm.tsx tests/unit/speech-runtime.test.ts tests/unit/speech-form.test.tsx
git commit -m "Fix TTS setup on exFAT and add clone recording"
```

### 任务 2：共享参考图选择器

**文件：** 创建 `src/renderer/ReferenceImagePicker.tsx`、`tests/unit/reference-image-picker.test.tsx`；修改 `src/renderer/styles.css`

- [ ] **步骤 1：编写失败测试**

覆盖 `paths/max/disabled/onChange`：逐张添加、一次多图拖入、超过上限拒绝、预览、删除、顺序保持、重复路径处理和慢授权不覆盖新操作。上限分别用 4 和 9 验证。

- [ ] **步骤 2：运行测试确认组件不存在**

运行：`npx vitest run tests/unit/reference-image-picker.test.tsx`

- [ ] **步骤 3：实现受控选择器**

组件契约：

```tsx
interface ReferenceImagePickerProps {
  paths: readonly string[];
  max: number;
  disabled?: boolean;
  onChange: (paths: string[]) => void;
  onError: (message: string | null) => void;
}
```

通过 `files.selectImage` 和 `files.authorizeDroppedImage` 获取授权路径，使用递增操作 ID 防止过期回调。每张图使用 `useMediaUrl` 预览，显示序号、文件名和删除图标按钮。不得要求头像或把当前模特隐式加入数组。

- [ ] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/reference-image-picker.test.tsx && npm run typecheck`

- [ ] **步骤 5：提交**

```bash
git add src/renderer/ReferenceImagePicker.tsx src/renderer/styles.css tests/unit/reference-image-picker.test.tsx
git commit -m "Add shared reference image picker"
```

### 任务 3：左侧二级制作目录

**文件：** `src/renderer/App.tsx`、`src/renderer/StudioPage.tsx`、`src/renderer/styles.css`、`tests/unit/studio.test.tsx`、`tests/e2e/studio.spec.ts`

- [ ] **步骤 1：编写失败测试**

验证父目录 `aria-expanded`、二级语音/图像/视频按钮、点击切页和模式、收起不卸载草稿、键盘焦点和 ARIA。StudioPage 不再显示重复主 tab，但视频细分仍存在。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/studio.test.tsx -t "二级|导航|目录"`

- [ ] **步骤 3：实现受控模式导航**

App 保存 `studioMode: 'speech'|'image'|'video'` 和 `studioExpanded`，点击父目录切换展开状态，子项同时设置 `page='studio'` 和 `studioMode`。使用 ChevronDown/ChevronRight、Mic/Image/Video 图标。StudioPage 接收受控 `mode` 和 `onModeChange`，保留内部视频子模式及 intent。

- [ ] **步骤 4：运行单元和 Electron 测试**

运行：`npx vitest run tests/unit/studio.test.tsx && npm run typecheck && npm run build && npx playwright test tests/e2e/studio.spec.ts`

- [ ] **步骤 5：提交**

```bash
git add src/renderer/App.tsx src/renderer/StudioPage.tsx src/renderer/styles.css tests/unit/studio.test.tsx tests/e2e/studio.spec.ts
git commit -m "Move studio modes into the sidebar"
```

### 任务 4：图像导入模特与作品筛选层级

**文件：** `src/main/media.ts`、`src/main/avatars.ts`、`src/renderer/App.tsx`、`src/renderer/WorksPage.tsx`、`src/renderer/styles.css`、`tests/unit/media-registry-options.test.ts`、`tests/unit/avatars.test.ts`、`tests/unit/studio.test.tsx`、`tests/e2e/studio.spec.ts`

- [ ] **步骤 1：编写失败测试**

验证受管输出图片可创建模特，根外图片仍需显式选择。点击“导入数字模特”只出现在完成的图像作品，复制独立资产并选中，原图保留，重复导入生成不同 UUID。

筛选断言：主层级“全部/语音/图像/视频”；视频子层级“全部视频/文字生视频/音频数字人”；状态“全部状态/运行中/已完成/失败”；组合筛选和 `aria-pressed` 正确。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/media-registry-options.test.ts tests/unit/avatars.test.ts tests/unit/studio.test.tsx -t "导入|筛选|managed"`

- [ ] **步骤 3：实现管理图片授权、导入和分层筛选**

`MediaRegistry.isSelectedImage` 与 `isSelectedFile` 一致，允许经过 realpath 验证的 managed roots。`AvatarService` 不改根外授权规则。WorksPage 调用 App 的 `onImportImage`，App 使用作品标题或短 ID 调用 `avatars.create`，切换数字模特页并选中。

将 `WorkFilter` 拆为 `workType`、`videoType`、`status`，组合时先按 mode，再按 status，视频子类型只在视频组显示。

- [ ] **步骤 4：运行相关测试和 E2E**

运行：`npx vitest run tests/unit/media-registry-options.test.ts tests/unit/avatars.test.ts tests/unit/studio.test.tsx && npm run typecheck && npm run build && npx playwright test tests/e2e/studio.spec.ts`

- [ ] **步骤 5：提交**

```bash
git add src/main/media.ts src/main/avatars.ts src/renderer/App.tsx src/renderer/WorksPage.tsx src/renderer/styles.css tests/unit/media-registry-options.test.ts tests/unit/avatars.test.ts tests/unit/studio.test.tsx tests/e2e/studio.spec.ts
git commit -m "Import generated images as avatars and organize work filters"
```

### 任务 5：基础链路验证

- [ ] **步骤 1：运行 `npm run typecheck`、排除已知旧环境导入测试的 Vitest、完整 studio E2E，并提交实际结果到本计划。**
- [ ] **步骤 2：在真实 G 盘环境确认 TTS capabilities 可加载、克隆录音可保存并授权。**
