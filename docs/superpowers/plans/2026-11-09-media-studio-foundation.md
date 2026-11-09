# 多媒体制作台共享基础实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在保持现有 H3 视频可用的前提下，建立语音、图像、视频共用的数据模型、单任务互斥、作品管理和媒体输入，并完成视频步数、完整模特图、音频拖入与录音。

**架构：** 现有 `jobs:start` 逐步扩展为严格判别联合请求；SQLite 通过一次性事务迁移支持无模特的语音/图像作品。`JobCoordinator` 改为无队列的单任务执行器，主进程拒绝并发，渲染层用 `jobs:getState` 禁用所有生成入口。录音和拖入文件都只能通过专用 IPC 进入授权媒体集合。

**技术栈：** Electron、React、TypeScript、Zod、Node SQLite、MediaRecorder、FFmpeg、Vitest、Playwright。

**规格：** `docs/superpowers/specs/2026-11-09-media-studio-design.md`

**依赖关系：** 本计划先完成；本地语音和 Qwen 图像计划都依赖这里的数据模型、任务锁和作品服务。

---

## 文件职责

- 修改 `src/shared/types.ts`：增加 `speech/image` 作品模式、联合生成请求、步数和音频格式类型。
- 修改 `src/shared/ipc.ts`：严格校验联合请求，增加任务状态、拖入音频和录音保存 IPC。
- 修改 `src/main/jobs.ts`：移除等待队列，提供原子单任务执行和活动 ID。
- 修改 `src/main/store.ts`：事务迁移 `works`，允许 `avatarId = null` 和四种模式。
- 创建 `src/main/audio-converter.ts`：共用的 WAV、MP3、FLAC、M4A 与录音 WAV 转换。
- 创建 `src/main/recordings.ts`：限制录音字节、格式和输出目录，完成安全落盘。
- 修改 `src/main/files.ts`、`src/main/media.ts`：授权拖入音频并管理录音目录。
- 创建 `src/renderer/StepNumberField.tsx`：步数加减和数值输入。
- 创建 `src/renderer/AudioInput.tsx`、`src/renderer/AudioRecorder.tsx`：语音克隆与音频数字人共用的音频输入和录音 UI。
- 创建 `src/renderer/useActiveJob.ts`：同步全局活动任务状态。
- 修改 `src/renderer/StudioPage.tsx`、`TextToVideoForm.tsx`、`AudioDigitalHumanForm.tsx`：视频子模式、步数、完整图片和音频输入。
- 修改 `src/renderer/WorksPage.tsx`、`src/main/works.ts`：三种媒体预览与筛选、无等待中入口、媒体删除。
- 修改对应 `tests/unit/*`、`tests/e2e/studio.spec.ts` 和打包资源测试。

### 任务 1：共享类型、请求校验与视频步数写入

**文件：** `src/shared/types.ts`、`src/shared/ipc.ts`、`src/shared/workflow-nodes.ts`、`src/main/generation.ts`、`tests/unit/ipc.test.ts`、`tests/unit/generation.test.ts`

- [x] **步骤 1：编写失败测试**

在 IPC 测试中验证三种模式的严格负载，并先让视频 `steps` 生效：

```ts
const video = { ...textRequest, steps: 12 };
await handlers.get('jobs:start')?.(video);
expect(services.startGeneration).toHaveBeenCalledWith(video);
await expect(handlers.get('jobs:start')?.({ ...video, steps: 0 })).rejects.toThrow();
await expect(handlers.get('jobs:start')?.({ ...video, steps: 1.5 })).rejects.toThrow();
```

