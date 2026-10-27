# SMO.H3 Studio 三项反馈实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 0.1.1 中实现保存前照片预览/移除、无需预填模型的上游发现，以及可复用的 ComfyUI 按需启动和生成前检查。

**架构：** 渲染进程只组合现有授权预览和受控 IPC。模型发现使用独立连接解析，完整模型配置仍用于保存、测试和润色。主进程新增 `ComfyProcessManager`，与 `ComfyClient` 分离，设置页和生成服务共享同一个 `ensureReady()`。

**技术栈：** Electron、React、TypeScript、Zod、Node.js child_process/fs、Vitest、Testing Library、Playwright、electron-builder。

---

## 文件结构与职责

- `src/renderer/AvatarsPage.tsx`：待保存照片预览、移除和保存状态。
- `src/renderer/useMediaUrl.ts`、`src/renderer/AvatarImage.tsx`：复用现有授权媒体能力，不修改。
- `src/renderer/SettingsPage.tsx`：独立的模型发现条件、模型选择和 ComfyUI 启动状态。
- `src/renderer/styles.css`：稳定的待保存预览尺寸和移除按钮布局。
- `src/shared/types.ts`：LLM 发现输入与可选模型连接类型。
- `src/shared/ipc.ts`：`llm:listModels` 独立 schema、`comfy:start` 通道和 preload API 类型。
- `src/main/llm.ts`：复用共享的可选模型连接类型。
- `src/main/llm-config.ts`：分离发现连接解析与完整凭据解析。
- `src/main/comfy-process.ts`：ComfyUI 本机启动、健康等待、并发去重和启动日志。
- `src/main/generation.ts`：上传前调用可选 `ensureReady()`。
- `src/main/app-services.ts`：组装进程管理器、启动 IPC 服务和关闭行为。
- `src/main/ipc.ts`、`src/preload/index.ts`：受控 `comfy:start` 分发。
- `tests/unit/studio.test.tsx`：照片和设置页交互。
- `tests/unit/llm-config.test.ts`：发现连接与完整凭据解析。
- `tests/unit/llm.test.ts`、`tests/unit/ipc.test.ts`：上游模型发现和 IPC 契约。
- `tests/unit/comfy-process.test.ts`：进程启动、并发、失败和关闭。
- `tests/unit/generation.test.ts`：生成前检查及失败状态。
- `tests/e2e/studio.spec.ts`、`tests/e2e/startup.spec.ts`：真实 Electron 交互和 API 暴露。
- `tests/e2e/real-comfy.spec.ts`、`playwright.real.config.ts`：显式运行的真实 SelfLift 健康验收。
- `package.json`、`package-lock.json`：0.1.1 和真实验收脚本。

### 任务 1：保存前照片预览与移除

**文件：** `src/renderer/AvatarsPage.tsx`、`src/renderer/styles.css`、`tests/unit/studio.test.tsx`、`tests/e2e/studio.spec.ts`

- [ ] **步骤 1：先写失败交互测试**

在 `tests/unit/studio.test.tsx` 新增：

