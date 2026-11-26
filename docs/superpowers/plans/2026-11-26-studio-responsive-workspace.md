# 制作台响应式工作区实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将语音、图像和视频制作台改造成随可用宽度重排的双栏工作区，修复生成媒体溢出，并把重复的语音入口合并为单一“声音生成”流程。

**架构：** 新增只负责排布的 `StudioWorkspace`，各表单继续持有自己的草稿和任务状态，输出区只组合现有 `JobStatus` 与 `GenerationResultPreview`。CSS 使用制作台容器查询控制双栏，媒体规则统一限制尺寸；语音 UI 根据可选情绪文本选择现有 `custom` 或 `clone` 请求，后端契约与旧作品不变。

**技术栈：** Electron 45、React 19、TypeScript、CSS Container Queries、Vitest、Testing Library、Playwright、electron-builder。

---

## 文件结构

- 创建 `src/renderer/StudioWorkspace.tsx`：提供编辑区与输出区的语义化布局。
- 修改 `src/renderer/GenerationResultPreview.tsx`：保留结果区域、显示真实空状态并使用统一媒体类名。
- 修改 `src/renderer/SpeechForm.tsx`：合并语音入口，按情绪文本路由现有推理模式。
- 修改 `src/renderer/ImageForm.tsx`：将现有图像编辑与输出分区，不改提交逻辑。
- 修改 `src/renderer/TextToVideoForm.tsx`：将文生与参考生视频编辑与输出分区。
- 修改 `src/renderer/AudioDigitalHumanForm.tsx`：将数字人编辑与输出分区，并接收可选当前模特用于编辑区内预览。
- 修改 `src/renderer/StudioPage.tsx`：移除外层音频人物列，把当前模特传入数字人表单。
- 修改 `src/renderer/styles.css`：实现容器查询、面板收缩、参数自适应、人物横排和媒体防溢出。
- 修改 `tests/unit/generation-result-preview.test.tsx`：覆盖空状态和三类媒体。
- 创建 `tests/unit/studio-workspace.test.tsx`：覆盖共享区域的语义与顺序。
- 修改 `tests/unit/speech-form.test.tsx`、`tests/unit/image-form.test.tsx`、`tests/unit/studio.test.tsx`：覆盖合并后的语音行为和现有表单回归。
- 修改 `tests/e2e/studio.spec.ts`：覆盖真实窗口尺寸切换、结果缩放和草稿保留。
- 修改 `package.json`、`package-lock.json`：发布版本升至 `0.6.3`。

### 任务 1：共享工作区与结果容器

**文件：** `src/renderer/StudioWorkspace.tsx`、`src/renderer/GenerationResultPreview.tsx`、`src/renderer/styles.css`、`tests/unit/studio-workspace.test.tsx`、`tests/unit/generation-result-preview.test.tsx`

- [x] **步骤 1：编写共享结构和空状态的失败测试**

```tsx
test('keeps editor before the labelled output region', () => {
  render(<StudioWorkspace editor={<div>编辑控件</div>} output={<div>输出内容</div>} />);
  expect(screen.getByText('编辑控件')).toBeInTheDocument();
  const output = screen.getByRole('complementary', { name: '任务与结果' });
  expect(within(output).getByText('输出内容')).toBeInTheDocument();
  expect(document.querySelector('.studio-editor-pane')).toHaveTextContent('编辑控件');
});

test('keeps an empty result region without querying works when there is no job', () => {
  const api = mockApi(null);
  render(<GenerationResultPreview jobId={null} onOpenWorks={vi.fn()} />);
  expect(screen.getByRole('region', { name: '生成结果预览' })).toBeVisible();
  expect(screen.getByText('完成生成后在这里预览')).toBeVisible();
  expect(api.works.list).not.toHaveBeenCalled();
});
```

- [x] **步骤 2：运行测试并确认因结构缺失而失败**

