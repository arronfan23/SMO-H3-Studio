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

- [x] **步骤 1：编写失败的清单与下载测试**

使用本地 HTTPS 测试服务和两个小文件，验证组件进度累计、断点续传、取消、哈希错误不落为就绪、路径逃逸拒绝，以及一个组件安装失败不影响另一个：

```ts
await components.install('speech');
expect(components.getState('speech')).toMatchObject({ status: 'ready', active: false });
expect(downloadFile).toHaveBeenCalledWith(expect.objectContaining({
  expectedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
}));
```

清单加载测试拒绝非 HTTPS、重复路径、非安全整数大小和错误 SHA256。

- [x] **步骤 2：运行测试确认模块不存在**

运行：`npx vitest run tests/unit/media-components.test.ts`

预期：FAIL。

- [x] **步骤 3：实现清单生成器与组件服务**

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

- [x] **步骤 4：运行生成器和测试**

运行：`node scripts/build-media-manifest.mjs --component speech && npx vitest run tests/unit/media-components.test.ts`

预期：PASS；提交中的清单包含实际文件大小与哈希，不含令牌。

- [x] **步骤 5：提交**

```bash
git add scripts/build-media-manifest.mjs resources/environment/media-components.json src/shared/media-components.ts src/main/media-components.ts tests/unit/media-components.test.ts
git commit -m "Add verified optional media component downloads"
```

### 任务 2：隔离 Python 语音服务

**文件：** `resources/speech/pyproject.toml`、`resources/speech/uv.lock`、`resources/speech/qwen_tts_service.py`、`src/main/speech-process.ts`、`tests/unit/speech-process.test.ts`

- [x] **步骤 1：编写失败的进程契约测试**

以假 Python 进程和 fetch 验证：启动读取 stdout 的实际端口，只接受 loopback URL；健康检查超时关闭进程；固定音色与克隆请求字段正确；非 200 响应不包含用户文本；关闭两次安全；模型切换错误会返回失败。

```ts
await expect(speech.generate({
  voiceMode: 'clone', text: '测试', language: 'Auto',
  referenceAudioPath: 'G:\\authorized.wav', referenceText: '参考原文',
})).resolves.toEqual(expect.any(Uint8Array));
```

- [x] **步骤 2：运行测试确认服务不存在**

运行：`npx vitest run tests/unit/speech-process.test.ts`

预期：FAIL。

- [x] **步骤 3：实现 Python 服务与 TypeScript 进程管理**

Python 使用 `ThreadingHTTPServer` 绑定 `127.0.0.1:0`，提供：

```text
GET  /health        -> { "ok": true }
GET  /capabilities  -> { "speakers": [...], "languages": [...] }
POST /generate      -> audio/wav bytes
POST /shutdown      -> 204
```

服务启动时不加载两个模型；首次生成或能力查询按 `voiceMode` 加载对应模型。切换时删除旧实例、执行 `gc.collect()` 和 `torch.cuda.empty_cache()`。固定音色调用 `generate_custom_voice(text, language, speaker, instruct)`；克隆调用 `generate_voice_clone(text, language, ref_audio, ref_text, x_vector_only_mode)`。使用 `io.BytesIO` 和 `soundfile.write(..., format='WAV')` 返回字节，不写用户指定输出文件。

`pyproject.toml` 固定 `qwen-tts`、`soundfile` 和 CUDA 12.8 PyTorch 索引，运行 `uv lock` 生成锁文件。`speech-runtime.ts` 使用经 SHA256 校验的 Windows x64 uv，执行 `uv python install 3.12`、`uv venv --python 3.12` 和 `uv sync --locked`，所有网络输出不得写入用户口播文本。

- [x] **步骤 4：运行测试和 Python 语法检查**

运行：`npx vitest run tests/unit/speech-process.test.ts && python -m py_compile resources/speech/qwen_tts_service.py`

预期：PASS。

- [x] **步骤 5：提交**

```bash
git add resources/speech src/main/speech-process.ts tests/unit/speech-process.test.ts
git commit -m "Add isolated Qwen3-TTS local service"
```

### 任务 3：语音 IPC、单任务生成与四种格式

**文件：** `src/shared/types.ts`、`src/shared/ipc.ts`、`src/main/speech-generation.ts`、`src/main/ipc.ts`、`src/main/app-services.ts`、`src/preload/index.ts`、`tests/unit/ipc.test.ts`、`tests/unit/speech-generation.test.ts`