在生成 harness 中分别以文字 `steps: 12`、音频 `steps: 9` 运行，断言提交图的 `124.inputs.steps === 12`、`51.inputs.steps === 9`，Spark 节点的 `inputs.steps` 与之一致；缺省旧请求仍使用 8/6，以兼容既有重试记录。

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/ipc.test.ts tests/unit/generation.test.ts -t "steps|request"`

预期：FAIL，当前 schema 拒绝 `steps`，工作流没有对应路径。

- [x] **步骤 3：实现联合类型和步数补丁**

在共享类型中建立：

```ts
export type VideoMode = 'text' | 'audio';
export type WorkMode = VideoMode | 'speech' | 'image';
export type AudioOutputFormat = 'wav' | 'mp3' | 'flac' | 'm4a';
export interface VideoGenerationRequest {
  mode: VideoMode;
  avatarId: string;
  prompt: string;
  duration: number;
  seed: number;
  steps: number;
  audioPath?: string;
  trimStart?: number;
  retryOf?: string;
}
```

后续计划分别加入 `ImageGenerationRequest` 和 `SpeechGenerationRequest`，最终导出 `GenerationRequest` 判别联合。`Work.mode` 改为 `WorkMode`，`Work.avatarId` 改为 `string | null`。

本任务先导出 `type GenerationRequest = VideoGenerationRequest`；语音计划扩展为 `VideoGenerationRequest | SpeechGenerationRequest`，图像计划最后加入 `ImageGenerationRequest`。

新增路径：

```ts
text.steps = '124.inputs.steps';
audio.steps = '51.inputs.steps';
```

`sanitizeRequest` 保留 `steps`，校验范围为整数 `1-100`，并把值加入两种视频的 `changes`。重试旧元数据缺少 `steps` 时按原模式补 8 或 6。

- [x] **步骤 4：运行测试确认通过**

运行：`npx vitest run tests/unit/ipc.test.ts tests/unit/generation.test.ts tests/unit/spark-acceleration.test.ts`

预期：PASS。

- [x] **步骤 5：提交**

```bash
git add src/shared/types.ts src/shared/ipc.ts src/shared/workflow-nodes.ts src/main/generation.ts tests/unit/ipc.test.ts tests/unit/generation.test.ts
git commit -m "Add adjustable H3 scheduler steps"
```

### 任务 2：无队列单任务协调器与全局锁定

**文件：** `src/main/jobs.ts`、`src/main/generation.ts`、`src/main/ipc.ts`、`src/preload/index.ts`、`src/renderer/useActiveJob.ts`、`tests/unit/jobs.test.ts`、`tests/unit/jobs-lifecycle.test.ts`、`tests/unit/ipc.test.ts`

- [x] **步骤 1：编写失败测试**

```ts
const first = deferred<void>();
void coordinator.enqueue({ id: 'one', run: () => first.promise });
await expect(coordinator.enqueue({ id: 'two', run: vi.fn() }))
  .rejects.toThrow('Another generation is already running');