运行：`npx vitest run tests/unit/studio-workspace.test.tsx tests/unit/generation-result-preview.test.tsx --reporter=dot`

预期：FAIL；找不到 `StudioWorkspace` 或“任务与结果 / 生成结果预览”，而不是测试语法错误。

- [x] **步骤 3：实现共享组件与稳定结果区域**

```tsx
import type { ReactNode } from 'react';

export function StudioWorkspace({ editor, output }: { editor: ReactNode; output: ReactNode }) {
  return (
    <div className="studio-workspace-grid">
      <div className="studio-editor-pane">{editor}</div>
      <aside className="studio-output-pane" aria-label="任务与结果">
        <h2 className="studio-output-title">任务与结果</h2>
        {output}
      </aside>
    </div>
  );
}
```

`GenerationResultPreview` 在 `work === null` 或未完成时返回带有 `aria-label="生成结果预览"` 的 `section.generation-result`，其中包含“生成结果”标题和 `.generation-result-empty` 空状态；已有任务仍保留原轮询、错误、媒体与操作逻辑。媒体不再使用内联样式，改为 `.generation-result-image`、`.generation-result-video`、`.generation-result-audio`。

- [x] **步骤 4：实现容器与媒体基础样式**

```css
.studio-page { max-width: 1440px; container-type: inline-size; }
.studio-page .production-controls { padding: 0; background: transparent; border: 0; }
.speech-controls, .image-controls { max-width: none; }
.studio-workspace-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; align-items: start; }
.studio-editor-pane, .studio-output-pane { min-width: 0; padding: 18px; background: #fff; border: 1px solid #dce3dd; border-radius: var(--radius-panel); }
.studio-output-title { margin: 0 0 14px; font-size: 18px; }
.generation-result { min-width: 0; }
.generation-result-empty { display: grid; place-items: center; min-height: 220px; padding: 24px; color: #536058; text-align: center; background: #f2f5f2; border-radius: var(--radius-control); }
.generation-result-image, .generation-result-video { display: block; width: auto; max-width: 100%; height: auto; max-height: min(62vh, 720px); margin-inline: auto; object-fit: contain; }
.generation-result-video { width: 100%; background: #1d211e; }
.generation-result-audio { display: block; width: 100%; max-width: 100%; }
.generation-result-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.generation-result-actions .button { flex: 1 1 140px; }
@container (min-width: 1024px) {
  .studio-workspace-grid { grid-template-columns: minmax(0, 1.15fr) minmax(320px, .85fr); }
}
@media (min-height: 700px) {
  @container (min-width: 1024px) { .studio-output-pane { position: sticky; top: 0; } }
}
```

- [x] **步骤 5：运行测试并提交**

运行：`npx vitest run tests/unit/studio-workspace.test.tsx tests/unit/generation-result-preview.test.tsx --reporter=dot`

预期：PASS。

```bash
git add src/renderer/StudioWorkspace.tsx src/renderer/GenerationResultPreview.tsx src/renderer/styles.css tests/unit/studio-workspace.test.tsx tests/unit/generation-result-preview.test.tsx
git commit -m "Add responsive studio workspace structure"
```

### 任务 2：语音合并为单一“声音生成”

**文件：** `src/renderer/SpeechForm.tsx`、`tests/unit/speech-form.test.tsx`、`tests/unit/studio.test.tsx`

- [x] **步骤 1：把旧双入口测试改写为统一流程的失败测试**

保留现有 `custom-speech-prompt`、`custom-speech-instruct`、`custom-speech-language`、`custom-speech-output`、`custom-speech-rate` ID，避免无关选择器 churn。`speechField()` 改为从 `.speech-mode-fields` 读取唯一字段。新核心断言：

```tsx
expect(screen.queryByRole('tab', { name: '参考音合成' })).not.toBeInTheDocument();
expect(screen.queryByRole('tab', { name: '声音克隆' })).not.toBeInTheDocument();
expect(screen.getAllByLabelText('口播文字')).toHaveLength(1);
expect(screen.getAllByLabelText('参考音频')).toHaveLength(1);
expect(screen.getByLabelText('情绪/语气')).toBeInTheDocument();
```

