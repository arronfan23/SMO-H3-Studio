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

- [x] **步骤 1：编写失败测试**

验证默认 `UV_PYTHON_INSTALL_DIR` 位于 `%LOCALAPPDATA%\SMO-H3-Runtime\python`，而不是 G 盘组件目录；支持显式覆盖，uv 缓存和 venv 仍在组件目录。补克隆录音成功、权限失败保留旧参考音、重录替换、隐藏不丢状态测试。

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/speech-runtime.test.ts tests/unit/speech-form.test.tsx -t "NTFS|录音|clone"`

预期：默认路径错误且克隆无录音入口。

- [x] **步骤 3：实现路径解析和录音复用**

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

- [x] **步骤 4：运行测试与 exFAT 实体验证**

运行：`npx vitest run tests/unit/speech-runtime.test.ts tests/unit/speech-form.test.tsx && npm run typecheck`

在当前 G 盘 exFAT 环境重新执行能力加载，确认不再出现 minor version link directory 错误；不删除旧模型或 ComfyUI Python。

- [x] **步骤 5：提交**

```bash
git add src/main/speech-runtime.ts src/renderer/SpeechForm.tsx tests/unit/speech-runtime.test.ts tests/unit/speech-form.test.tsx
git commit -m "Fix TTS setup on exFAT and add clone recording"
```

### 任务 2：共享参考图选择器

**文件：** 创建 `src/renderer/ReferenceImagePicker.tsx`、`tests/unit/reference-image-picker.test.tsx`；修改 `src/renderer/styles.css`

- [x] **步骤 1：编写失败测试**

覆盖 `paths/max/disabled/onChange`：逐张添加、一次多图拖入、超过上限拒绝、预览、删除、顺序保持、重复路径处理和慢授权不覆盖新操作。上限分别用 4 和 9 验证。

- [x] **步骤 2：运行测试确认组件不存在**

运行：`npx vitest run tests/unit/reference-image-picker.test.tsx`

- [x] **步骤 3：实现受控选择器**

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

- [x] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/reference-image-picker.test.tsx && npm run typecheck`

- [x] **步骤 5：提交**

```bash
git add src/renderer/ReferenceImagePicker.tsx src/renderer/styles.css tests/unit/reference-image-picker.test.tsx
git commit -m "Add shared reference image picker"
```

### 任务 3：左侧二级制作目录

**文件：** `src/renderer/App.tsx`、`src/renderer/StudioPage.tsx`、`src/renderer/styles.css`、`tests/unit/studio.test.tsx`、`tests/e2e/studio.spec.ts`

- [x] **步骤 1：编写失败测试**

验证父目录 `aria-expanded`、二级语音/图像/视频按钮、点击切页和模式、收起不卸载草稿、键盘焦点和 ARIA。StudioPage 不再显示重复主 tab，但视频细分仍存在。

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/studio.test.tsx -t "二级|导航|目录"`

- [x] **步骤 3：实现受控模式导航**

App 保存 `studioMode: 'speech'|'image'|'video'` 和 `studioExpanded`，点击父目录切换展开状态，子项同时设置 `page='studio'` 和 `studioMode`。使用 ChevronDown/ChevronRight、Mic/Image/Video 图标。StudioPage 接收受控 `mode` 和 `onModeChange`，保留内部视频子模式及 intent。

- [x] **步骤 4：运行单元和 Electron 测试**

运行：`npx vitest run tests/unit/studio.test.tsx && npm run typecheck && npm run build && npx playwright test tests/e2e/studio.spec.ts`

- [x] **步骤 5：提交**

```bash
git add src/renderer/App.tsx src/renderer/StudioPage.tsx src/renderer/styles.css tests/unit/studio.test.tsx tests/e2e/studio.spec.ts
git commit -m "Move studio modes into the sidebar"
```

### 任务 4：图像导入模特与作品筛选层级

**文件：** `src/main/media.ts`、`src/main/avatars.ts`、`src/renderer/App.tsx`、`src/renderer/WorksPage.tsx`、`src/renderer/styles.css`、`tests/unit/media-registry-options.test.ts`、`tests/unit/avatars.test.ts`、`tests/unit/studio.test.tsx`、`tests/e2e/studio.spec.ts`

- [x] **步骤 1：编写失败测试**

验证受管输出图片可创建模特，根外图片仍需显式选择。点击“导入数字模特”只出现在完成的图像作品，复制独立资产并选中，原图保留，重复导入生成不同 UUID。

筛选断言：主层级“全部/语音/图像/视频”；视频子层级“全部视频/文字生视频/音频数字人”；状态“全部状态/运行中/已完成/失败”；组合筛选和 `aria-pressed` 正确。

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/media-registry-options.test.ts tests/unit/avatars.test.ts tests/unit/studio.test.tsx -t "导入|筛选|managed"`