- [x] **步骤 1：编写失败测试**

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

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/speech-generation.test.ts tests/unit/ipc.test.ts -t "speech|语音"`

预期：FAIL。

- [x] **步骤 3：实现请求 schema 和生成器**

生成器执行：校验组件 ready、授权参考音、创建作品、通过共享 `JobCoordinator` 启动、调用 `SpeechProcess.generate` 获得 WAV、写入唯一临时 WAV、按 `outputFormat` 转换到 `output/SMO-Speech/<workId>.<ext>`、读取时长、更新完成时间。任何失败清理临时 WAV，取消时关闭当前语音进程以终止推理并释放任务锁。

注册 `speech:getCapabilities`、`components:getState`、`components:install`、`components:cancel`。`components:install` 只接受组件 ID，使用独立安装锁但不允许在生成活动任务期间安装新运行时。`app-services.close()` 先关闭任务，再关闭语音进程和组件安装。

- [x] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/speech-generation.test.ts tests/unit/ipc.test.ts tests/unit/jobs.test.ts && npm run typecheck`

预期：PASS。

- [x] **步骤 5：提交**

```bash
git add src/shared/types.ts src/shared/ipc.ts src/main/speech-generation.ts src/main/ipc.ts src/main/app-services.ts src/preload/index.ts tests/unit/ipc.test.ts tests/unit/speech-generation.test.ts
git commit -m "Generate local speech works in four formats"
```

### 任务 4：语音面板、组件安装与草稿保留

**文件：** `src/renderer/SpeechForm.tsx`、`src/renderer/ComponentGate.tsx`、`src/renderer/StudioPage.tsx`、`src/renderer/styles.css`、`tests/unit/speech-form.test.tsx`、`tests/unit/studio.test.tsx`

- [x] **步骤 1：编写失败渲染测试**

覆盖固定音色/克隆 tab、口播与情绪输入、音色加载、参考音拖入、四种格式、组件未安装时只禁用语音、生成请求、全局 busy、切换主模式和页面后草稿不丢失。

```tsx
fireEvent.change(screen.getByLabelText('输出格式'), { target: { value: 'mp3' } });
fireEvent.click(screen.getByRole('button', { name: '生成语音' }));
expect(smo.jobs.start).toHaveBeenCalledWith(expect.objectContaining({
  mode: 'speech', speechMode: 'custom', outputFormat: 'mp3',
}));
```

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/speech-form.test.tsx tests/unit/studio.test.tsx -t "语音|speech"`

预期：FAIL。

- [x] **步骤 3：实现语音主模式**

`StudioPage` 使用 `mode: 'speech' | 'image' | 'video'`，首版图像 tab 在图像计划中接入。语音面板不读取或要求 avatar；视频布局保持 A 方案。`ComponentGate` 显示缺失大小、下载进度、取消和重试，不使用营销卡片。

固定音色显示口播文字、音色、语言、情绪/语气、输出格式；克隆显示口播文字、共用 `AudioInput`、可选参考原文、语言、输出格式。使用 `Mic`、`AudioLines`、`Download`、`Play` 等 lucide 图标，所有异步操作有明确 busy 与错误状态。

- [x] **步骤 4：运行测试**

运行：`npx vitest run tests/unit/speech-form.test.tsx tests/unit/studio.test.tsx && npm run typecheck`

预期：PASS。

- [x] **步骤 5：提交**

```bash
git add src/renderer/SpeechForm.tsx src/renderer/ComponentGate.tsx src/renderer/StudioPage.tsx src/renderer/styles.css tests/unit/speech-form.test.tsx tests/unit/studio.test.tsx
git commit -m "Add local speech workspace"
```

### 任务 5：语音作品一键进入音频数字人

**文件：** `src/renderer/App.tsx`、`src/renderer/StudioPage.tsx`、`src/renderer/AudioDigitalHumanForm.tsx`、`src/renderer/WorksPage.tsx`、`tests/unit/studio.test.tsx`、`tests/e2e/studio.spec.ts`

- [x] **步骤 1：编写失败测试**

完成一个模拟语音作品后点击“用于音频数字人”，断言页面进入制作台、主模式为视频、子模式为音频数字人，当前文件是所选 WAV/MP3/FLAC/M4A，时长已读取。返回作品页选择另一个语音时不得被前一个异步时长读取覆盖。

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/studio.test.tsx -t "用于音频数字人"`

预期：FAIL。

- [x] **步骤 3：实现显式 studioIntent**

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

- [x] **步骤 4：运行单元与 E2E 测试**

运行：`npx vitest run tests/unit/studio.test.tsx && npm run build && npx playwright test tests/e2e/studio.spec.ts`

预期：PASS。

- [x] **步骤 5：提交**

```bash
git add src/renderer/App.tsx src/renderer/StudioPage.tsx src/renderer/AudioDigitalHumanForm.tsx src/renderer/WorksPage.tsx tests/unit/studio.test.tsx tests/e2e/studio.spec.ts
git commit -m "Use speech works in audio digital human"
```

### 任务 6：语音真实验收与回归

- [x] **步骤 1：自动回归**

运行：`npm run typecheck && npm test && npm run test:e2e`

预期：所有已完成范围测试 PASS，记录实际数量。

- [x] **步骤 2：真实 Qwen3-TTS 验收**