增加两个真实请求用例：情绪留空提交 `speechMode: 'clone'` 且不包含 `instruct`；输入“温暖而从容”提交 `speechMode: 'custom'` 且包含该 `instruct`。两个用例必须使用同一参考音和口播文字。录音用例不再点击克隆 tab，直接在当前唯一工作区录制。

- [x] **步骤 2：运行语音测试并确认旧双 tab 实现失败**

运行：`npx vitest run tests/unit/speech-form.test.tsx tests/unit/studio.test.tsx --reporter=dot`

预期：FAIL；旧实现仍出现两个语音 tab，空情绪仍提交 `custom`。

- [x] **步骤 3：最小化修改 SpeechForm**

删除 `speechMode` UI 状态、双 tab、键盘切换、双语言状态和模式参数化渲染。保留单个 `language` 状态；capabilities 固定查询 `custom`，确保情绪能力已加载。保留全部组件安装、错误、轮询、录音和草稿逻辑。

```tsx
const emotion = instruct.trim();
const shared = {
  mode: 'speech' as const,
  prompt: text,
  language,
  outputFormat,
  speechRate,
};
const request: SpeechGenerationRequest = emotion.length > 0
  ? { ...shared, speechMode: 'custom', referenceAudioPath, instruct: emotion }
  : { ...shared, speechMode: 'clone', referenceAudioPath };
```

页面只渲染一组口播文字、参考音、情绪、语言、语速和格式控件。`AudioRecorder.active` 改为 `active && pageActive`，参考音暂停只依赖页面可见性和音频 revision。

- [x] **步骤 4：验证统一语音行为与旧后端兼容**

运行：`npx vitest run tests/unit/speech-form.test.tsx tests/unit/studio.test.tsx tests/unit/speech-generation.test.ts tests/unit/speech-process.test.ts --reporter=dot`

预期：PASS；主进程和 Python 请求文件未改动，旧 `custom` / `clone` 快照测试仍通过。

- [x] **步骤 5：提交语音合并**

```bash
git add src/renderer/SpeechForm.tsx tests/unit/speech-form.test.tsx tests/unit/studio.test.tsx
git commit -m "Unify speech generation controls"
```

### 任务 3：四个生成表单接入共享工作区

**文件：** `src/renderer/ImageForm.tsx`、`src/renderer/TextToVideoForm.tsx`、`src/renderer/AudioDigitalHumanForm.tsx`、`src/renderer/StudioPage.tsx`、`src/renderer/styles.css`、`tests/unit/image-form.test.tsx`、`tests/unit/studio.test.tsx`

- [x] **步骤 1：编写输出归属与人物位置的失败测试**

对语音、图像、文生视频、参考生视频和音频数字人分别断言：主按钮位于 `.studio-editor-pane`，对应 `JobStatus` 和 `GenerationResultPreview` 位于 `getByRole('complementary', { name: '任务与结果' })`。音频数字人增加：

```tsx
const editor = document.querySelector('#audio-mode-panel .studio-editor-pane');
expect(editor).not.toBeNull();
expect(within(editor as HTMLElement).getByRole('region', { name: '当前人物预览' })).toBeVisible();
expect(document.querySelector('#video-main-panel > .studio-layout > .person-preview')).toBeNull();
```

- [x] **步骤 2：运行测试并确认旧结构失败**

运行：`npx vitest run tests/unit/image-form.test.tsx tests/unit/studio.test.tsx --reporter=dot`

预期：FAIL；旧输出仍在编辑列，人物预览仍由 `StudioPage` 外层持有。

- [x] **步骤 3：接入共享布局且不改提交函数**