expect(coordinator.activeId).toBe('one');
expect(events.map((event) => event.status)).not.toContain('pending');
```

生成服务测试断言活动任务存在时第二次 `jobs:start` 被拒绝且 `store.addWork` 没有第二次调用。`jobs:getState` 返回 `{ activeId: 'one' }`，无任务时返回 `{ activeId: null }`。

- [x] **步骤 2：运行测试确认旧排队行为导致失败**

运行：`npx vitest run tests/unit/jobs.test.ts tests/unit/jobs-lifecycle.test.ts tests/unit/ipc.test.ts`

预期：FAIL，第二个任务当前会进入队列。

- [x] **步骤 3：实现无队列执行与状态 IPC**

删除 `queue` 和 `pump` 的排队分支。`enqueue` 在校验 ID 后同步检查 `active`，直接设置活动项并启动执行：

```ts
if (this.active !== null) {
  throw new Error('Another generation is already running');
}
this.active = item;
this.emit({ id: job.id, status: 'running' });
void this.run(item);
```

`activeId` 返回 `this.active?.job.id ?? null`；`cancel(id)` 只处理活动 ID；`close()` 只结束活动任务。生成处理器在 `store.addWork` 前检查 `activeCount`，并在同一同步区段添加作品和调用 `enqueue`，确保拒绝时不产生新记录。

注册 `jobs:getState` 空负载及 `SmoApi.jobs.getState()`。新增 `useActiveJob` 每 500 ms 查询，在页面隐藏时停止轮询，并提供 `activeId`、`busy`、`refresh`。

- [x] **步骤 4：运行任务与 IPC 测试**

运行：`npx vitest run tests/unit/jobs.test.ts tests/unit/jobs-lifecycle.test.ts tests/unit/generation.test.ts tests/unit/ipc.test.ts`

预期：PASS，原“排队执行”测试已改为“拒绝并发”。

- [x] **步骤 5：提交**

```bash
git add src/main/jobs.ts src/main/generation.ts src/main/ipc.ts src/shared/ipc.ts src/preload/index.ts src/renderer/useActiveJob.ts tests/unit/jobs.test.ts tests/unit/jobs-lifecycle.test.ts tests/unit/generation.test.ts tests/unit/ipc.test.ts
git commit -m "Replace generation queue with a single active task"
```

### 任务 3：步进器与视频表单

**文件：** `src/renderer/StepNumberField.tsx`、`src/renderer/TextToVideoForm.tsx`、`src/renderer/AudioDigitalHumanForm.tsx`、`src/renderer/styles.css`、`tests/unit/studio.test.tsx`

- [x] **步骤 1：编写失败渲染测试**

分别渲染两种视频表单，点击“增加步数”后断言文字从 8 到 9、音频从 6 到 7；直接输入 12 后提交，断言 `jobs:start` 收到 `steps: 12`。输入 0、101、小数时显示中文错误且不提交；全局 `busy` 时两个生成按钮均禁用。

- [x] **步骤 2：运行测试确认控件不存在**

运行：`npx vitest run tests/unit/studio.test.tsx -t "步数|busy"`

预期：FAIL。

- [x] **步骤 3：实现共用步进器**

组件契约：

```tsx
<StepNumberField
  id="text-steps"
  label="采样步数"
  value={steps}
  recommended={8}
  min={1}
  max={100}
  disabled={submitting || busy}
  onChange={setSteps}