在独立环境安装锁定依赖和 0.6B 模型，使用固定测试文本完成固定音色和授权样例克隆。四种格式均用 ffprobe 验证编码、采样率、非零时长；试听后确认没有空音频。切换固定音色与克隆时只保留一个模型实例，任务完成后可立即启动视频。

- [x] **步骤 3：打包资源检查**

运行打包态测试，确认 `resources/speech` 和组件清单进入包内，模型、Python 环境、API Key、测试参考音不进入安装包。将实际结果记录到本计划，只提交计划文档。

#### 2026-11-10 实际验收记录

**结论：BLOCKED。** Base HEAD 为 `0e2ed8c3ca4d1b3ce74d4234ad39672ed1e307b8`。真实组件下载发生连接超时，真实生成未开始；打包检查另发现 `resources/speech` 未进入 `win-unpacked`。未修改生产代码，未读取用户素材或密钥，未终止既有 ComfyUI/Python 或应用进程。

工作树开始时已有计划文件、两个环境导入测试文件的未提交修改及 Python 缓存。自动回归包含这些已有测试修改；本任务没有修改它们，最终提交仍只包含本计划文件。

**1. 自动回归**

- `npm run typecheck`：PASS。
- `npm test`：57 个测试文件中 56 通过、1 失败；2357 个测试中 **2351 通过、1 跳过、5 失败**。5 个失败全部位于 `tests/unit/environment-wizard.test.tsx`，全部是任务允许豁免的 `imports an existing environment...` 用例，没有发现其他失败。
- 因上述 5 个已知失败使命令中的 `&&` 链停止，随后单独执行 `npm run build && npx playwright test --grep-invert "imports an existing environment"`。构建 PASS；Playwright **24 通过、1 跳过、0 失败**。
- 因而原始串联命令的实际退出码为 1，不能记录为“全部测试通过”；除 5 个明确豁免项外，其余自动回归通过。

**2. 真实 Qwen3-TTS：下载阻塞，未生成音频**

- 独立验收目录为 `G:\SMO-H3-Speech-Verification-20261110`，计划安装位置为该目录下的 `data/components/speech` 和 `runtime`，没有使用或修改 ComfyUI Python。
- 清单包含 27 个文件，总计 `5,720,134,760` 字节（`5.327290632 GiB`）。第一次运行 `MediaComponentService.install('speech')` 时，在首个文件 `Qwen3-TTS-12Hz-0.6B-Base/config.json` 下载阶段失败，耗时约 `10.85` 秒；没有任何清单文件安装完成。
- 完整根因：`TypeError: fetch failed`，原因 `ConnectTimeoutError / UND_ERR_CONNECT_TIMEOUT`，`timeout: 10000ms`，尝试地址 `2a03:2880:f107:83:face:b00c:0:25de:443`、`199.59.149.208:443`。证据保存在 `G:\SMO-H3-Speech-Verification-20261110\reports\download-root-cause.txt` 和同目录 `progress.json`。
- 按要求没有重试下载、改变代理或来源、更换模型。由于没有模型文件，锁定 Python 环境准备、模型加载、固定音色生成、克隆生成及模型实例切换均未继续执行。
- **真实输出：无。** 没有生成固定音色 WAV、克隆 WAV 或 MP3/FLAC/M4A，因而没有真实输出 SHA256、推理耗时、ffprobe 编码/采样率/时长结果或音量检测结果。单实例切换、任务锁释放和完成后立即启动另一任务也未做真实验证。
- GPU 初始快照：RTX 5080，总计 `16303 MiB`，已用 `11105 MiB`，驱动 `621.01`；结束时已用 `11199 MiB`、利用率 `2%`、温度 `46.5 C`。这些数值来自既有进程，不代表 Qwen 推理负载；没有启动 Qwen 进程。

**3. 打包资源检查：已执行，验收未通过**