每个表单保留现有 `<form>`、校验和提交函数。将原来位于 `JobStatus` 之前的编辑控件逐项移入 `StudioWorkspace` 的 `editor` 属性，并保持它们的原有顺序。把每个表单末尾现有的状态与结果组合移入 `output`，例如图像表单使用：

```tsx
output={<>
  <JobStatus jobId={jobId} active={active && pageActive} allowCancel />
  <GenerationResultPreview jobId={jobId} onOpenWorks={onOpenWorks ?? (() => undefined)} />
</>}
```

`TextToVideoForm` 使用 `<JobStatus jobId={jobId} active={active} />`，不添加 `allowCancel`。`SpeechForm` 与 `AudioDigitalHumanForm` 保留 `active={active && pageActive}` 和 `allowCancel`。`AudioDigitalHumanForm` 新增可选 `avatar?: Avatar | null`，保留 `avatarId` 提交参数；当传入模特时，在编辑区顶部渲染 `AvatarImage`、模特名称与 `参考人物：<Picture 1>`。`StudioPage` 传入 `avatar={avatar}`，删除旧 `studio-layout` 人物列。

- [x] **步骤 4：补充参数与人物横排样式**

```css
.studio-parameter-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 12px; }
.studio-editor-pane .person-preview { position: static; display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 12px; align-items: center; margin-bottom: 16px; padding: 0 0 14px; background: transparent; border: 0; border-bottom: 1px solid #e1e6e2; border-radius: 0; }
.studio-editor-pane .person-preview .avatar-image { width: 120px; min-height: 0; max-height: 150px; aspect-ratio: 1; overflow: hidden; }
.studio-editor-pane .person-preview .avatar-image img { width: 100%; height: 100%; max-height: 150px; object-fit: contain; }
.job-summary, .work-progress, .generation-result-actions { min-width: 0; }
.job-summary code, .work-progress-detail, .form-error { overflow-wrap: anywhere; }
```

将语音三项参数、图像比例/分辨率/种子/步数和视频参数行改用 `.studio-parameter-grid`，不修改其他页面的 `.form-row`。

- [x] **步骤 5：运行回归并提交**

运行：`npx vitest run tests/unit/image-form.test.tsx tests/unit/speech-form.test.tsx tests/unit/studio.test.tsx --reporter=dot`

预期：PASS。

```bash
git add src/renderer/ImageForm.tsx src/renderer/TextToVideoForm.tsx src/renderer/AudioDigitalHumanForm.tsx src/renderer/StudioPage.tsx src/renderer/styles.css tests/unit/image-form.test.tsx tests/unit/studio.test.tsx
git commit -m "Apply adaptive workspace to studio forms"
```

### 任务 4：真实 Electron 响应式与媒体验收

**文件：** `tests/e2e/studio.spec.ts`

- [x] **步骤 1：新增最大化和还原的失败回归**

扩展现有图像模拟 ComfyUI 用例，输出至少 `1376 × 768` 的横图。生成后依次设置 `1280 × 820`、`1920 × 1080`、`960 × 640`，再执行应用最大化与还原。每个尺寸保存截图，并记录：

```ts
const layout = await page.evaluate(() => {
  const editor = document.querySelector('#image-main-panel .studio-editor-pane')!;
  const output = document.querySelector('#image-main-panel .studio-output-pane')!;
  const image = document.querySelector('#image-main-panel .generation-result-image')!;
  const editorRect = editor.getBoundingClientRect();
  const outputRect = output.getBoundingClientRect();
  const imageRect = image.getBoundingClientRect();
  return {
    columns: editorRect.top === outputRect.top && outputRect.left > editorRect.left,
    stacked: outputRect.top >= editorRect.bottom - 1,
    imageInside: imageRect.left >= outputRect.left && imageRect.right <= outputRect.right,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
});
```

宽屏断言 `columns && imageInside && !horizontalOverflow`；960 宽断言 `stacked && imageInside && !horizontalOverflow`。最大化与还原后 `#text-image-prompt`、比例、分辨率、种子、步数和任务 ID 必须与切换前一致。