```tsx
test('previews and removes a selected photo without deleting the source', async () => {
  smo.avatars.list.mockResolvedValue([]);
  smo.files.selectImage.mockResolvedValue('G:\\photos\\preview.png');
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

  fireEvent.click(screen.getByRole('button', { name: '选择照片' }));
  const preview = await screen.findByRole('img', { name: '待保存模特照片预览' });
  expect(preview).toHaveAttribute(
    'src',
    `smo-media://media/${encodeURIComponent('G:\\photos\\preview.png')}`,
  );

  fireEvent.click(screen.getByRole('button', { name: '移除照片' }));
  expect(screen.queryByRole('img', { name: '待保存模特照片预览' })).not.toBeInTheDocument();
  expect(screen.getByText('尚未选择照片')).toBeInTheDocument();
  expect(smo.avatars.delete).not.toHaveBeenCalled();
});
```

另补保存失败保留预览的测试：`smo.avatars.create.mockRejectedValue(new Error('保存失败'))`，选择图片和输入名称后提交，断言预览仍存在。

- [ ] **步骤 2：运行测试确认因缺少预览和移除按钮而失败**

运行：`npx vitest run tests/unit/studio.test.tsx`

预期：新用例 FAIL，找不到 `待保存模特照片预览` 和 `移除照片`。

- [ ] **步骤 3：实现最小预览、移除和稳定样式**

在 `AvatarsPage` 顶层调用 `const selectedPreview = useMediaUrl(photoPath);`，选中照片后渲染：

```tsx
{photoPath && (
  <div className="selected-photo-preview">
    {selectedPreview.url ? (
      <img src={selectedPreview.url} alt="待保存模特照片预览" />
    ) : (
      <span role={selectedPreview.error ? 'alert' : undefined}>
        {selectedPreview.error ?? '正在读取照片…'}
      </span>
    )}
    <div className="selected-file">{fileName(photoPath)}</div>
    <button
      className="button button-secondary"
      type="button"
      disabled={selecting || saving}
      onClick={() => {
        setPhotoPath(null);
        setError(null);
      }}
    >
      <X size={16} aria-hidden="true" /> 移除照片
    </button>
  </div>
)}
```

仅在没有 `photoPath` 时显示 `尚未选择照片`。保存失败路径不改变 `photoPath`。CSS 使用固定预览高度、`object-fit: contain` 和不超过父容器的宽度，避免图片加载造成布局跳动。

- [ ] **步骤 4：运行组件与 Electron 测试**

运行：`npx vitest run tests/unit/studio.test.tsx`

运行：`npx playwright test tests/e2e/studio.spec.ts --grep "creates and selects an avatar"`

预期：组件测试通过；E2E 选择后预览出现、移除后消失，未调用删除 API。

- [ ] **步骤 5：Commit**

```bash
git add src/renderer/AvatarsPage.tsx src/renderer/styles.css tests/unit/studio.test.tsx tests/e2e/studio.spec.ts
git commit -m "Add pre-save avatar photo preview and removal"
```

### 任务 2：独立模型发现契约与页面条件

**文件：** `src/shared/types.ts`、`src/shared/ipc.ts`、`src/main/llm.ts`、`src/main/llm-config.ts`、`src/main/ipc.ts`、`src/renderer/SettingsPage.tsx`、创建 `tests/unit/llm-config.test.ts`、`tests/unit/llm.test.ts`、`tests/unit/ipc.test.ts`、`tests/unit/studio.test.tsx`

- [ ] **步骤 1：写空模型发现与完整配置保护的失败测试**

在 `tests/unit/llm-config.test.ts` 覆盖 `FileLlmConfigStore`，使用临时目录和测试 cipher，避免依赖 Electron：

```ts
test('resolves discovery credentials without a model and reuses the saved key', async () => {
  const store = new FileLlmConfigStore(join(directory, 'llm.json'), {
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  });
  await store.saveProfile({ baseUrl: 'https://api.example.com/v1', model: 'model-a', apiKey: API_KEY });
  await expect(
    store.resolveConnection({ baseUrl: 'https://api.example.com/v1', apiKey: '' }),
  ).resolves.toEqual({ baseUrl: 'https://api.example.com/v1', apiKey: API_KEY });
});
```

在 `tests/unit/ipc.test.ts` 断言 `llm:listModels` 接受 `{ baseUrl, apiKey }`，但 `llm:testModel` 缺少 `model` 仍失败。在 `tests/unit/studio.test.tsx` 断言空模型时 `获取模型` 可用，`保存设置` 和 `测试模型` 禁用，点击获取后可选择 `model-b`。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/llm-config.test.ts tests/unit/llm.test.ts tests/unit/ipc.test.ts tests/unit/studio.test.tsx`

预期：`resolveConnection` 不存在、发现 schema 仍要求 model、页面获取按钮禁用。

- [ ] **步骤 3：实现发现类型、连接解析和页面分离条件**

在 `src/shared/types.ts` 添加：

```ts
export interface LlmDiscoveryInput {
  baseUrl: string;
  model?: string;
  apiKey?: string;
}

export interface LlmConnection {
  baseUrl: string;
  apiKey: string;
  model?: string;
}
```

在 `src/shared/ipc.ts` 为 `llm:listModels` 使用独立 schema：

```ts
const llmDiscoveryInputSchema = z
  .object({
    baseUrl: httpUrlSchema,
    model: nonEmptyString.optional(),
    apiKey: z.string().optional(),
  })
  .strict();
```

在 `FileLlmConfigStore` 增加 `resolveConnection(input: LlmDiscoveryInput)`，它只验证非空 Base URL 并复用密钥；`resolveCredentials` 继续要求完整模型。提取私有 `resolveApiKey(value?: string)` 消除重复。`llm:listModels` 调用 `resolveConnection`，`llm:testModel` 和保存/润色路径保持 `resolveCredentials`。