- `npm run build` 再次 PASS。默认 `npx electron-builder --win --dir` 在 Electron 分发包准备阶段等待超过 5 分钟且无完成输出，只中断了本次构建进程；DEBUG 复现也停在该阶段。
- 既有 Electron 45.0.0 缓存 ZIP 的 SHA256 为 `ae53887a23bb640369c93dbd38c408a2af5c0deb86f2fa76c6c244cb444b7f47`，与缓存 `SHASUMS256.txt-45.0.0` 完全一致。随后使用该同一版本缓存分发包执行离线 `--config.electronDist=G:\SMO-H3-Speech-Verification-20261110\electron-45.0.0` 目录构建，`win-unpacked` 构建成功；未签名、未生成安装器、未发布。
- 包目录：`release/win-unpacked`，共 126 个磁盘文件、`417,722,885` 字节，`app.asar` 内另有 5461 个条目。
- `resources/resources/environment/media-components.json` **存在**，大小 `11,487` 字节，源文件与包内文件 SHA256 均为 `d7c472aa13cec943e88bac260f6fe4f7567add9c3ef64b88465e5ebe55e9419a`。
- `resources/resources/speech` **不存在**，所以 `pyproject.toml`、`uv.lock`、`qwen_tts_service.py` 均未进入包。`electron-builder.yml` 的 `extraResources` 实际仅列出 brand、environment、workflows、skills。这是明确的打包配置缺陷，按任务要求报告 BLOCKED，未自行修复。
- 对包目录和 `app.asar` 条目扫描，`.safetensors/.gguf/.wav/.mp3/.flac/.m4a/.py/.pyc`、Python/uv 可执行文件、`pyvenv.cfg`、venv/site-packages/uv-cache、密钥文件等禁用项均为 **0**。固定测试 API Key 和固定测试文本未出现；AWS 形字符串与官方 Electron 可执行文件中的原有字符串一致，并非本应用或测试引入。
- 因真实下载在首文件即失败，本次没有实际模型、Python 环境或测试参考音可供打包；扫描只能证明当前包未包含这些文件，不能替代一次成功真实生成后的排除检查。

**未执行项**

- 锁定 Python 环境安装及其版本/CUDA 验证。
- 固定音色（含温和情绪说明）与声音克隆的真实推理、耗时和进程健康验证。
- WAV/MP3/FLAC/M4A 的 ffprobe、非静音/非空音频检测及真实输出校验。
- 固定音色与克隆切换时单模型实例、任务锁释放及后续任务启动的真实验证。
- 便携安装包 E2E、安装器生成与发布；本任务仅构建并检查 `win-unpacked`。

#### 2026-11-10 复验记录（HEAD `71bb4293`）

**结论：BLOCKED。** 复验 HEAD 为 `71bb42936eb92c1aa8f4e203e321f56aad4a30c8`。镜像下载和原站回退已实际工作，组件完成到 87.663789% 后，原站连接再次超时；锁定 Python 环境、模型加载和真实推理均未开始。未修改生产代码，未使用或修改 ComfyUI Python，未读取用户素材或密钥，也未进行重复下载重试、代理调整或模型替换。

工作树复验前已有两个环境导入测试文件的未提交修改及 Python 缓存，本次保留原状。自动回归包含这些已有测试修改；复验提交仍只包含本计划文件。

**1. 自动回归：仅允许的 5 个已知失败**

- `npm run typecheck`：PASS。
- `npm test`：57 个测试文件中 56 通过、1 失败；2363 个测试中 **2357 通过、1 跳过、5 失败**。5 个失败全部位于 `tests/unit/environment-wizard.test.tsx`，均为允许豁免的 `imports an existing environment...` 用例，没有其他失败。
- 原始 `npm run typecheck && npm test && npm run build && npx playwright test --grep-invert "imports an existing environment"` 因上述 5 项在 `npm test` 后以退出码 1 停止。随后单独执行 `npm run build && npx playwright test --grep-invert "imports an existing environment"`：构建 PASS，Playwright **24 通过、1 跳过、0 失败**。
- 因此除明确允许的 5 项外，自动回归通过；原始串联命令本身不能记为退出码 0。

**2. 真实组件安装：23/27 文件后下载阻塞**

- 独立目录仍为 `G:\SMO-H3-Speech-Verification-20261110`，组件目标为 `data/components/speech/models`，运行时目标为 `data/components/speech/runtime`。清单 27 个文件，总计 `5,720,134,760` 字节（约 `5.327290632 GiB`）。
- 本次 `MediaComponentService.install('speech')` 实际运行 `138.913` 秒，完成 **23/27** 个文件、`5,014,486,838` 字节（**87.663789%**）。完成文件均在写入正式路径前通过下载器的预期大小和 SHA256 校验；失败后没有残留 `.part` 或分块账本文件，已完成的正确部分保留供以后明确要求的续传使用。
- 失败文件为 `Qwen3-TTS-Tokenizer-12Hz/configuration.json`，预期大小 `76` 字节，SHA256 `6bc26d64eb5024b4d1dab5a52371958b429256d6c9d59787f1f5294a54e0cebd`。镜像路径失败后，最终原站 URL 为 `https://huggingface.co/Qwen/Qwen3-TTS-Tokenizer-12Hz/resolve/7dd38ad4e9bad454aae9cd937d0cd577604fe229/configuration.json`。
- 完整最终错误：`TypeError: fetch failed`，原因 `ConnectTimeoutError / UND_ERR_CONNECT_TIMEOUT`，`timeout: 10000ms`，尝试地址 `104.244.43.208:443`、`2001::6ca0:a9b5:443`。证据保存在 `G:\SMO-H3-Speech-Verification-20261110\reports\download-root-cause-rerun.txt`、`install-failure.txt` 和 `install-progress.json`。
- 尚缺 `Qwen3-TTS-Tokenizer-12Hz/configuration.json`、`model.safetensors`、`preprocessor_config.json` 以及 `runtime/uv-0.11.13-x86_64-pc-windows-msvc.zip`，合计 `705,647,922` 字节。组件从未进入 ready 状态，按要求未再次重试。