- [x] **步骤 3：实现管理图片授权、导入和分层筛选**

`MediaRegistry.isSelectedImage` 与 `isSelectedFile` 一致，允许经过 realpath 验证的 managed roots。`AvatarService` 不改根外授权规则。WorksPage 调用 App 的 `onImportImage`，App 使用作品标题或短 ID 调用 `avatars.create`，切换数字模特页并选中。

将 `WorkFilter` 拆为 `workType`、`videoType`、`status`，组合时先按 mode，再按 status，视频子类型只在视频组显示。

- [x] **步骤 4：运行相关测试和 E2E**

运行：`npx vitest run tests/unit/media-registry-options.test.ts tests/unit/avatars.test.ts tests/unit/studio.test.tsx && npm run typecheck && npm run build && npx playwright test tests/e2e/studio.spec.ts`

- [x] **步骤 5：提交**

```bash
git add src/main/media.ts src/main/avatars.ts src/renderer/App.tsx src/renderer/WorksPage.tsx src/renderer/styles.css tests/unit/media-registry-options.test.ts tests/unit/avatars.test.ts tests/unit/studio.test.tsx tests/e2e/studio.spec.ts
git commit -m "Import generated images as avatars and organize work filters"
```

### 任务 5：基础链路验证

- [x] **步骤 1：运行 `npm run typecheck`、排除已知旧环境导入测试的 Vitest、完整 studio E2E，并提交实际结果到本计划。**
- [x] **步骤 2：在真实 G 盘环境确认 TTS capabilities 可加载、克隆录音可保存并授权。**
- [x] **步骤 3：用合成 WAV/模拟 MediaRecorder 验证克隆参考音保存、授权、重录替换和忙时不能提交。**

#### 2026-11-11 实际验证（Base `6b98c921d6e5d277d66fc683d28974620ac6b247`）

**结论：BLOCKED。** 类型检查、排除后的 Vitest、完整 studio E2E 和合成克隆录音均通过；真实默认 `SpeechRuntime.prepare()` 在已有 venv 上失败，不能把绕过 prepare 的模型 capabilities 诊断视为完整链路通过。未修改生产代码。

**1. 自动回归**

- `npm run typecheck`：PASS。
- `npx vitest run --exclude tests/unit/environment-wizard.test.tsx`：**61 个文件，2600 通过、1 跳过（共 2601）、0 失败**。按任务要求排除该文件，因为当前 Base 的旧环境导入测试有 5 个已知失败；这些失败不计为本任务缺陷。
- `npm run test:e2e -- tests/e2e/studio.spec.ts`：构建 PASS，完整 studio E2E **22/22 通过**。
- 仓库外合成录音集成测试：**1/1 通过**；绕过 prepare 的真实模型 capabilities 诊断另为 **1/1 通过**，但不能抵消下述默认 prepare 失败。

**2. 真实 G 盘 TTS 与阻塞**