/>
```

使用 `Minus`、`Plus` 图标按钮和 `input type="number"`，按钮具有 `aria-label="减少步数"`、`aria-label="增加步数"`，尺寸固定，不让输入内容改变布局。超过推荐值时显示“高于推荐值会增加耗时”。两个表单提交请求带 `steps`，并将 `busy` 合并到提交、润色和音频操作禁用条件。

- [x] **步骤 4：运行渲染测试和类型检查**

运行：`npx vitest run tests/unit/studio.test.tsx && npm run typecheck`

预期：PASS。

- [x] **步骤 5：提交**

```bash
git add src/renderer/StepNumberField.tsx src/renderer/TextToVideoForm.tsx src/renderer/AudioDigitalHumanForm.tsx src/renderer/styles.css tests/unit/studio.test.tsx
git commit -m "Add step controls to video forms"
```

### 任务 4：作品数据库迁移、筛选与媒体删除

**文件：** `src/main/store.ts`、`src/main/works.ts`、`src/renderer/WorksPage.tsx`、`tests/unit/store.test.ts`、`tests/unit/works.test.ts`、`tests/unit/studio.test.tsx`

- [x] **步骤 1：编写失败测试**

先用旧 schema 创建含文字作品的数据库，再打开新 `Store`，断言旧作品字段不变，并可新增：

```ts
store.addWork({ id: 'speech', avatarId: null, mode: 'speech', outputPath: null, status: 'running' });
store.addWork({ id: 'image', avatarId: null, mode: 'image', outputPath: null, status: 'done' });
```

作品服务参数化验证 `.wav/.mp3/.flac/.m4a/.png/.jpg/.webp` 可删除，输出仍必须在输出根目录且不能是符号链接。WorksPage 断言没有“等待中”筛选，语音使用 `audio`、图像使用 `img`、视频使用 `video`，无模特作品不显示“未知模特”。

- [x] **步骤 2：运行测试确认旧约束失败**

运行：`npx vitest run tests/unit/store.test.ts tests/unit/works.test.ts tests/unit/studio.test.tsx -t "media|作品|speech|image"`

预期：FAIL，旧 `CHECK` 和非空外键拒绝新模式。

- [x] **步骤 3：实现事务迁移与通用媒体卡片**

读取 `sqlite_master` 和 `PRAGMA table_info`，仅对旧 `works` 执行一次事务：创建带四模式及可空 `avatarId` 的 `works_media`，按明确列清单复制，删除旧表并重命名，失败回滚。保留 `FOREIGN KEY (avatarId) REFERENCES avatars(id) ON DELETE RESTRICT`。

`WorkService` 按模式校验输出扩展名，沿用按句柄删除和附属文件匹配。`WorksPage` 筛选为全部、语音、图像、文字生视频、音频数字人、运行中、已完成、失败；标题回退使用“语音作品”或“图像作品”。新增 `WorkMedia` 按 `work.mode` 选择媒体元素。

- [x] **步骤 4：运行测试**

运行：`npx vitest run tests/unit/store.test.ts tests/unit/works.test.ts tests/unit/studio.test.tsx`

预期：PASS。

- [x] **步骤 5：提交**

```bash
git add src/main/store.ts src/main/works.ts src/renderer/WorksPage.tsx src/shared/types.ts tests/unit/store.test.ts tests/unit/works.test.ts tests/unit/studio.test.tsx
git commit -m "Support speech and image works"
```

### 任务 5：音频拖入与共用输入组件

**文件：** `src/main/files.ts`、`src/shared/ipc.ts`、`src/preload/index.ts`、`src/renderer/AudioInput.tsx`、`src/renderer/AudioDigitalHumanForm.tsx`、`tests/unit/files.test.ts`、`tests/unit/ipc.test.ts`、`tests/unit/studio.test.tsx`

- [x] **步骤 1：编写失败测试**

仿照现有照片拖放测试，覆盖一个音频成功、多文件拒绝、非音频拒绝、子元素 `dragleave` 保持高亮、过期授权不得覆盖新选择、生成中禁止替换。主进程测试：

```ts
await expect(files.authorizeDroppedAudio('G:\\audio\\voice.mp3')).resolves.toBe(path);
await expect(files.authorizeDroppedAudio('G:\\audio\\voice.txt')).rejects.toThrow(/Unsupported audio/);
```

preload 断言与照片一样通过 `webUtils.getPathForFile(file)` 获取路径，IPC 不接收渲染器自报的任意路径字符串。

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/files.test.ts tests/unit/ipc.test.ts tests/unit/studio.test.tsx -t "audio.*drop|拖入|拖放"`

预期：FAIL。

- [x] **步骤 3：实现专用授权与 AudioInput**

注册 `files:authorizeDroppedAudio`，文件服务复用音频扩展白名单并调用 `mediaRegistry.authorizeSelectedFile`。`AudioInput` 接收 `path`、`disabled`、`onSelected` 和 `onError`，整合选择按钮、拖放区、文件名与移除；选择器和拖放共享一个递增操作 ID，避免慢授权覆盖新选择。

音频数字人保留 `audioPath/audioSeconds` 状态，但将选择和拖入统一交给 `AudioInput`，切换面板不清空。

- [x] **步骤 4：运行测试**

运行：`npx vitest run tests/unit/files.test.ts tests/unit/ipc.test.ts tests/unit/studio.test.tsx && npm run typecheck`

预期：PASS。

- [x] **步骤 5：提交**

```bash
git add src/main/files.ts src/shared/ipc.ts src/preload/index.ts src/renderer/AudioInput.tsx src/renderer/AudioDigitalHumanForm.tsx tests/unit/files.test.ts tests/unit/ipc.test.ts tests/unit/studio.test.tsx
git commit -m "Allow dragging audio into digital human"
```

### 任务 6：录音服务与音频数字人录音

**文件：** 创建 `src/main/audio-converter.ts`、`src/main/recordings.ts`、`src/renderer/AudioRecorder.tsx`；修改 `src/main/media.ts`、`src/main/app-services.ts`、`src/shared/ipc.ts`、`src/preload/index.ts`、`src/renderer/AudioDigitalHumanForm.tsx`；新增对应单元测试。

- [x] **步骤 1：编写失败测试**