**3. 锁定环境、真实推理与音频：未执行，无伪造结果**

- 因 uv 压缩包和 tokenizer 文件未完成，未执行 `SpeechRuntime.prepare()`，未创建或同步锁定 Python 3.12 环境，未加载 Qwen3-TTS，未启动固定音色或克隆任务。
- **真实输出：无。** 没有生成固定音色 WAV、克隆 WAV 或 MP3/FLAC/M4A；克隆参考音也没有生成。没有推理耗时、ffprobe 编码/采样率/时长、非静音检测或输出 SHA256 结果。
- 固定音色与克隆切换时的单模型实例、真实任务锁释放以及完成后立即启动另一任务仍未验证。任务 6 步骤 2 保持未勾选。

**4. 打包资源与打包态测试：PASS**

- 使用已校验的 Electron 45.0.0 本地分发目录执行离线 `npx electron-builder --win --dir --config.electronDist=G:\SMO-H3-Speech-Verification-20261110\electron-45.0.0`，随后以相同离线分发目录构建 portable，均成功；未签名、未发布。
- `npx playwright test --config playwright.package.config.ts --grep "portable runtime exposes packaged resources and excludes sensitive files"`：**1 通过、0 失败**，真实便携包启动和资源检查通过。
- `release/win-unpacked` 共 130 个磁盘文件、`418,003,107` 字节，`app.asar` 内另有 5461 个条目。
- `resources/resources/speech` 中 `pyproject.toml`、`uv.lock`、`qwen_tts_service.py` 均存在且非空，SHA256 分别为 `f7165c5c2a9c95ad7bdd9064e45cac1a7abf6aad55d818796606ef9cac8df455`、`f20d1167ed09065dfda245d2747fa9b6c142969e27f743b7f14d2d829b989244`、`c407e2284062d3a49b35034fd6b716a69c247fcb30a19c00b50b4ca45df33dce`，均与源文件一致。
- `resources/resources/environment/media-components.json` 存在，大小 `11,487` 字节，源文件与包内 SHA256 均为 `d7c472aa13cec943e88bac260f6fe4f7567add9c3ef64b88465e5ebe55e9419a`。
- 独立扫描包目录及 `app.asar`：模型文件、Python 环境/缓存/可执行文件、密钥、测试音频、固定测试文本及测试 API Key 的违规项均为 **0**；必需的 `qwen_tts_service.py` 是允许进入包内的服务源码，不是 Python 环境。报告位于 `G:\SMO-H3-Speech-Verification-20261110\reports\package-audit.json`。

**剩余风险：** 网络阻塞使真实语音主链路仍未得到本轮验收；打包结果不能替代真实模型加载、推理、音频有效性和任务调度验证。允许的 5 个环境导入测试失败仍使原始回归串联命令返回 1。

#### 2026-11-10 续验记录（HEAD `3e5ce70d`）

**结论：BLOCKED。** 复验 HEAD 为 `3e5ce70d507cc19949cea1a18b7dbef37f04b918`。既有 23 个文件全部复用，hf-mirror 已补齐 3 个 Tokenizer 文件；最终仅剩 GitHub uv 归档未完成。两次有界网络尝试均失败，未继续重试、未更换来源，也未修改生产代码。

**1. 真实组件安装：26/27 文件，uv 下载阻塞**

- 独立验收目录仍为 `G:\SMO-H3-Speech-Verification-20261110`。最终独立复算确认 **26/27** 个文件的预期大小和 SHA256 全部匹配，共 `5,696,780,240 / 5,720,134,760` 字节（**99.591714%**）；证据为 `reports/cache-verification.json`。
- 本次通过 hf-mirror 新补齐 `Qwen3-TTS-Tokenizer-12Hz/configuration.json`（76 字节）、`model.safetensors`（682,293,092 字节）和 `preprocessor_config.json`（234 字节）。未删除或替换任何已完成的大模型。
- 唯一缺失文件为 `runtime/uv-0.11.13-x86_64-pc-windows-msvc.zip`，大小 `23,354,520` 字节，清单 SHA256 为 `0953ac2ef4fbe47ad469bfa80b658a577a02c4d73a2fb9c4c7c70dda432efded`。本地目标缓存核查没有找到可复用归档；虽然系统存在独立 uv 命令，但未用它绕过清单归档校验。
- 第 1 次续装运行 `44.813` 秒，在 uv 下载阶段失败：`TypeError: fetch failed`，原因 `read ECONNRESET`。第 2 次续装运行 `16.360` 秒，仍在 uv 下载阶段失败：`ConnectTimeoutError / UND_ERR_CONNECT_TIMEOUT`，目标 `github.com:443`，超时 `10000ms`。
- 两次错误及进度快照分别保存在 `reports/install-attempt-1.log`、`install-attempt-2.log`、`install-failure-attempt-1.txt`、`install-failure-attempt-2.txt`、`install-progress-attempt-1.json` 和 `install-progress-attempt-2.json`。达到两次上限后未再联网重试，组件未进入 ready 状态。