- [x] **步骤 2：运行目标 E2E 并确认旧布局失败**

运行：`npm run test:e2e -- tests/e2e/studio.spec.ts -g "图像生成使用模拟 ComfyUI PNG"`

预期：FAIL；旧页面没有共享区域，或媒体右边界超出结果容器。

- [x] **步骤 3：修正实际截图暴露的布局问题**

只调整任务 1 和任务 3 的共享样式与布局结构。重点检查输出区吸顶是否被滚动容器裁剪、`.generation-result-image` 是否保持原比例、长进度文本是否推宽面板，以及矮窗口是否取消吸顶。不得通过隐藏结果、固定图片高度裁剪或添加横向滚动来通过测试。

- [x] **步骤 4：运行完整界面回归**

运行：`npm run test:e2e -- tests/e2e/studio.spec.ts`

预期：全部 PASS，新增场景保留各尺寸截图。

- [x] **步骤 5：提交响应式验收**

```bash
git add tests/e2e/studio.spec.ts src/renderer
git commit -m "Verify studio layout across window sizes"
```

### 任务 5：完整验证、发布与本机覆盖安装

**文件：** `package.json`、`package-lock.json`、`release/SMO.H3-Studio-Setup-0.6.3.exe`、`release/SMO.H3-Studio-0.6.3.exe`、`release/SHA256SUMS-0.6.3.txt`

- [x] **步骤 1：运行完整静态与单元验证**

运行：`npm run typecheck`

运行：`npx vitest run --exclude tests/unit/environment-wizard.test.tsx --reporter=dot`

预期：类型检查退出码 0；除明确排除的既有用户修改文件外，单元测试无失败。

- [x] **步骤 2：升级补丁版本并构建最终双产物**

运行：`npm version 0.6.3 --no-git-tag-version`

运行：`npm run pack -- --config.electronDist=node_modules/electron/dist`

预期：生成 `release/SMO.H3-Studio-Setup-0.6.3.exe` 和 `release/SMO.H3-Studio-0.6.3.exe`。

- [x] **步骤 3：验证最终产物并生成校验清单**

运行：`npm run test:e2e:package`

预期：6/6 PASS。使用 `Get-FileHash -Algorithm SHA256` 计算两个 exe 的哈希，写入 `SHA256SUMS-0.6.3.txt`。

- [x] **步骤 4：提交、推送并创建 Release**

只暂存本计划涉及的文件，继续排除用户已有的 `tests/e2e/environment.spec.ts`、`tests/unit/environment-wizard.test.tsx` 与缓存目录。

```bash
git add package.json package-lock.json
git commit -m "Release SMO.H3 Studio 0.6.3"
git tag -a v0.6.3 -m "SMO.H3 Studio 0.6.3"
git push origin codex/runtime-in-app-repo
git push origin v0.6.3
gh release create v0.6.3 release/SMO.H3-Studio-Setup-0.6.3.exe release/SMO.H3-Studio-0.6.3.exe release/SHA256SUMS-0.6.3.txt --title "SMO.H3 Studio 0.6.3" --latest
```

Release 说明包含自适应双栏、媒体防溢出、语音入口合并和旧作品兼容。使用 `gh release view v0.6.3 --json assets` 核对远端 digest 与本地 SHA-256 完全一致。

- [x] **步骤 5：覆盖本机并验证运行版本**

只关闭可执行路径为 `G:\SMO-H3-Studio-Installed\SMO.H3 Studio.exe` 的应用进程，不停止 ComfyUI。使用安装包参数 `/S /D=G:\SMO-H3-Studio-Installed` 覆盖安装，然后重新启动该 exe。

验证安装 exe 的 `ProductVersion` 为 `0.6.3.0`、桌面快捷方式仍指向该路径，且 `G:\SMO-H3-Data\environment.json` 的路径与内容未被安装器改写。