主进程测试注入假转换器，验证只接受非空且不超过 200 MiB 的 `Uint8Array`，输入写入唯一临时 WebM，输出固定为录音目录中的 UUID `.wav`，成功后删除临时文件并授权输出。转换失败时清理临时文件，不覆盖当前选择。

渲染测试 mock `navigator.mediaDevices.getUserMedia`、`MediaRecorder` 和 `recordings:save`，覆盖开始录音、停止、字节保存、试听、重录、权限拒绝和组件隐藏时停止音轨：

```ts
fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
fireEvent.click(screen.getByRole('button', { name: '停止录音' }));
await waitFor(() => expect(onRecorded).toHaveBeenCalledWith('G:\\data\\recordings\\one.wav'));
```

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/recordings.test.ts tests/unit/audio-converter.test.ts tests/unit/studio.test.tsx -t "录音|recording"`

预期：FAIL，服务和 IPC 尚不存在。

- [x] **步骤 3：实现转换、受控落盘和录音 UI**

`audio-converter.ts` 提供：

```ts
export type AudioConversionFormat = 'wav' | 'mp3' | 'flac' | 'm4a';
export interface AudioConvertInput {
  ffmpegPath: string;
  sourcePath: string;
  destinationPath: string;
  format: AudioConversionFormat;
  signal?: AbortSignal;
}
```

WAV 录音使用 `-ac 1 -ar 24000 -c:a pcm_s16le`；其他格式使用 WAV 源，MP3 使用 `libmp3lame`，FLAC 使用 `flac`，M4A 使用 `aac`。始终 `-nostdin -y`，主进程负责唯一目标路径。

注册 `recordings:save`，preload 将 `Blob.arrayBuffer()` 转为 `Uint8Array`。`MediaRegistry` 增加 `recordingsDirectory` 管理根。`AudioRecorder` 只响应用户点击申请麦克风，停止时关闭所有 track，并调用 `onRecorded(path)` 更新同一音频状态。

- [x] **步骤 4：运行测试和真实 FFmpeg 转换验收**

运行：`npx vitest run tests/unit/recordings.test.ts tests/unit/audio-converter.test.ts tests/unit/studio.test.tsx && npm run typecheck`

再用当前运行时 FFmpeg 生成 1 秒测试音，分别转换 WAV、MP3、FLAC、M4A，使用 ffprobe 断言格式和非零时长。

- [x] **步骤 5：提交**

```bash
git add src/main/audio-converter.ts src/main/recordings.ts src/main/media.ts src/main/app-services.ts src/shared/ipc.ts src/preload/index.ts src/renderer/AudioRecorder.tsx src/renderer/AudioDigitalHumanForm.tsx tests/unit/recordings.test.ts tests/unit/audio-converter.test.ts tests/unit/studio.test.tsx
git commit -m "Add local microphone recording"
```

### 任务 7：视频布局与完整模特参考图

**文件：** `src/renderer/StudioPage.tsx`、`src/renderer/styles.css`、`tests/unit/studio.test.tsx`、`tests/unit/layout.test.ts`、`tests/e2e/studio.spec.ts`

- [x] **步骤 1：编写失败测试**

断言存在主模式 ARIA 结构所需的视频面板和内部“文字生视频 / 音频数字人”子模式，语音/图像 tab 由后续计划接入。模特区只在视频内容中渲染，图片不使用固定 `aspect-ratio`，样式计算结果为 `object-fit: contain`。切换页面和子模式后已输入文本、已选音频、步数保持不变。

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/studio.test.tsx tests/unit/layout.test.ts -t "模特|视频子模式"`

预期：FAIL，当前图片为 `cover` 且固定 4:5。

- [x] **步骤 3：调整结构与样式**

将现有 `mode` 重命名为 `videoMode`，视频控制区保留两个子 tab。模特区域使用：

```css
.person-preview .avatar-image { aspect-ratio: auto; min-height: 180px; overflow: visible; }
.person-preview .avatar-image img { width: 100%; height: auto; max-height: 65vh; object-fit: contain; }
```

不改变数字模特列表的卡片裁切。所有面板保持挂载，仅通过 `hidden` 切换。

- [x] **步骤 4：运行布局与 E2E 测试**