**2. 锁定环境、真实推理与四格式：未执行**

- 因 uv 归档缺失，未执行 `SpeechRuntime.prepare()`，未创建或同步锁定 Python 3.12 环境，未加载 Qwen3-TTS，也未启动固定音色或克隆任务。
- **真实输出仍为空。** 固定音色 WAV、以该 WAV 和已知文本为参考的克隆 WAV、MP3、FLAC、M4A 均未生成；`output` 文件数为 0，没有推理耗时、ffprobe 编码/采样率/时长、非静音检测或输出 SHA256 结果。
- 固定音色与克隆切换时的单模型实例、任务锁释放及立即启动另一任务仍未得到真实验证，任务 6 步骤 2 保持未勾选。

**3. 限定自动回归：PASS**

- `npm run typecheck`：PASS。
- 相关语音/组件测试：`media-components`、`download`、`speech-runtime`、`speech-process`、`speech-generation`、`speech-form`、`studio`、`ipc`、`jobs` 共 **9 个测试文件、639 项测试全部通过**。
- `npm run build`：PASS；`npx playwright test tests/e2e/studio.spec.ts`：**20 通过、0 失败**。按要求未重复完整 `npm test` 或完整 E2E，本轮限定回归没有环境导入失败。

**4. 进程与 GPU 健康**

- 开始快照：RTX 5080，总计 `16303 MiB`，已用 `1244 MiB`，利用率 `2%`，温度 `44.50 C`。结束快照：已用 `1239 MiB`，利用率 `2%`，温度 `44.89 C`；没有 Qwen 推理负载。
- 验收目录下 Python 进程数为 0，锁定 venv、模型事件审计和真实验收结果文件均不存在。未终止或修改既有 ComfyUI/Python 进程，未读取用户素材或密钥。

#### 2026-11-10 续验记录（HEAD `24471b9d`）

**结论：BLOCKED。** 复验 HEAD 为 `24471b9dfd1f322e98346c1175caf56379598576`。26 个既有模型文件全部复用，GitHub uv 归档已补齐并通过 SHA256 校验；独立 Python 3.12.13 和 venv 已创建，但锁定依赖同步在下载 2.7 GiB 的 CUDA Torch wheel 时反复被对端断开，真实推理仍未开始。达到本轮边界后未再重试真实安装。

工作树复验前已有 `tests/e2e/environment.spec.ts`、`tests/unit/environment-wizard.test.tsx` 的未提交修改及 Python 缓存，本次保留原状。本轮新发现的两个 uv Windows 兼容性缺陷已在 `src/main/speech-runtime.ts` 和 `tests/unit/speech-runtime.test.ts` 中最小修复并完成红绿验证；按“只提交计划文件”的要求，这两个文件不纳入本次 commit。

**1. 组件与 uv 下载：PASS**

- `MediaComponentService.install('speech')` 实测 `8.1406924` 秒完成，27/27 文件为 ready，总计 `5,720,134,760` 字节，状态为 `active: false`、`error: null`；结果保存在 `reports/install-result.json` 和 `reports/install-ghproxy.log`。
- uv 归档大小为 `23,354,520` 字节，独立复算 SHA256 为 `0953ac2ef4fbe47ad469bfa80b658a577a02c4d73a2fb9c4c7c70dda432efded`，与锁定清单一致。没有替换或重新下载已校验的 26 个模型文件。

**2. uv 兼容性缺陷与独立 Python 环境**