页面使用：

```ts
const canListModels = baseUrl.trim().length > 0;
const canSave = canListModels && model.trim().length > 0;
```

`listModels()` 只检查 `canListModels`，发现请求不传空 `model`；`testModel()` 和 `save()` 仍检查 `canSave`。保留手动输入与获取后的列表选择。

- [ ] **步骤 4：运行契约和页面测试**

运行：`npx vitest run tests/unit/llm-config.test.ts tests/unit/llm.test.ts tests/unit/ipc.test.ts tests/unit/studio.test.tsx`

运行：`npm run typecheck`

预期：空模型发现通过，完整配置保护不变，全部类型检查通过。

- [ ] **步骤 5：Commit**

```bash
git add src/shared/types.ts src/shared/ipc.ts src/main/llm.ts src/main/llm-config.ts src/main/ipc.ts src/renderer/SettingsPage.tsx tests/unit/llm-config.test.ts tests/unit/llm.test.ts tests/unit/ipc.test.ts tests/unit/studio.test.tsx
git commit -m "Allow model discovery before model selection"
```

### 任务 3：ComfyProcessManager 按需启动

**文件：** 创建 `src/main/comfy-process.ts`、创建 `tests/unit/comfy-process.test.ts`

- [ ] **步骤 1：用 fake client/spawn 写失败测试**

测试接口：`new ComfyProcessManager(options, client).ensureReady()`。`client.health` 可控制成功/失败，`spawnProcess` 记录参数并返回带 `exitCode`、`once`、`unref` 的 fake child。

```ts
test('does not spawn when ComfyUI is already healthy', async () => {
  const health = vi.fn().mockResolvedValue(healthValue);
  const spawnProcess = vi.fn();
  const manager = new ComfyProcessManager(options, { health });
  await expect(manager.ensureReady()).resolves.toBe(healthValue);
  expect(spawnProcess).not.toHaveBeenCalled();
});

test('shares one startup across concurrent callers and retries after failure', async () => {
  const first = manager.ensureReady();
  const second = manager.ensureReady();
  await Promise.all([first, second]);
  expect(spawnProcess).toHaveBeenCalledTimes(1);
});

test('rejects remote startup and reports early process exit with a log tail', async () => {
  await expect(remoteManager.ensureReady()).rejects.toThrow(/remote|本机|local/i);
  await expect(exitingManager.ensureReady()).rejects.toThrow(/startup failed|self check/i);
});
```

补超时、关闭时不 kill child、启动参数 `-I -X utf8 --lowvram --port` 和日志位于指定数据目录的测试。

- [ ] **步骤 2：运行测试确认模块不存在**

运行：`npx vitest run tests/unit/comfy-process.test.ts`

预期：导入 `../../src/main/comfy-process` 失败。

- [ ] **步骤 3：实现进程管理器**

公开契约固定为：

```ts
export const DEFAULT_COMFY_ROOT =
  'G:\\H3Selflift整合包\\ComfyUI_SelfLift_Spark_SM120_CUDA130';

export interface ComfyProcessManagerOptions {
  baseUrl: string;
  rootDirectory?: string;
  pythonPath?: string;
  launchScript?: string;
  logPath: string;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  spawnProcess?: typeof spawn;
}

export class ComfyProcessManager {
  private startPromise: Promise<ComfySystemStats> | null = null;
  private closed = false;

  constructor(
    private readonly options: ComfyProcessManagerOptions,
    private readonly client: Pick<ComfyClient, 'health'>,
  ) {}

  async ensureReady(): Promise<ComfySystemStats> {
    if (this.closed) throw new Error('ComfyProcessManager is closed');
    try {
      return await this.client.health();
    } catch {
      // Only the confirmed offline path reaches startup.
    }
    if (!isLocalComfyUrl(this.options.baseUrl)) {
      throw new Error('ComfyUI automatic startup is only available for a local backend');
    }
    this.startPromise ??= this.startAndWait();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    // Deliberately do not kill the detached backend.
  }
}
```

在模块中定义 URL 判断，避免远程地址触发本机启动：

```ts
function isLocalComfyUrl(value: string): boolean {
  const url = new URL(value);
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
}
```

