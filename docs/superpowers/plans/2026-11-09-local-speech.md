# 本地 Qwen3-TTS 语音实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在独立本地环境中提供固定音色、情绪/语气控制和参考音频克隆，支持 WAV、MP3、FLAC、M4A 作品，并一键带入音频数字人。

**架构：** 应用管理一个仅绑定 loopback 的 Python 3.12 Qwen3-TTS 进程。主进程负责授权参考音、单任务执行和作品落盘；Python 只返回 WAV 字节，不接受输出路径。格式转换复用基础计划的 `audio-converter.ts`。语音模型和运行时通过可选组件清单按需安装，不改变 H3 基础环境。

**技术栈：** Electron、React、TypeScript、Python 3.12、Qwen3-TTS 0.6B、uv、SoundFile、FFmpeg、Vitest、Playwright。

**规格：** `docs/superpowers/specs/2026-11-09-media-studio-design.md`

**前置：** `docs/superpowers/plans/2026-11-09-media-studio-foundation.md`

---

## 文件职责

- 创建 `src/shared/media-components.ts`：语音/图像组件状态、进度和严格清单类型。
- 创建 `src/main/media-components.ts`：通用组件检测、下载、校验、取消和互斥。
- 创建 `resources/environment/media-components.json`：由脚本生成的精确 URL、大小、SHA256 和相对路径。
- 创建 `scripts/build-media-manifest.mjs`：从 Hugging Face 官方仓库元数据生成清单，不手工猜测哈希。
- 创建 `resources/speech/pyproject.toml`、`resources/speech/uv.lock`、`resources/speech/qwen_tts_service.py`：锁定隔离语音环境及本地服务。
- 创建 `src/main/speech-runtime.ts`：校验并调用 uv，安装 Python 3.12 和锁定依赖。
- 创建 `src/main/speech-process.ts`：进程启动、健康检查、能力查询、WAV 生成和关闭。
- 创建 `src/main/speech-generation.ts`：请求校验、单任务作品、格式转换、输出与错误状态。
- 创建 `src/renderer/SpeechForm.tsx`、`src/renderer/ComponentGate.tsx`：语音界面和可选组件安装状态。
- 修改 `src/shared/types.ts`、`src/shared/ipc.ts`、`src/preload/index.ts`、`src/main/ipc.ts`、`src/main/app-services.ts`：注册语音 API 和生命周期。
- 修改 `src/renderer/App.tsx`、`StudioPage.tsx`、`WorksPage.tsx`：语音主模式及语音到视频的衔接。
- 新增 `tests/unit/media-components.test.ts`、`speech-process.test.ts`、`speech-generation.test.ts`、`speech-form.test.tsx` 和 E2E 模拟服务。

### 任务 1：可复现的语音组件清单与通用下载器

**文件：** `scripts/build-media-manifest.mjs`、`resources/environment/media-components.json`、`src/shared/media-components.ts`、`src/main/media-components.ts`、`tests/unit/media-components.test.ts`

- [ ] **步骤 1：编写失败的清单与下载测试**

使用本地 HTTPS 测试服务和两个小文件，验证组件进度累计、断点续传、取消、哈希错误不落为就绪、路径逃逸拒绝，以及一个组件安装失败不影响另一个：

```ts
await components.install('speech');
expect(components.getState('speech')).toMatchObject({ status: 'ready', active: false });
expect(downloadFile).toHaveBeenCalledWith(expect.objectContaining({
  expectedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
}));
```

清单加载测试拒绝非 HTTPS、重复路径、非安全整数大小和错误 SHA256。

- [ ] **步骤 2：运行测试确认模块不存在**

运行：`npx vitest run tests/unit/media-components.test.ts`

预期：FAIL。

- [ ] **步骤 3：实现清单生成器与组件服务**

定义：

```ts
export type MediaComponentId = 'speech' | 'image';
export interface MediaComponentState {
  id: MediaComponentId;
  status: 'missing' | 'installing' | 'ready' | 'failed';
  downloadedBytes: number;
  totalBytes: number;
  currentFile: string | null;
  error: string | null;
  active: boolean;
}
```

生成器仅读取 `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`、`Qwen/Qwen3-TTS-12Hz-0.6B-Base`、`Qwen/Qwen3-TTS-Tokenizer-12Hz`。通过 Hugging Face `tree/main?recursive=true` 获取 LFS SHA256；小文件下载后计算 SHA256。保留运行所需 `.safetensors/.json/.txt/.model/.vocab/.merges/.jinja` 和许可证，不下载 README 图片或重复 GGUF。

`MediaComponentService` 将文件安装到 `<data>/components/<id>/models/<relativePath>`，调用现有 `downloadFile`，按清单总字节报告进度；每个组件只有一个安装 flight，所有完成文件重新校验后才标记 ready。

- [ ] **步骤 4：运行生成器和测试**

运行：`node scripts/build-media-manifest.mjs --component speech && npx vitest run tests/unit/media-components.test.ts`

预期：PASS；提交中的清单包含实际文件大小与哈希，不含令牌。

- [ ] **步骤 5：提交**