- G 盘实际为 exFAT。Windows `bsdtar 3.5.2` 解压已校验 uv ZIP 时，对 `uv.exe`、`uvw.exe`、`uvx.exe` 均返回 `Can't restore time` 并以 1 退出；同一归档使用 `-m` 后退出 0。新增 exFAT 回归用例先因缺少 `-m` 失败，最小修复后通过。
- 对照探针进一步证实：在 NTFS 和 exFAT 上，刚执行临时目录中的 `uv.exe --version` 后重命名其父目录可能出现 `EPERM`；不执行该文件时重命名成功。修复顺序调整为解压并切换到固定工具目录后再执行版本检查，没有加入睡眠或无限重试。新增顺序用例同样先失败后通过，`speech-runtime` 最终 **7/7 PASS**。探针证据保存在 `reports/uv-lifecycle-probe*.log`。
- exFAT 上的 `uv python install 3.12` 已成功下载 `20.9 MiB` CPython，但创建 minor version link directory 时返回 Windows `os error 1 (函数不正确)`；uv 0.11.13 没有关闭该链接的命令行选项。
- 因此模型继续保留在 `G:\SMO-H3-Speech-Verification-20261110\data\components\speech\models`，通过目录联接复用；隔离运行时改到 NTFS 的 `C:\Users\FG\AppData\Local\SMO-H3-Speech-Verification-20261110\data\components\speech\runtime`。未使用或修改 ComfyUI Python。
- NTFS 运行时实测 `uv 0.11.13 (4512a3931)`、Python **3.12.13** 和 venv 创建成功。`uv sync --locked` 已解析 108 个锁定包并完成多个依赖下载/构建，但最终下载 `torch==2.9.1+cu128`（2.7 GiB）时多次重试后仍失败：`peer closed connection without sending TLS close_notify: unexpected EOF`，导致 distribution cache 写入失败。
- 最终 NTFS 验收运行耗时 `59.453` 秒。验收脚本末尾的 `model-events.jsonl ENOENT` 是模型服务从未启动后的派生错误；真正前置根因完整保存在 `reports/acceptance-failure.txt` 和 `reports/acceptance-run-ntfs-runtime.log`。当前 venv 中 `torch`、`qwen_tts`、`soundfile` 均不可导入，未继续执行推理或再次同步。

**3. 真实推理与四格式：未执行，步骤 2 不勾选**

- 因锁定依赖同步失败，未启动 Qwen 服务或加载模型，未生成短文本、温和情绪的固定音色 WAV，也未生成以该 WAV 和已知文本为参考的声音克隆。
- **真实输出仍为空。** `output` 文件数为 0，`audit/model-events.jsonl` 不存在；没有 WAV/MP3/FLAC/M4A 的真实 ffprobe 编码、采样率、时长、非静音检测、SHA256 或推理耗时结果。
- 固定音色与克隆的单模型实例切换、真实任务锁释放及锁释放后立即启动另一任务仍未验证。模拟 studio E2E 的音频用例不作为真实 Qwen 验收结果。

**4. 限定自动回归：PASS**

- `npm run typecheck`：PASS。
- 相关语音/组件测试：`media-components`、`download`、`speech-runtime`、`speech-process`、`speech-generation`、`speech-form`、`studio`、`ipc`、`jobs` 共 **9 个测试文件、649 项测试全部通过**。
- 第一次限定运行曾有一项 `重复选择同一音频...` 断言失败，其余 648 项通过；该用例单独运行通过。代码和断言确认是 `duration` 已重置但异步 `mediaUrl` 尚未生成 `<audio>` 的测试查询竞争，未修改生产代码或该测试；一次有界完整重跑为 **649/649 PASS**。
- `npm run build`：PASS；`npx playwright test tests/e2e/studio.spec.ts`：**20 通过、0 失败**。本轮按要求执行限定回归，没有运行完整环境导入测试，因此没有出现允许豁免的 5 项失败。

**5. 进程与 GPU 健康**

- NTFS 环境准备期间采集 18 个快照：RTX 5080，总计 `16303 MiB`，已用 `2310-2318 MiB`，利用率最高 `2%`，温度 `47.11-47.23 C`；只观察到本次验收的 uv/Python 进程，没有 Qwen 推理负载。
- 最终快照：已用 `2315 MiB`、利用率 `2%`、温度 `47.03 C`，驱动 `621.01`；两个验收根目录下的残留进程数为 **0**。未终止或修改既有 ComfyUI/Python 进程，未读取用户素材或密钥。
- 最终 commit 只包含本计划文件；模型、Python 环境、缓存、音频、验收脚本和其他工作树修改均不提交。

#### 2026-11-10 真实推理完成记录（HEAD `c00d2524`）

**结论：DONE。** 复验 HEAD 为 `c00d252473aabafa6882683f6038fe338d03a963`。通过注入已 prepared 的 `SpeechRuntime` 直接使用现有 venv 和模型，真实运行 `SpeechProcessManager`、应用生成服务、共享 `JobCoordinator` 与 FFmpeg 转换；未运行 `uv sync`，未重新安装 Python 依赖，未修改生产代码。

工作树复验前已有 `src/main/speech-runtime.ts`、`tests/unit/speech-runtime.test.ts` 两个 Windows 兼容性修复，以及 `tests/e2e/environment.spec.ts`、`tests/unit/environment-wizard.test.tsx` 和 Python 缓存。全部保留原状，最终提交仍只包含本计划文件。

**1. 已准备运行时与真实生成路径：PASS**