`startAndWait()` 用 `fs/promises.open(logPath, 'a')` 取得日志 fd，启动参数为 `['-I', '-X', 'utf8', launchScript, '--lowvram', '--port', port]`，`cwd` 为 root，`detached: true`、`windowsHide: true`，随后 `unref()`。轮询期间检查 `closed`、`child.exitCode` 和 spawn `error`，健康成功返回；提前退出/超时通过 `readFile(logPath, 'utf8')` 取最后 2000 字符形成错误。`finally` 关闭父进程日志句柄，不杀 child。

默认 Python 和入口分别为 root 下的 `python_embeded/python.exe` 与 `tools/launch.py`。`SMO_COMFYUI_ROOT` 只覆盖 root，默认超时 180000 ms、轮询 2000 ms。localhost 判断只接受 `127.0.0.1`、`localhost` 和 `[::1]`。

- [ ] **步骤 4：运行进程测试**

运行：`npx vitest run tests/unit/comfy-process.test.ts`

预期：健康直连、并发去重、失败重试、远程拒绝、退出/超时、参数和关闭语义全部通过。

- [ ] **步骤 5：Commit**

```bash
git add src/main/comfy-process.ts tests/unit/comfy-process.test.ts
git commit -m "Add on-demand ComfyUI process management"
```

### 任务 4：IPC、设置页和生成前检查

**文件：** `src/shared/ipc.ts`、`src/main/app-services.ts`、`src/main/ipc.ts`、`src/preload/index.ts`、`src/main/generation.ts`、`src/renderer/SettingsPage.tsx`、`tests/unit/ipc.test.ts`、`tests/unit/generation.test.ts`、`tests/unit/studio.test.tsx`、`tests/unit/async-effects.test.tsx`、`tests/e2e/startup.spec.ts`、`tests/e2e/studio.spec.ts`

- [ ] **步骤 1：写失败集成测试**

生成测试在 `createGenerationHandler` 注入：

```ts
const ensureReady = vi.fn().mockRejectedValue(new Error('backend unavailable'));
const { store, comfy, startGeneration, textRequest } = await createHarness({ ensureReady });
const result = await startGeneration(textRequest);
await waitForWork(store, result.id, 'failed');
expect(ensureReady).toHaveBeenCalledTimes(1);
expect(comfy.uploads).toHaveLength(0);
expect(comfy.submissions).toHaveLength(0);
```

同时扩展 `createHarness` 的 `options`：增加 `ensureReady?: () => Promise<unknown>` 并原样传给 `createGenerationHandler`，使该测试使用现有 Store、FakeComfyClient 和队列。

设置页测试：健康失败后显示 `启动 ComfyUI`，点击时按钮显示 `正在启动…`，`comfy.start` 成功后显示 `ComfyUI 连接正常`；失败显示错误且不重复 spawn。卸载后 resolve 不更新 state。