```bash
git add scripts/build-media-manifest.mjs resources/environment/media-components.json src/shared/media-components.ts src/main/media-components.ts tests/unit/media-components.test.ts
git commit -m "Add verified optional media component downloads"
```

### 任务 2：隔离 Python 语音服务

**文件：** `resources/speech/pyproject.toml`、`resources/speech/uv.lock`、`resources/speech/qwen_tts_service.py`、`src/main/speech-process.ts`、`tests/unit/speech-process.test.ts`

- [ ] **步骤 1：编写失败的进程契约测试**

以假 Python 进程和 fetch 验证：启动读取 stdout 的实际端口，只接受 loopback URL；健康检查超时关闭进程；固定音色与克隆请求字段正确；非 200 响应不包含用户文本；关闭两次安全；模型切换错误会返回失败。

```ts
await expect(speech.generate({
  voiceMode: 'clone', text: '测试', language: 'Auto',
  referenceAudioPath: 'G:\\authorized.wav', referenceText: '参考原文',
})).resolves.toEqual(expect.any(Uint8Array));
```

- [ ] **步骤 2：运行测试确认服务不存在**

运行：`npx vitest run tests/unit/speech-process.test.ts`

预期：FAIL。

- [ ] **步骤 3：实现 Python 服务与 TypeScript 进程管理**

Python 使用 `ThreadingHTTPServer` 绑定 `127.0.0.1:0`，提供：

```text
GET  /health        -> { "ok": true }
GET  /capabilities  -> { "speakers": [...], "languages": [...] }
POST /generate      -> audio/wav bytes
POST /shutdown      -> 204
```

服务启动时不加载两个模型；首次生成或能力查询按 `voiceMode` 加载对应模型。切换时删除旧实例、执行 `gc.collect()` 和 `torch.cuda.empty_cache()`。固定音色调用 `generate_custom_voice(text, language, speaker, instruct)`；克隆调用 `generate_voice_clone(text, language, ref_audio, ref_text, x_vector_only_mode)`。使用 `io.BytesIO` 和 `soundfile.write(..., format='WAV')` 返回字节，不写用户指定输出文件。

`pyproject.toml` 固定 `qwen-tts`、`soundfile` 和 CUDA 12.8 PyTorch 索引，运行 `uv lock` 生成锁文件。`speech-runtime.ts` 使用经 SHA256 校验的 Windows x64 uv，执行 `uv python install 3.12`、`uv venv --python 3.12` 和 `uv sync --locked`，所有网络输出不得写入用户口播文本。

- [ ] **步骤 4：运行测试和 Python 语法检查**

运行：`npx vitest run tests/unit/speech-process.test.ts && python -m py_compile resources/speech/qwen_tts_service.py`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add resources/speech src/main/speech-process.ts tests/unit/speech-process.test.ts
git commit -m "Add isolated Qwen3-TTS local service"
```

### 任务 3：语音 IPC、单任务生成与四种格式

**文件：** `src/shared/types.ts`、`src/shared/ipc.ts`、`src/main/speech-generation.ts`、`src/main/ipc.ts`、`src/main/app-services.ts`、`src/preload/index.ts`、`tests/unit/ipc.test.ts`、`tests/unit/speech-generation.test.ts`

- [ ] **步骤 1：编写失败测试**

验证 `SpeechGenerationRequest`：

```ts
export interface SpeechGenerationRequest {
  mode: 'speech';
  speechMode: 'custom' | 'clone';
  prompt: string;
  language: string;
  outputFormat: 'wav' | 'mp3' | 'flac' | 'm4a';
  speaker?: string;
  instruct?: string;
  referenceAudioPath?: string;
  referenceText?: string;
  retryOf?: string;
}
```

固定音色必须有 speaker；克隆必须有授权 referenceAudioPath；referenceText 留空时 `x_vector_only_mode = true`。四种格式分别产生正确扩展名，WAV 不重复转码；失败保留请求快照，重试重新授权参考音；活动任务时第二个语音或视频任务均被拒绝且不新增作品。

本任务将共享联合类型扩展为 `type GenerationRequest = VideoGenerationRequest | SpeechGenerationRequest`，`GenerationHandler` 与该联合保持一致。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/speech-generation.test.ts tests/unit/ipc.test.ts -t "speech|语音"`

预期：FAIL。

- [ ] **步骤 3：实现请求 schema 和生成器**

生成器执行：校验组件 ready、授权参考音、创建作品、通过共享 `JobCoordinator` 启动、调用 `SpeechProcess.generate` 获得 WAV、写入唯一临时 WAV、按 `outputFormat` 转换到 `output/SMO-Speech/<workId>.<ext>`、读取时长、更新完成时间。任何失败清理临时 WAV，取消时关闭当前语音进程以终止推理并释放任务锁。

注册 `speech:getCapabilities`、`components:getState`、`components:install`、`components:cancel`。`components:install` 只接受组件 ID，使用独立安装锁但不允许在生成活动任务期间安装新运行时。`app-services.close()` 先关闭任务，再关闭语音进程和组件安装。