- 实测 G 盘为 exFAT，Python 安装根目录为 NTFS 上的 `C:\Users\FG\AppData\Local\SMO-H3-Runtime\python`。既有组件为 ready，`5,720,134,760 / 5,720,134,760` 字节；只核验现有 27 个模型文件，前后文件大小和修改时间快照一致。运行时使用 `UV_OFFLINE=1`，没有重新下载模型或重复安装依赖。
- 默认应用链路实际执行到 `uv python install 3.12` 时返回 `Using CPython 3.12.13`，未再出现 Python minor version link directory 错误；随后 `uv venv --python 3.12 G:\SMO-H3-Speech-Verification-20261110\data\components\speech\runtime\venv` 失败：`A virtual environment already exists ... Use --clear to replace it`。根因是 `src/main/speech-runtime.ts` 无条件对已有 venv 执行创建命令，现有单测将该命令 mock 为成功，未覆盖应用重启后的真实目录状态。因此步骤 2 保持未勾选。
- 为隔离验证模型本身，仓库外 harness 随后仅注入已 prepared 的 `SpeechRuntime.prepare()` 结果，真实执行 `createAppServices`、`SpeechProcessManager` 和本地 Qwen 模型加载。custom 返回音色：`aiden`、`dylan`、`eric`、`ono_anna`、`ryan`、`serena`、`sohee`、`uncle_fu`、`vivian`；custom 与 clone 均返回语言：`auto`、`chinese`、`english`、`french`、`german`、`italian`、`japanese`、`korean`、`portuguese`、`russian`、`spanish`。clone 的固定音色列表为 `[]`。该诊断没有调用音频生成接口，结束后无本次验收 Python 进程残留。

**3. 合成 WAV 与模拟 MediaRecorder**

- 有效合成 WAV 经模拟 `MediaRecorder`、真实 `RecordingService`、FFmpeg 和 `MediaRegistry` 完成两次保存及授权；输出是两个不同的 UUID WAV，均为 `pcm_s16le`、24000 Hz、单声道、0.25 秒、12078 字节。
- 重录后当前参考音、预览 URL 和后续模拟 `jobs.start` 的路径均替换为第二份录音；两次提交分别使用对应的新路径。模拟麦克风权限拒绝后保留第二份参考音，没有新增保存。
- 首次录音中、首次保存中和重录中共 3 次提交尝试均未调用 `jobs.start`；仅在忙时结束且参考音有效后进行了 2 次模拟提交。未操作真实麦克风，未执行真实 TTS 生成。

**4. 未执行项与剩余风险**

- 按任务边界未执行真实 TTS 音频生成、真实麦克风采集、模型重新下载或依赖重装。
- 因禁止修改生产代码，未修复或复验已有 venv 的默认 prepare 阻塞。应用重启后再次加载 capabilities 仍可能失败，这是当前基础链路的发布阻塞风险；绕过 prepare 的真实模型结果不能作为正常启动链路验收结论。

#### 2026-11-11 阻塞解除复验（修复提交 `46420230d316c6f958000f50a14483052494bd70`）

**结论：PASS。** 上述 BLOCKED 记录保留为修复前历史。已有 venv 现在只有在 `pyvenv.cfg` 存在且真实解释器为 Python 3.12.x 时才复用；无效环境会隔离备份后重建。默认应用 prepare/capabilities 链路已恢复，不再需要绕过 prepare。

- 默认 `SpeechRuntime.prepare()` 对已有有效环境仅执行版本检查和一次 locked sync，没有重新创建 venv 或重新下载依赖。
- 使用复用环境的真实解释器执行 `python -I -c "import qwen_tts"`：**1/1 通过**。
- 默认 capabilities：custom 返回 **9 个音色、11 种语言**，clone 返回 **11 种语言**；未再出现 Python minor version link directory 或已有 venv 阻塞错误。
- 克隆录音保存、授权、重录替换和忙时提交拦截沿用上述合成集成验收结果：通过。
- `npm run typecheck`：PASS。
- 排除既有未完成的 `tests/unit/environment-wizard.test.tsx` 后，Vitest：**2600 通过、1 跳过、0 失败**。
- 完整 studio E2E：**22/22 通过**。
- 真实 TTS 音频生成、真实麦克风采集和模型重新下载仍不在本任务验收范围内。