IPC/启动测试增加 `comfy:start`，并断言 `comfy` API 包含 `health`、`start`、`open`。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/generation.test.ts tests/unit/ipc.test.ts tests/unit/studio.test.tsx tests/unit/async-effects.test.tsx`

预期：`ensureReady` 不是合法 option、`comfy.start` 不存在、设置页没有启动按钮。

- [ ] **步骤 3：实现受控集成**

在 `GenerationHandlerOptions` 添加 `ensureReady?: () => Promise<unknown>`，并在 `run()` 内第一次上传前执行：

```ts
throwIfCancelled();
await options.ensureReady?.();
throwIfCancelled();
const image = await comfy.uploadFile({ filePath: avatar.photoPath, kind: 'image' });
```

保留队列和现有 catch：启动失败时 work 变为 failed，不上传或提交 prompt。

在 `createAppServices` 中用 `SMO_COMFYUI_ROOT ?? DEFAULT_COMFY_ROOT` 和 `join(dataDirectory, 'logs', 'comfyui-backend.log')` 创建管理器，暴露：

```ts
const startComfy = async (): Promise<ComfySystemStats> => comfyProcess.ensureReady();
```

`IpcServices`、`AppServices` 和 preload 增加 `comfy.start`，`comfy:open` 保持原行为。`AppServices.close()` 先等待 `jobCoordinator.close()`，再调用 `comfyProcess.close()`，随后关闭 ComfyClient 和 Store；不杀后端。

设置页使用 mounted  guard 和 `startingComfy` 状态实现启动按钮，成功更新 health，失败更新 healthError。

- [ ] **步骤 4：运行集成和 Electron 测试**

运行：`npx vitest run tests/unit/generation.test.ts tests/unit/ipc.test.ts tests/unit/studio.test.tsx tests/unit/async-effects.test.tsx`

运行：`npm run test:e2e`

预期：全部通过，普通 mock 后端不会被重复启动，启动/错误状态可访问。

- [ ] **步骤 5：Commit**

```bash
git add src/shared/ipc.ts src/main/app-services.ts src/main/ipc.ts src/preload/index.ts src/main/generation.ts src/renderer/SettingsPage.tsx tests/unit/ipc.test.ts tests/unit/generation.test.ts tests/unit/studio.test.tsx tests/unit/async-effects.test.tsx tests/e2e/startup.spec.ts tests/e2e/studio.spec.ts
git commit -m "Wire ComfyUI startup into settings and generation"
```

### 任务 5：真实后端验收、0.1.1 打包与 PR 更新

**文件：** 创建 `tests/e2e/real-comfy.spec.ts`、创建 `playwright.real.config.ts`、修改 `package.json`、`package-lock.json`

- [ ] **步骤 1：写真实后端验收脚本**

`real-comfy.spec.ts` 只在 `SMO_REAL_H3=1` 时运行，启动 `dist/main/index.js`，隔离 `SMO_DATA_DIRECTORY`、`SMO_OUTPUT_DIRECTORY` 和 `user-data-dir`，不启动 mock Comfy。页面进入设置，点击 `启动 ComfyUI`，断言：

```ts
await expect(page.getByText('ComfyUI 连接正常')).toBeVisible({ timeout: 240_000 });
const stats = await page.evaluate(() => window.smo.comfy.health());
expect(stats.devices.some((device) => String(device.name).includes('5080'))).toBe(true);
```

测试再直接请求 `http://127.0.0.1:8188/object_info`，断言所需 5 个节点存在。关闭 Electron 但不停止后端。`playwright.real.config.ts` 使用 `testMatch: /real-comfy\.spec\.ts/`，普通与 package 配置通过 `testIgnore` 排除真实测试。

- [ ] **步骤 2：执行真实后端验收**

运行：`npm run build`

运行：`$env:SMO_REAL_H3='1'; npx playwright test --config playwright.real.config.ts`

预期：任务 1-4 已完成各自红绿测试，本步骤不再回退生产代码。真实 SelfLift 启动成功，`system_stats` 和 `object_info` 均可用；若此前已有健康实例，测试记录为直接复用而非重复启动。不得提交真实生成任务。

- [ ] **步骤 3：执行完整自动验证并升级版本**

运行：`npm test`

运行：`npm run typecheck`

运行：`npm run test:e2e`

运行：`npm version 0.1.1 --no-git-tag-version`

预期：全部测试通过，`package.json` 与 lock 根版本均为 `0.1.1`，没有 Git tag。

- [ ] **步骤 4：重建并验证 0.1.1 portable**

运行：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run assets
npm run pack
npm run test:e2e:package
```

预期：生成 `release/SMO.H3-Studio-0.1.1.exe`，6 条 package 测试通过，真实 portable 资源完整，没有真实密钥或本地数据库。

- [ ] **步骤 5：规格/质量审查后提交并推送**

完成独立规格审查和代码质量审查，修复全部 Critical/Important 后运行 `git diff --check`。

```bash
git add tests/e2e/real-comfy.spec.ts playwright.real.config.ts playwright.config.ts playwright.package.config.ts package.json package-lock.json
git commit -m "Release SMO.H3 Studio 0.1.1 usability and backend fixes"
git push origin codex/smo-h3-studio
```

将 `release/SMO.H3-Studio-0.1.1.exe` 复制到 `G:\SMO-H3-Studio\release\SMO.H3-Studio-0.1.1.exe`，运行 `scripts/create-shortcut.ps1 -ReleaseDirectory 'G:\SMO-H3-Studio\release'`，读回快捷方式确认它指向 0.1.1。核对源文件和交付文件的 SHA256 一致。

## 计划自检

- 规格中的照片预览/移除、模型发现、ComfyUI 启动与生成前检查分别对应任务 1、2、3/4；真实后端验收对应任务 5。
- `resolveConnection` 只用于发现，`resolveCredentials` 仍保护保存、测试和润色。
- `ensureReady()` 在队列 `run()` 内、第一次上传前执行，启动失败由现有 catch 落为 failed，不会上传或提交。
- 真实后端不终止、不重复启动，不修改 H3 启动脚本，不执行真实视频生成。
- 没有待补类型、占位步骤或依赖未来任务的未定义接口。