运行：`npx vitest run tests/unit/studio.test.tsx tests/unit/layout.test.ts && npm run build && npx playwright test tests/e2e/studio.spec.ts`

预期：PASS。

- [x] **步骤 5：提交**

```bash
git add src/renderer/StudioPage.tsx src/renderer/styles.css tests/unit/studio.test.tsx tests/unit/layout.test.ts tests/e2e/studio.spec.ts
git commit -m "Refine video workspace and media inputs"
```

### 任务 8：基础链路完整验证

- [x] **步骤 1：完整自动验证**

运行：

```bash
npm run typecheck
npm test
npm run test:e2e
```

预期：除主线程尚未完成的已有环境导入测试外全部通过；若那两项仍未完成，使用 `--grep-invert "imports an existing environment"` 并明确记录，不得把其未提交改动纳入本计划提交。

- [ ] **步骤 2：真实视频回归**

使用合成参考图和短音频分别运行 4 秒文字视频与音频数字人，修改步数后从 `/history` 验证调度器和 Spark 步数一致。检查作品可播放、取消后锁释放、删除后实际媒体消失。

- [x] **步骤 3：提交验证记录**

在 `docs/superpowers/plans/2026-11-09-media-studio-foundation.md` 记录实际测试数量、真实输出和未执行项，只提交本计划文件。

### 任务 8 实际验证记录（2026-11-09）

Base HEAD：`fe72a0068a942156bcaf9273f00ce6d4571bdea8`。

- `npm run typecheck`：通过。
- `npm test`：52 个测试文件，2170 个测试；2164 通过、5 失败、1 跳过。5 个失败全部来自未提交的 `tests/unit/environment-wizard.test.tsx`“使用已有环境”测试，没有媒体 URL 单测失败或其他失败。
- `npm run build`：通过。
- `npx playwright test --grep-invert "imports an existing environment"`：21 个测试，20 通过、1 跳过（`captures README screenshots`）；排除的已有环境导入 E2E 未执行，其余 E2E 全部通过。
- `SMO_REAL_FFMPEG=1 npx playwright test --config playwright.real.config.ts tests/e2e/real-audio-converter.spec.ts`：1/1 通过。程序生成 1 秒音源，WAV、MP3、FLAC、M4A 均经 ffprobe 验证为预期编码、24000 Hz、单声道且时长非零；时长分别为 1、1.056、1、1 秒。

真实视频回归状态：**BLOCKED**。复用已有健康且空闲的 ComfyUI，仅以程序生成的合成人物 PNG 和 4 秒合成 WAV 作为输入，通过隔离 Electron 数据目录及现有 `window.smo` IPC/真实生成 handler 提交任务；未停止后端，未读取或上传用户素材。

- 只提交了一次 4 秒文字视频任务，使用 0.3 MP、1 step；workId `d041edca-188c-47af-b633-73de55899058`，promptId `bb22796b-9827-4dc6-a32b-cc8ca30e6d6f`。
- `/history` 证明 BasicScheduler `124.inputs.steps = 1` 与 Spark `smo_spark.inputs.steps = 1` 一致，Spark 类型为 `MiniMaxH3SparkAttentionSM120`；但采样器 `269.inputs.transition_step = 6`，后端报错 `selflift-Avatar: transition_step 6 out of range for 1 steps`，history 状态为 `error`，没有输出节点。
- 按要求未换步数重试，未生成更多任务；4 秒音频数字人未执行。由于没有成功输出，两条链路的可读取/非空/可播放/时长格式验证、成功作品媒体及附属文件删除验证均未执行，音频链路的 history steps 也未验证。
- 失败任务结束后单任务锁已释放，失败作品记录已删除；文件系统没有该 workId 的媒体或附属文件残留。ComfyUI 队列运行/等待均为 0，关闭隔离应用后健康检查仍为 HTTP 200。
- 删除前后对比确认输出目录原有 145 个文件均未缺失、大小和修改时间未变，用户原始 `studio.sqlite` 与 `environment.json` 也未变化；临时数据库、合成输入和模特已清理。