- 使用 `G:\SMO-H3-Speech-Verification-20261110\data\components\speech\runtime\venv\Scripts\python.exe`，实测 Python **3.12.13**、`torch 2.9.1+cu128`、`qwen_tts` 和 `soundfile 0.14.0` 可导入，CUDA 为 `True`，设备为 RTX 5080。
- 既有组件清单仅在本地复验，耗时 `5.958` 秒，状态为 ready，`5,720,134,760 / 5,720,134,760` 字节；没有依赖安装或下载。`SpeechRuntime.prepare()` 被验收 harness 替换为现有 venv 的 prepared 结果，真实模型生成未被替换或模拟。
- 首次 harness 因写死大写 `Vivian` 而在生成前停止；真实 capabilities 返回小写音色列表。随后改为选择真实返回的 `aiden` 并完整重跑，未改服务或模型。固定文本为“大家好，这是一段本地语音验收。”，情绪说明为“温和、平静、亲切地讲述，语速稍慢。”；克隆文本为“声音克隆验收完成，感谢聆听。”。
- 克隆参考音是本轮刚生成的固定音色 WAV，参考文本就是上述固定文本；未读取用户素材。

**2. 真实输出、格式与耗时：PASS**

| 模式/格式 | 编码 | 采样率 | 时长 | 字节 | 最大音量 | 端到端耗时 | 模型推理耗时 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 固定 WAV | `pcm_s16le` | 24000 Hz | 2.64 s | 126764 | -6.2 dB | 20.373 s | 20.004 s |
| 固定 MP3 | `mp3` | 24000 Hz | 3.60 s | 14829 | -2.2 dB | 4.859 s | 4.387 s |
| 固定 FLAC | `flac` | 24000 Hz | 2.88 s | 76304 | -5.7 dB | 3.820 s | 3.476 s |
| 固定 M4A | `aac` | 24000 Hz | 3.04 s | 29289 | -2.1 dB | 4.001 s | 3.631 s |
| 克隆 WAV | `pcm_s16le` | 24000 Hz | 2.64 s | 126764 | -7.1 dB | 6.061 s | 5.674 s |

- 五个输出均为单声道、非空、非零时长；FFmpeg `volumedetect` 均高于 `-60 dB`，不是纯静音。完整真实验收测试耗时 `55.29` 秒。
- 随后独立重新执行 ffprobe、volumedetect 和 SHA256 复核，**5/5 PASS**。文件哈希未变化；完整路径、SHA256 和模型事件见 `reports/prepared-acceptance-result-run2.json` 与 `reports/prepared-independent-audio-audit.json`。

**3. 单模型实例、任务锁与健康：PASS**

- 审计共有 `model_loaded=2`、`model_reused=4`、`generation_complete=5`、`release_start=2`、`release_end=2`、`server_stop=1`。固定音色任务复用同一实例；切到克隆时先释放固定模型，再加载 Base 模型；事件顺序断言确认任意时刻最多一个模型实例。
- 首个任务 active 时第二次提交被 `Another generation is already running` 拒绝，且没有新增作品。每个任务结束后的 `activeCountAfter` 都为 0；随后通过视频路由启动一个仅调度探针，`activeCountInside=1`、`activeCountAfter=0`。该探针只验证锁释放和视频任务入口，没有执行真实 H3 视频渲染。
- 12 个健康快照显示：RTX 5080 总计 `16303 MiB`，初始已用 `2505 MiB`，峰值已用 `7079 MiB`，峰值利用率 `30%`，峰值温度 `49.55 C`；最终已用 `2493 MiB`，验收目录下 Python 进程数为 **0**。未终止既有 ComfyUI、应用或用户进程。

**4. 限定自动回归：PASS，保留一次非重现差异**

- `npm run typecheck`：PASS。
- 相关 Vitest：media/components、download、speech runtime/process/generation/form、audio converter/duration、jobs、studio、IPC、generation、files、works 共 **14 个文件、845/845 项通过**。
- 使用 prepared venv 直接运行 `tests/python/test_qwen_tts_service.py`：**3/3 PASS**，覆盖本地模型加载、模式切换释放及加载失败清理。
- `npm run build`：PASS。首次 studio E2E 为 **19 通过、1 失败**：MP3 用例的情绪草稿预期为 `Calm and warm.`，实际末尾多一个空格；音频预览与生成断言不是失败点。未修改测试或生产代码，MP3 单例原样重跑通过，随后一次有界完整重跑为 **20/20 PASS**。首轮非重现差异保留在 `reports/prepared-build-studio-e2e.log`，最终结果为 `reports/prepared-studio-e2e-rerun.log`。
- 本轮按要求运行相关语音/组件测试和 studio E2E，没有重跑完整环境导入测试，也没有把模拟 studio 音频作为真实 Qwen 输出。

**5. 证据与提交范围**

- 真实运行日志为 `reports/prepared-acceptance-run2.log`，健康采样为 `reports/prepared-gpu-process-health-run2.jsonl`，模型事件为 `audit/prepared-c00d252-run2/model-events.jsonl`，均位于 `G:\SMO-H3-Speech-Verification-20261110`。
- 输出位于仓库外的 `output/prepared-c00d252-run2/SMO-Speech`。模型、venv、缓存、验收 harness、音频、报告、既有 runtime 修复和其他工作树修改均不纳入 commit。