- [ ] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/speech-generation.test.ts tests/unit/ipc.test.ts tests/unit/jobs.test.ts && npm run typecheck`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add src/shared/types.ts src/shared/ipc.ts src/main/speech-generation.ts src/main/ipc.ts src/main/app-services.ts src/preload/index.ts tests/unit/ipc.test.ts tests/unit/speech-generation.test.ts
git commit -m "Generate local speech works in four formats"
```

### 任务 4：语音面板、组件安装与草稿保留

**文件：** `src/renderer/SpeechForm.tsx`、`src/renderer/ComponentGate.tsx`、`src/renderer/StudioPage.tsx`、`src/renderer/styles.css`、`tests/unit/speech-form.test.tsx`、`tests/unit/studio.test.tsx`

- [ ] **步骤 1：编写失败渲染测试**

覆盖固定音色/克隆 tab、口播与情绪输入、音色加载、参考音拖入、四种格式、组件未安装时只禁用语音、生成请求、全局 busy、切换主模式和页面后草稿不丢失。

```tsx
fireEvent.change(screen.getByLabelText('输出格式'), { target: { value: 'mp3' } });
fireEvent.click(screen.getByRole('button', { name: '生成语音' }));
expect(smo.jobs.start).toHaveBeenCalledWith(expect.objectContaining({
  mode: 'speech', speechMode: 'custom', outputFormat: 'mp3',
}));
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/speech-form.test.tsx tests/unit/studio.test.tsx -t "语音|speech"`

预期：FAIL。

- [ ] **步骤 3：实现语音主模式**

`StudioPage` 使用 `mode: 'speech' | 'image' | 'video'`，首版图像 tab 在图像计划中接入。语音面板不读取或要求 avatar；视频布局保持 A 方案。`ComponentGate` 显示缺失大小、下载进度、取消和重试，不使用营销卡片。

固定音色显示口播文字、音色、语言、情绪/语气、输出格式；克隆显示口播文字、共用 `AudioInput`、可选参考原文、语言、输出格式。使用 `Mic`、`AudioLines`、`Download`、`Play` 等 lucide 图标，所有异步操作有明确 busy 与错误状态。

- [ ] **步骤 4：运行测试**

运行：`npx vitest run tests/unit/speech-form.test.tsx tests/unit/studio.test.tsx && npm run typecheck`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add src/renderer/SpeechForm.tsx src/renderer/ComponentGate.tsx src/renderer/StudioPage.tsx src/renderer/styles.css tests/unit/speech-form.test.tsx tests/unit/studio.test.tsx
git commit -m "Add local speech workspace"
```

### 任务 5：语音作品一键进入音频数字人

**文件：** `src/renderer/App.tsx`、`src/renderer/StudioPage.tsx`、`src/renderer/AudioDigitalHumanForm.tsx`、`src/renderer/WorksPage.tsx`、`tests/unit/studio.test.tsx`、`tests/e2e/studio.spec.ts`

- [ ] **步骤 1：编写失败测试**

完成一个模拟语音作品后点击“用于音频数字人”，断言页面进入制作台、主模式为视频、子模式为音频数字人，当前文件是所选 WAV/MP3/FLAC/M4A，时长已读取。返回作品页选择另一个语音时不得被前一个异步时长读取覆盖。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/studio.test.tsx -t "用于音频数字人"`

预期：FAIL。

- [ ] **步骤 3：实现显式 studioIntent**

`App` 保存：

```ts
type StudioIntent = {
  token: number;
  mode: 'video';
  videoMode: 'audio';
  audioPath: string;
};
```

WorksPage 仅对 `mode === 'speech' && status === 'done' && outputPath` 显示操作。`AudioDigitalHumanForm` 监听 intent token，以递增选择 ID 应用音频、重置截取范围并读取时长；输出位于 MediaRegistry 管理根，无需把路径伪装成用户拖入。

- [ ] **步骤 4：运行单元与 E2E 测试**

运行：`npx vitest run tests/unit/studio.test.tsx && npm run build && npx playwright test tests/e2e/studio.spec.ts`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add src/renderer/App.tsx src/renderer/StudioPage.tsx src/renderer/AudioDigitalHumanForm.tsx src/renderer/WorksPage.tsx tests/unit/studio.test.tsx tests/e2e/studio.spec.ts
git commit -m "Use speech works in audio digital human"
```

### 任务 6：语音真实验收与回归

- [ ] **步骤 1：自动回归**

运行：`npm run typecheck && npm test && npm run test:e2e`

预期：所有已完成范围测试 PASS，记录实际数量。

- [ ] **步骤 2：真实 Qwen3-TTS 验收**

在独立环境安装锁定依赖和 0.6B 模型，使用固定测试文本完成固定音色和授权样例克隆。四种格式均用 ffprobe 验证编码、采样率、非零时长；试听后确认没有空音频。切换固定音色与克隆时只保留一个模型实例，任务完成后可立即启动视频。

- [ ] **步骤 3：打包资源检查**

运行打包态测试，确认 `resources/speech` 和组件清单进入包内，模型、Python 环境、API Key、测试参考音不进入安装包。将实际结果记录到本计划，只提交计划文档。

